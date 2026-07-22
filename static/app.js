/**
 * Nook — frontend chat controller
 *
 * Responsibilities:
 *  - Start / restart sessions (calls /api/reset before /api/start)
 *  - Send messages, show typing indicator and skeleton bubble on cold start
 *  - Render error messages in-chat AND in the top error banner
 *  - Stage-aware Retry: only replays lastMessage if the current stage
 *    matches the stage at the time of the failure
 *  - Update the sidebar stage tracker and intake progress bar
 *    (bar shown immediately on session start, before the first API response)
 *  - Copy-to-clipboard on the final output — copies raw text only,
 *    the button label is kept in a separate DOM node so it is never
 *    included in the clipboard content
 */

/* ── DOM refs ─────────────────────────────────────────────────────────── */
const chatLog     = document.getElementById("chat-log");
const chatForm    = document.getElementById("chat-form");
const chatInput   = document.getElementById("chat-input");
const btnSend     = document.getElementById("btn-send");
const btnNew      = document.getElementById("btn-new");
const typing      = document.getElementById("typing");
const intakeBar   = document.getElementById("intake-bar");
const intakeFill  = document.getElementById("intake-fill");
const intakeLabel = document.getElementById("intake-label");
const errorBanner = document.getElementById("error-banner");
const errorText   = document.getElementById("error-text");
const btnRetry    = document.getElementById("btn-retry");
const btnDismiss  = document.getElementById("btn-dismiss-error");

/* ── State ────────────────────────────────────────────────────────────── */
let sessionId       = null;
let isLoading       = false;
let lastMessage     = "";    // text of last sent message
let lastMessageStage = null; // stage the session was in when lastMessage was sent

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Append a plain text message bubble to the chat log.
 * @param {string} text
 * @param {"bot"|"user"|"error"|"output"} type
 * @returns {HTMLElement}
 */
function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

/**
 * Show a skeleton (ghost) bubble — used on cold start while waiting for
 * the first server response.
 * @returns {HTMLElement} — call removeSkeleton(el) to remove it
 */
function addSkeletonBubble() {
  const div = document.createElement("div");
  div.className = "msg bot skeleton";
  div.setAttribute("aria-hidden", "true");
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function removeSkeleton(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** Lock / unlock the input area while a request is in-flight. */
function setLoading(active) {
  isLoading = active;
  chatInput.disabled = active;
  btnSend.disabled   = active;
  typing.classList.toggle("hidden", !active);
  if (!active) chatInput.focus();
}

/**
 * Show the error banner.
 * @param {string}  message
 * @param {boolean} retryable — show Retry button only when true
 */
function showErrorBanner(message, retryable = false) {
  errorText.textContent = message;
  btnRetry.classList.toggle("hidden", !retryable);
  errorBanner.classList.remove("hidden");
}

function hideErrorBanner() {
  errorBanner.classList.add("hidden");
}

/* ── Stage tracker ────────────────────────────────────────────────────── */

const STAGE_ORDER = ["INTAKE", "IDEATION_CHOICE", "REFINEMENT", "DONE"];
const STEP_IDS    = {
  INTAKE:          "step-intake",
  IDEATION_CHOICE: "step-ideation",
  REFINEMENT:      "step-refinement",
  DONE:            "step-done",
};

function updateStageTracker(currentStage) {
  const currentIdx = STAGE_ORDER.indexOf(currentStage);
  STAGE_ORDER.forEach((stage, idx) => {
    const el = document.getElementById(STEP_IDS[stage]);
    if (!el) return;
    el.classList.remove("active", "done");
    if (idx === currentIdx)      el.classList.add("active");
    else if (idx < currentIdx)   el.classList.add("done");
  });
}

/* ── Intake progress bar ──────────────────────────────────────────────── */

/**
 * Update the intake progress bar.
 * Pass null to hide it; pass { current, total } to show and fill it.
 */
function updateIntakeBar(progress) {
  if (!progress) {
    intakeBar.classList.add("hidden");
    return;
  }
  intakeBar.classList.remove("hidden");
  const pct = Math.round((progress.current / progress.total) * 100);
  intakeFill.style.width = `${pct}%`;
  intakeLabel.textContent = `Question ${progress.current} of ${progress.total}`;
}

/** Show the intake bar immediately at 0 % (called before the first API response). */
function showIntakeBarEmpty() {
  intakeFill.style.width = "0%";
  intakeLabel.textContent = `Question 1 of ${STAGE_ORDER.length + 1}`;
  intakeBar.classList.remove("hidden");
}

/* ── Copy button ──────────────────────────────────────────────────────── */

/**
 * Append a copy-to-clipboard button to an output bubble.
 * The button is a sibling of the text node — NOT appended inside it —
 * so copying the text node never picks up the button's label text.
 *
 * @param {HTMLElement} bubbleEl  - the .msg.output element
 * @param {string}      rawText   - the exact text to put on the clipboard
 */
function addCopyButton(bubbleEl, rawText) {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.textContent = "Copy to clipboard";
  btn.setAttribute("aria-label", "Copy output to clipboard");

  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(rawText)
      .then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "Copy to clipboard";
          btn.classList.remove("copied");
        }, 2000);
      })
      .catch(() => {
        btn.textContent = "Copy failed — select and copy manually";
      });
  });

  // Insert after the bubble so it lives outside the text content
  bubbleEl.insertAdjacentElement("afterend", btn);
}

/* ── API calls ────────────────────────────────────────────────────────── */

/**
 * POST to an endpoint and return the parsed JSON.
 * Throws an Error (with .retryable) on network failure or non-2xx status.
 */
async function apiFetch(endpoint, body) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`Server returned non-JSON response (HTTP ${resp.status}).`);
  }

  if (!resp.ok) {
    const msg = data?.reply || `Server error (HTTP ${resp.status}).`;
    const err = new Error(msg);
    err.retryable = data?.retryable ?? false;
    throw err;
  }

  return data;
}

/* ── Session management ───────────────────────────────────────────────── */

/**
 * Start a completely fresh session.
 * Calls /api/reset to delete any existing server-side session first so
 * the old SQLite row is cleaned up immediately rather than waiting for TTL eviction.
 */
async function startSession() {
  hideErrorBanner();

  // Reset old session on the server before creating a new one
  if (sessionId) {
    try { await apiFetch("/api/reset", { session_id: sessionId }); }
    catch { /* best-effort — ignore errors */ }
  }

  chatLog.innerHTML = "";
  sessionId         = null;
  lastMessage       = "";
  lastMessageStage  = null;
  updateStageTracker("INTAKE");

  // ── Show intake bar and skeleton BEFORE the first network response ──
  showIntakeBarEmpty();
  const skeleton = addSkeletonBubble();
  setLoading(true);

  try {
    const data = await apiFetch("/api/start", {});
    sessionId = data.session_id;
    removeSkeleton(skeleton);
    processResponse(data);
  } catch (err) {
    removeSkeleton(skeleton);
    setLoading(false);
    showErrorBanner(err.message || "Failed to start session. Please refresh.", false);
    addMessage("⚠ Couldn't connect to the server. Please refresh the page.", "error");
  }
}

/* ── Message handling ─────────────────────────────────────────────────── */

/** Send `text` to /api/message and handle the response. */
async function sendMessage(text) {
  if (!text || isLoading || !sessionId) return;

  // Record the message and the current stage BEFORE the request so the
  // Retry button knows whether the stage has changed by the time the user
  // clicks it.
  lastMessage      = text;
  lastMessageStage = _currentStage();

  hideErrorBanner();
  addMessage(text, "user");
  chatInput.value = "";
  setLoading(true);

  try {
    const data = await apiFetch("/api/message", { session_id: sessionId, message: text });
    processResponse(data);
  } catch (err) {
    setLoading(false);
    const retryable = err.retryable ?? false;
    const hint = retryable ? " You can retry using the button above." : "";
    addMessage(`⚠ ${err.message}${hint}`, "error");
    showErrorBanner(err.message, retryable);
  }
}

/** Read the active stage from the sidebar tracker (avoids maintaining a separate var). */
function _currentStage() {
  for (const stage of STAGE_ORDER) {
    const el = document.getElementById(STEP_IDS[stage]);
    if (el && el.classList.contains("active")) return stage;
  }
  return null;
}

/**
 * Handle a successful API response:
 *  - Render the bot reply
 *  - Update progress indicators
 *  - Re-enable input
 */
function processResponse(data) {
  setLoading(false);

  if (data.stage) updateStageTracker(data.stage);
  updateIntakeBar(data.intake_progress || null);

  // Soft error from workflow layer (2xx but error: true)
  if (data.error) {
    const hint = data.retryable ? " You can retry your last message." : " Please contact support.";
    addMessage(`⚠ ${data.reply}`, "error");
    showErrorBanner(data.reply + hint, data.retryable ?? false);
    return;
  }

  // Final output — use a special bubble + isolated copy button
  if (data.stage === "DONE" && data.output) {
    const bubble = addMessage(data.reply, "output");
    addCopyButton(bubble, data.output);   // rawText is data.output, not bubbleEl.textContent
  } else {
    addMessage(data.reply, "bot");
  }
}

/* ── Event listeners ──────────────────────────────────────────────────── */

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text) sendMessage(text);
});

/**
 * Stage-aware Retry:
 * Only replay lastMessage if the session is still in the same stage it was
 * in when the message was originally sent.  If the stage has advanced (e.g.
 * the user already moved on manually), dismiss the banner instead.
 */
btnRetry.addEventListener("click", () => {
  hideErrorBanner();
  if (!lastMessage) return;

  const currentStage = _currentStage();
  if (currentStage && lastMessageStage && currentStage !== lastMessageStage) {
    // Stage changed — replaying is unsafe; just dismiss
    return;
  }
  sendMessage(lastMessage);
});

btnDismiss.addEventListener("click", hideErrorBanner);

btnNew.addEventListener("click", () => {
  if (isLoading) return;
  startSession();
});

/* ── Bootstrap ────────────────────────────────────────────────────────── */
startSession();
