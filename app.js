// ====== CONFIG ======
const API_BASE = "https://mlmotiv.app.n8n.cloud/webhook"; // <-- твой n8n base
const EP = {
  tests: "tg-tests",
  start: "tg-start",
  submit: "tg-submit",
  results: "tg-results",
};

// ====== LOCAL STORAGE (resume progress) ======
const LS_PREFIX = "mlab_quiz_";

function lsKeyActive(testId) {
  return `${LS_PREFIX}active_${String(testId || "").trim()}`;
}
function lsKeyProgress(sessionToken) {
  return `${LS_PREFIX}progress_${String(sessionToken || "").trim()}`;
}
function lsKeyMeta(sessionToken) {
  return `${LS_PREFIX}meta_${String(sessionToken || "").trim()}`;
}

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function getActiveToken(testId) {
  const v = localStorage.getItem(lsKeyActive(testId));
  return v && v.trim() ? v.trim() : null;
}
function setActiveToken(testId, token) {
  if (!testId || !token) return;
  localStorage.setItem(lsKeyActive(testId), String(token));
}
function clearActiveToken(testId) {
  removeKey(lsKeyActive(testId));
}

function loadProgress(sessionToken) {
  return loadJSON(lsKeyProgress(sessionToken));
}
function saveProgress(sessionToken, progress) {
  saveJSON(lsKeyProgress(sessionToken), progress);
}
function clearProgress(sessionToken) {
  removeKey(lsKeyProgress(sessionToken));
  removeKey(lsKeyMeta(sessionToken));
}

// ====== STATE ======
const state = {
  user: null,
  tests: [],
  resultsRaw: [],
  testStats: {},

  session: null,
  qIndex: 0,
  answers: {},

  timerId: null,
  autoSubmitted: false,

  skewMs: 0,
  expiresLocal: null,
};

function tg() {
  return window.Telegram?.WebApp || null;
}
function el(id) {
  return document.getElementById(id);
}
function setStatus(msg) {
  const s = el("status");
  if (s) s.textContent = msg || "";
}

// ====== HELPERS ======
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => {
    return (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[m] || m
    );
  });
}
function normId(x) {
  return String(x ?? "").trim();
}
function toInt(x, def = 0) {
  const n = Number(String(x ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
function fmtDurationSecToMin(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} мин ${s} сек`;
}
function fmtDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
  state.autoSubmitted = false;
}

// ====== API ======
async function api(path, data = {}) {
  const webapp = tg();
  if (!webapp) throw new Error("Откройте Mini App внутри Telegram.");

  const payload = { ...data, initData: webapp.initData };

  const res = await fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
    if (typeof json === "string") {
      try {
        json = JSON.parse(json);
      } catch {}
    }
  } catch {
    throw new Error("Сервер вернул не-JSON: " + text);
  }

  if (typeof json === "string") {
    throw new Error("Сервер вернул JSON-строку (проверь Respond node в n8n).");
  }

  return json;
}

async function apiRetry(path, data = {}, opts = {}) {
  const retries = Math.max(0, toInt(opts.retries, 2));
  const baseDelay = Math.max(50, toInt(opts.baseDelayMs, 250));

  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await api(path, data);
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      const delay = baseDelay * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error("API error");
}

// ====== UI ======
function renderLoading(title = "Загрузка...") {
  el("main").innerHTML = `<div class="card"><div>${escapeHtml(title)}</div></div>`;
}
function renderError(err) {
  stopTimer();
  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Ошибка</div>
      <div class="muted">${escapeHtml(String(err?.message || err || "unknown"))}</div>
      <div style="margin-top:12px;">
        <button class="btn secondary" id="btnBack">Назад</button>
      </div>
    </div>`;
  el("btnBack").onclick = () => loadTests();
}
function setActiveTab(tab) {
  el("tabTests").classList.toggle("active", tab === "tests");
  el("tabResults").classList.toggle("active", tab === "results");
}

// ====== build stats (server-like) ======
// ВАЖНО: считаем попытки так же, как сервер (tg-start):
// attempts_used = число уникальных попыток (по session_token, а если его нет — по start_ms)
function buildTestStats(tests, resultsRaw, userTelegramId) {
  const now = Date.now();
  const stats = {};

  // init keys from tests
  for (const t of tests || []) {
    const tid = normId(t.test_id);
    if (!tid) continue;
    stats[tid] = {
      used: 0,
      activeToken: null,
      finalized: new Set(),
      started: new Map(),

      // две метрики, берём max (чтобы пережить дубликаты attempt_no или отсутствие session_token)
      usedTokens: new Set(), // session_token / start_ms key
      usedAttemptNos: new Set(), // attempt_no
    };
  }

  for (const r of resultsRaw || []) {
    const tid = normId(r.test_id);
    if (!tid) continue;

    // если теста нет в списке (на всякий случай) — добавим
    if (!stats[tid]) {
      stats[tid] = {
        used: 0,
        activeToken: null,
        finalized: new Set(),
        started: new Map(),
        usedTokens: new Set(),
        usedAttemptNos: new Set(),
      };
    }

    // filter by user if provided
    if (userTelegramId) {
      const rid = normId(r.telegram_id);
      // иногда Sheets возвращает число как "123.0" — нормализуем грубо
      const uid = normId(userTelegramId).replace(/\.0$/, "");
      const rid2 = rid.replace(/\.0$/, "");
      if (rid2 && rid2 !== uid) continue;
    }

    const st = String(r.status || "").trim().toLowerCase();
    if (!["started", "submitted", "timeout"].includes(st)) continue;

    const startMs = toInt(r.start_ms, 0);
    const expiresMs = toInt(r.expires_ms, 0);

    const tokenKey = normId(r.session_token) || (startMs ? `start:${String(startMs)}` : "");
    const attemptNo = toInt(r.attempt_no, 0);

    if (tokenKey) stats[tid].usedTokens.add(tokenKey);
    if (attemptNo > 0) stats[tid].usedAttemptNos.add(String(attemptNo));

    if (st === "submitted" || st === "timeout") {
      if (tokenKey) stats[tid].finalized.add(tokenKey);
    }

    if (st === "started") {
      if (tokenKey) {
        const rec = stats[tid].started.get(tokenKey) || { startMs: 0, expiresMs: 0 };
        rec.startMs = Math.max(rec.startMs, startMs);
        rec.expiresMs = Math.max(rec.expiresMs, expiresMs);
        stats[tid].started.set(tokenKey, rec);
      }
    }
  }

  for (const tid of Object.keys(stats)) {
    const usedByTokens = stats[tid].usedTokens.size;
    const usedByAttemptNo = stats[tid].usedAttemptNos.size;

    stats[tid].used = Math.max(usedByTokens, usedByAttemptNo);

    // detect active started attempt
    let bestToken = null;
    let bestStart = 0;

    for (const [token, rec] of stats[tid].started.entries()) {
      if (stats[tid].finalized.has(token)) continue;

      // если expires есть — и истекло, не активно
      if (rec.expiresMs && rec.expiresMs <= now) continue;

      if (!bestToken || rec.startMs > bestStart) {
        bestToken = token;
        bestStart = rec.startMs;
      }
    }

    stats[tid].activeToken = bestToken;
  }

  return stats;
}

function renderTests() {
  const tests = state.tests || [];
  const stats = state.testStats || {};

  const items = tests
    .map((t) => {
      const tid = normId(t.test_id);
      const maxAtt = Math.max(1, toInt(t.max_attempts, 1));

      const st = stats[tid] || {
        used: 0,
        activeToken: null,
        finalized: new Set(),
      };

      // used attempts (clamped)
      let used = Math.max(0, toInt(st.used, 0));
      used = Math.min(maxAtt, used);

      // local progress
      const localToken = getActiveToken(tid);
      let localValid = false;

      if (localToken) {
        const prog = loadProgress(localToken);
        if (prog && typeof prog === "object") localValid = true;

        // если сервер говорит, что токен уже submitted/timeout — чистим localStorage
        if (st.finalized && st.finalized.has(localToken)) {
          clearProgress(localToken);
          clearActiveToken(tid);
          localValid = false;
        }
      }

      const hasActive = !!st.activeToken || localValid;

      // ВАЖНО: если попытки кончились и активной попытки нет — кнопки НЕ должно быть
      const attemptsLeft = maxAtt - used;
      const canStartNew = attemptsLeft > 0;

      const showButton = hasActive || canStartNew;
      const btnLabel = hasActive ? "Продолжить" : "Начать";

      const timeText = t.time_limit_sec
        ? `${Math.round(Number(t.time_limit_sec) / 60)} мин`
        : "без лимита";

      return `
        <div class="card">
          <div style="font-weight:700">${escapeHtml(t.title || "")}</div>
          <div class="muted" style="margin-top:6px;">
            Время: ${escapeHtml(timeText)} · Попыток: ${used}/${maxAtt}
          </div>

          ${
            showButton
              ? `<div style="margin-top:12px;">
                   <button class="btn" data-test="${escapeHtml(tid)}">${escapeHtml(btnLabel)}</button>
                 </div>`
              : `<div class="muted" style="margin-top:12px;">Попытки закончились</div>`
          }
        </div>
      `;
    })
    .join("");

  el("main").innerHTML = items || `<div class="card">Нет тестов</div>`;

  document.querySelectorAll("button[data-test]").forEach((btn) => {
    btn.onclick = () => startTest(btn.getAttribute("data-test"));
  });
}

function getSelected(qid) {
  const arr = state.answers[qid];
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => normId(x)).filter(Boolean);
}

function saveCurrentProgress() {
  const s = state.session;
  if (!s?.session_token || !s?.test?.test_id) return;

  const token = normId(s.session_token);
  const testId = normId(s.test.test_id);

  saveProgress(token, {
    qIndex: state.qIndex,
    answers: state.answers,
    saved_at: Date.now(),
  });

  setActiveToken(testId, token);

  saveJSON(lsKeyMeta(token), {
    test_id: testId,
    start_ms: s.start_ms,
    expires_ms: s.expires_ms,
    skew_ms: state.skewMs,
    saved_at: Date.now(),
  });
}

function clearSessionLocal(session) {
  if (!session?.session_token || !session?.test?.test_id) return;
  const token = normId(session.session_token);
  const testId = normId(session.test.test_id);

  clearProgress(token);

  const cur = getActiveToken(testId);
  if (cur && cur === token) clearActiveToken(testId);
}

function updateActionButtons() {
  const s = state.session;
  if (!s?.questions?.length) return;

  const q = s.questions[state.qIndex];
  const qid = normId(q.question_id);
  const selected = getSelected(qid);
  const hasSelection = selected.length > 0;

  const btnNext = document.getElementById("btnNext");
  if (btnNext) btnNext.disabled = !hasSelection;

  const btnSubmit = document.getElementById("btnSubmit");
  if (btnSubmit) btnSubmit.disabled = !hasSelection;
}

function syncAnswerFromDom(qid, multi) {
  const inputs = Array.from(document.querySelectorAll(`input[data-q="${CSS.escape(qid)}"]`));
  const checked = inputs.filter((i) => i.checked).map((i) => normId(i.value)).filter(Boolean);

  state.answers[qid] = multi ? Array.from(new Set(checked)) : (checked[0] ? [checked[0]] : []);
}

function renderQuestion() {
  const s = state.session;
  if (!s?.questions?.length) return renderError("Нет вопросов");

  const q = s.questions[state.qIndex];
  const isLast = state.qIndex === s.questions.length - 1;

  const qid = normId(q.question_id);
  const selected = getSelected(qid);
  const hasSelection = selected.length > 0;

  const inputType = q.multi ? "checkbox" : "radio";
  const groupName = `q_${qid}`;

  const answersHtml = (q.answers || [])
    .map((a) => {
      const aid = normId(a.answer_id);
      const atext = String(a.answer_text || "");
      const checked = q.multi ? selected.includes(aid) : selected[0] === aid;

      return `
        <label>
          <input
            type="${inputType}"
            ${q.multi ? `data-q="${escapeHtml(qid)}"` : `name="${escapeHtml(groupName)}" data-q="${escapeHtml(qid)}"`}
            value="${escapeHtml(aid)}"
            ${checked ? "checked" : ""}
          />
          ${escapeHtml(atext)}
        </label>
      `;
    })
    .join("");

  const progress = `${state.qIndex + 1} / ${s.questions.length}`;
  const qText = String(q.question_text || "");
  const imgUrl = String(q.image_url || "").trim();

  el("main").innerHTML = `
    <div class="card">
      <div class="row">
        <div class="muted">Вопрос ${escapeHtml(progress)}</div>
        <div class="timer" id="timer">${
          s.expires_ms && state.expiresLocal ? fmtTime(state.expiresLocal - Date.now()) : "∞"
        }</div>
      </div>

      <div style="font-weight:700; margin-top:10px; white-space: pre-wrap;">${escapeHtml(qText)}</div>

      ${
        imgUrl
          ? `
            <div class="q-media" style="margin-top:12px;">
              <img id="qImg" class="q-img" src="${escapeHtml(imgUrl)}" alt="Изображение к вопросу" loading="lazy" />
            </div>
            <div class="muted" id="qImgErr" style="margin-top:6px; display:none;">Не удалось загрузить изображение</div>
          `
          : ""
      }

      <div class="muted" style="margin-top:10px;">Баллы за вопрос: ${Number(q.points || 0)}</div>

      <div class="answers" style="margin-top:10px;">${answersHtml}</div>

      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnPrev" ${state.qIndex === 0 ? "disabled" : ""}>Назад</button>
        ${
          !isLast
            ? `<button class="btn secondary" id="btnNext" ${hasSelection ? "" : "disabled"}>Далее</button>`
            : ""
        }
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="muted">
          Попытка: ${Number(s.attempt_no || 1)}/${Number(s.test?.max_attempts || 1)} · Осталось: ${Number(
            s.remaining_attempts || 0
          )}
        </div>
        ${
          isLast
            ? `<button class="btn" id="btnSubmit" ${hasSelection ? "" : "disabled"}>Отправить</button>`
            : ""
        }
      </div>
    </div>
  `;

  // image error handler
  const img = document.getElementById("qImg");
  if (img) {
    img.onerror = () => {
      const err = document.getElementById("qImgErr");
      if (err) err.style.display = "block";
      img.style.display = "none";
    };
  }

  // inputs: НЕ перерисовываем вопрос при выборе — чтобы img не грузился заново
  document.querySelectorAll(`input[data-q="${CSS.escape(qid)}"]`).forEach((inp) => {
    inp.onchange = () => {
      syncAnswerFromDom(qid, !!q.multi);
      saveCurrentProgress();
      updateActionButtons();
    };
  });

  // nav
  el("btnPrev").onclick = () => {
    state.qIndex = Math.max(0, state.qIndex - 1);
    saveCurrentProgress();
    renderQuestion();
  };

  const btnNext = document.getElementById("btnNext");
  if (btnNext) {
    btnNext.onclick = () => {
      state.qIndex = Math.min(s.questions.length - 1, state.qIndex + 1);
      saveCurrentProgress();
      renderQuestion();
    };
  }

  const btnSubmit = document.getElementById("btnSubmit");
  if (btnSubmit) {
    btnSubmit.onclick = () => submitCurrent(false);
  }
}

// ====== TIMER ======
function startTimer() {
  stopTimer();
  state.autoSubmitted = false;

  if (!state.session?.expires_ms || !state.expiresLocal) return;

  state.timerId = setInterval(() => {
    const tEl = document.getElementById("timer");
    if (!tEl) return;

    const remain = state.expiresLocal - Date.now();
    tEl.textContent = fmtTime(remain);

    if (remain <= 0 && !state.autoSubmitted) {
      state.autoSubmitted = true;
      stopTimer();
      submitCurrent(true).catch(() => {});
    }
  }, 250);
}

// ====== ACTIONS ======
async function loadTests() {
  try {
    stopTimer();
    setStatus("");
    renderLoading("Загрузка тестов...");

    // 1) тесты
    const testsRes = await apiRetry(EP.tests, {}, { retries: 1, baseDelayMs: 200 });
    if (!testsRes?.ok) {
      throw new Error(testsRes?.error || "Не удалось загрузить тесты");
    }

    state.user = testsRes.user;
    state.tests = testsRes.tests || [];

    // 2) результаты (ВАЖНО: без этого нельзя корректно рисовать попытки и кнопку)
    // делаем ретраи, чтобы не было состояния "0/2 но сервер говорит попытки закончились"
    const resultsRes = await apiRetry(EP.results, {}, { retries: 2, baseDelayMs: 250 });
    if (!resultsRes?.ok) {
      throw new Error(resultsRes?.error || "Не удалось загрузить результаты для подсчёта попыток");
    }
    state.resultsRaw = resultsRes.results || [];

    state.testStats = buildTestStats(state.tests, state.resultsRaw, state.user?.telegram_id);

    el("userBadge").textContent = state.user?.full_name ? `${state.user.full_name}` : "";

    renderTests();
    setActiveTab("tests");
  } catch (e) {
    renderError(e);
  }
}

async function startTest(testId) {
  try {
    stopTimer();
    setStatus("");
    renderLoading("Старт теста...");

    const r = await api(EP.start, { testId });

    if (!r?.ok) {
      const msg = String(r?.error || "Не удалось стартовать тест");

      // Мягко обрабатываем "Попытки закончились":
      // - не показываем красную ошибку
      // - просто обновляем список тестов, чтобы кнопка исчезла и стало 2/2
      if (/попытки\s+закончились/i.test(msg)) {
        setStatus("Попытки закончились");
        await loadTests();
        return;
      }

      throw new Error(msg);
    }

    state.session = r;

    const token = normId(r.session_token);
    const tid = normId(r.test?.test_id || testId);

    // если был другой activeToken — чистим его прогресс (чтобы не путать)
    const prevToken = getActiveToken(tid);
    if (prevToken && prevToken !== token) {
      clearProgress(prevToken);
    }

    const meta = loadJSON(lsKeyMeta(token));
    if (meta && Number.isFinite(meta.skew_ms)) {
      state.skewMs = Number(meta.skew_ms);
    } else if (!r.resume) {
      state.skewMs = Date.now() - Number(r.start_ms || Date.now());
      saveJSON(lsKeyMeta(token), {
        test_id: tid,
        start_ms: r.start_ms,
        expires_ms: r.expires_ms,
        skew_ms: state.skewMs,
        saved_at: Date.now(),
      });
    } else {
      state.skewMs = 0;
    }

    state.expiresLocal = r.expires_ms ? Number(r.expires_ms) + state.skewMs : null;

    state.qIndex = 0;
    state.answers = {};

    if (r.resume && token) {
      const saved = loadProgress(token);
      if (saved && typeof saved === "object") {
        state.qIndex = clamp(Number(saved.qIndex || 0), 0, (r.questions?.length || 1) - 1);
        state.answers = saved.answers && typeof saved.answers === "object" ? saved.answers : {};
      }
    }

    setActiveToken(tid, token);
    saveCurrentProgress();

    renderQuestion();
    startTimer();
  } catch (e) {
    renderError(e);
  }
}

async function submitCurrent(auto = false) {
  try {
    if (!state.session) return;

    const s = state.session;

    stopTimer();

    // УБРАЛИ setStatus — чтобы не было дубля
    renderLoading(
      auto
        ? "Время истекло — отправляем ответы..."
        : "Ответы отправляются..."
    );

    const r = await api(EP.submit, {
      testId: s.test.test_id,
      start_ms: s.start_ms,
      session_token: s.session_token,
      answers: state.answers,
    });

    if (!r.ok) throw new Error(r.error || "Не удалось отправить ответы");

    clearSessionLocal(s);

    renderSubmitResult(r);
  } catch (e) {
    renderError(e);
  }
}

function renderSubmitResult(r) {
  stopTimer();

  const durationText = fmtDurationSecToMin(r.duration_sec);
  const extra = r.expired ? " (время истекло)" : "";

  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; font-size:16px;">Результат</div>
      <div style="margin-top:10px;">
        Баллы: <b>${Number(r.score || 0)}</b> / ${Number(r.max_score || 0)} (${Number(r.percent || 0)}%)
      </div>
      <div class="muted" style="margin-top:6px;">
        Длительность: ${escapeHtml(durationText)} · Попытка: ${Number(r.attempt_no || 1)}${escapeHtml(extra)}
      </div>
      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnToTests">К тестам</button>
        <button class="btn" id="btnToResults">Мои результаты</button>
      </div>
    </div>
  `;
  el("btnToTests").onclick = () => loadTests();
  el("btnToResults").onclick = () => loadResults();
}

async function loadResults() {
  try {
    stopTimer();
    setStatus("");
    renderLoading("Загрузка результатов...");

    const r = await apiRetry(EP.results, {}, { retries: 2, baseDelayMs: 250 });
    if (!r?.ok) throw new Error(r?.error || "Не удалось загрузить результаты");

    renderResultsList(r.results || []);
    setActiveTab("results");
  } catch (e) {
    renderError(e);
  }
}

function renderResultsList(results) {
  const clean = (results || []).filter((r) => {
    const st = String(r.status || "").trim().toLowerCase();
    return st === "submitted" || st === "timeout";
  });

  if (!clean.length) {
    el("main").innerHTML = `<div class="card">Результатов пока нет.</div>`;
    return;
  }

  const rows = clean
    .map((r) => {
      const dt = fmtDate(r.submit_ms);
      return `
        <tr>
          <td style="text-align:left;">${escapeHtml(r.test_title || r.test_id || "")}</td>
          <td style="text-align:center;">${Number(r.attempt_no || 0)}</td>
          <td style="text-align:center;">${Number(r.score || 0)}/${Number(r.max_score || 0)} (${Number(r.percent || 0)}%)</td>
          <td style="text-align:center;">${escapeHtml(dt)}</td>
        </tr>
      `;
    })
    .join("");

  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Мои результаты</div>
      <table>
        <thead>
          <tr>
            <th style="text-align:left;">Тест</th>
            <th style="text-align:center;">#</th>
            <th style="text-align:center;">Баллы</th>
            <th style="text-align:center;">Дата</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ====== INIT ======
(function init() {
  const webapp = tg();
  if (webapp) {
    webapp.ready();
    webapp.expand();
  }

  el("tabTests").onclick = () => loadTests();
  el("tabResults").onclick = () => loadResults();

  loadTests();
})();
