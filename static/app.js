/**
 * Nook — AI Marketing Studio  |  app.js
 *
 * Flow:
 *  1. Page load  → show welcome hero screen
 *  2. startSession() → POST /api/start → hide hero, show chat, first question
 *  3. sendMessage()  → POST /api/message → collect 6 answers
 *  4. stage === "DONE" → renderCampaign(data.campaign) → show campaign dashboard
 */

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const welcomeScreen  = document.getElementById("welcome-screen");
const chatLog        = document.getElementById("chat-log");
const campaignOutput = document.getElementById("campaign-output");
const inputDock      = document.getElementById("input-footer");
const chatForm       = document.getElementById("chat-form");
const chatInput      = document.getElementById("chat-input");
const btnSend        = document.getElementById("btn-send");
const btnNew         = document.getElementById("btn-new");
const btnStart       = document.getElementById("btn-start");
const topbar         = document.querySelector(".topbar");
const typingRow      = document.getElementById("typing");
const errorBanner    = document.getElementById("error-banner");
const errorText      = document.getElementById("error-text");
const btnRetry       = document.getElementById("btn-retry");
const btnDismiss     = document.getElementById("btn-dismiss-error");
const progFill       = document.getElementById("progress-fill");
const progLabel      = document.getElementById("progress-label");
const topbarTitle    = document.getElementById("topbar-title");
const topbarBadge    = document.getElementById("topbar-badge");

/* ── State ──────────────────────────────────────────────────────────────── */
let sessionId        = null;
let isLoading        = false;
let lastMessage      = "";
let lastMessageStage = null;
let currentStage     = "INTAKE";

const TOTAL_Q = 6;

/* ── Sidebar step tracker ───────────────────────────────────────────────── */

function setStep(stage) {
  currentStage = stage;

  document.querySelectorAll(".step-item").forEach(el => {
    const s = el.dataset.stage;
    el.classList.remove("active", "done");
    if (s === stage)                        el.classList.add("active");
    else if (stage === "DONE" && s === "INTAKE") el.classList.add("done");
  });

  if (stage === "DONE") {
    topbarBadge.textContent = "Campaign Ready";
    topbarBadge.classList.add("done");
  } else {
    topbarBadge.textContent = "Brief";
    topbarBadge.classList.remove("done");
  }
}

/* ── Progress bar ───────────────────────────────────────────────────────── */

function setProgress(current, total) {
  const pct = Math.round((current / total) * 100);
  progFill.style.width = `${pct}%`;
  progLabel.textContent = `${current} of ${total}`;
}

/* ── Error banner ───────────────────────────────────────────────────────── */

function showErrorBanner(msg, retryable = false) {
  errorText.textContent = msg;
  btnRetry.classList.toggle("hidden", !retryable);
  errorBanner.classList.remove("hidden");
}

function hideErrorBanner() {
  errorBanner.classList.add("hidden");
}

/* ── Loading state ──────────────────────────────────────────────────────── */

function setLoading(active) {
  isLoading = active;
  chatInput.disabled = active;
  btnSend.disabled   = active;
  typingRow.classList.toggle("hidden", !active);
  if (!active) chatInput.focus();
}

/* ── Screen switching ───────────────────────────────────────────────────── */

function showWelcome() {
  welcomeScreen.classList.remove("hidden");
  chatLog.classList.add("hidden");
  campaignOutput.classList.add("hidden");
  inputDock.classList.add("hidden");
  topbar.classList.add("hero-mode");
  topbarTitle.textContent = "Nook — AI Marketing Studio";
  setStep("INTAKE");
  setProgress(0, TOTAL_Q);
}

function showChat() {
  welcomeScreen.classList.add("hidden");
  chatLog.classList.remove("hidden");
  campaignOutput.classList.add("hidden");
  inputDock.classList.remove("hidden");
  topbar.classList.remove("hero-mode");
  topbarTitle.textContent = "New Campaign";
}

function showCampaign() {
  welcomeScreen.classList.add("hidden");
  chatLog.classList.add("hidden");
  campaignOutput.classList.remove("hidden");
  inputDock.classList.add("hidden");
  topbar.classList.remove("hero-mode");
}

/* ── Chat messages ──────────────────────────────────────────────────────── */

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

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

/* ── Campaign renderer ──────────────────────────────────────────────────── */

const PLATFORMS = [
  { key: "facebook_post",  label: "Facebook",  dot: "fb" },
  { key: "instagram_post", label: "Instagram", dot: "ig" },
  { key: "linkedin_post",  label: "LinkedIn",  dot: "li" },
  { key: "email",          label: "Email",     dot: "em",  wide: true },
  { key: "blog",           label: "Blog Post", dot: "bl",  full: true },
];

function esc(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function makeCopyBtn(text, cls = "card-copy-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.textContent = "Copy";
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = "✓ Copied";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
    }).catch(() => { btn.textContent = "Select & copy"; });
  });
  return btn;
}

function renderCampaign(c) {
  showCampaign();
  campaignOutput.innerHTML = "";

  /* ── IBM watsonx badge ── */
  const wxBadge = el("div", "watsonx-badge");
  wxBadge.innerHTML = `
    <span class="watsonx-badge-dot"></span>
    <svg viewBox="0 0 24 24" fill="none" width="13" height="13"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/><path d="M8 12l3 3 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Generated by IBM watsonx Granite`;
  campaignOutput.appendChild(wxBadge);

  /* ── Header ── */
  const header = el("div", "campaign-header");
  const titleRow = el("div", "campaign-title-row");

  const title = el("h2", "campaign-title");
  title.textContent = c.campaign_title || "Your Campaign";
  topbarTitle.textContent = c.campaign_title || "Your Campaign";

  const actions = el("div", "campaign-actions");
  const copyAll = el("button", "btn-copy-all");
  copyAll.type = "button";
  copyAll.textContent = "⬇ Copy All";
  copyAll.addEventListener("click", () => {
    navigator.clipboard.writeText(buildText(c)).then(() => {
      copyAll.textContent = "✓ All Copied!";
      setTimeout(() => { copyAll.textContent = "⬇ Copy All"; }, 2500);
    });
  });
  actions.appendChild(copyAll);

  titleRow.append(title, actions);
  header.appendChild(titleRow);

  if (c.campaign_summary) {
    const summary = el("p", "campaign-summary");
    summary.textContent = c.campaign_summary;
    header.appendChild(summary);
  }
  campaignOutput.appendChild(header);

  /* ── CTA banner ── */
  if (c.call_to_action) {
    const banner = el("div", "cta-banner");
    banner.innerHTML = `
      <div class="cta-icon-wrap">🎯</div>
      <div class="cta-info">
        <div class="cta-label">Call to Action</div>
        <div class="cta-value">${esc(c.call_to_action)}</div>
      </div>`;
    const cb = makeCopyBtn(c.call_to_action, "cta-copy-btn");
    banner.appendChild(cb);
    campaignOutput.appendChild(banner);
  }

  /* ── Platform cards ── */
  const grid = el("div", "cards-grid");

  PLATFORMS.forEach(({ key, label, dot, wide, full }) => {
    const content = c[key];
    if (!content) return;

    const card = el("div", "content-card" + (full ? " full" : wide ? " wide" : ""));

    const head = el("div", "card-head");
    const ptag = el("div", "platform-tag");
    const pdot = el("span", `p-dot ${dot}`);
    const pname = el("span", "p-name");
    pname.textContent = label;
    ptag.append(pdot, pname);
    head.append(ptag, makeCopyBtn(content));

    const body = el("div", "card-body");
    body.textContent = content;

    card.append(head, body);
    grid.appendChild(card);
  });

  campaignOutput.appendChild(grid);

  /* ── Tags: SEO keywords ── */
  const hasKw = Array.isArray(c.seo_keywords) && c.seo_keywords.some(Boolean);
  const hasHt = Array.isArray(c.hashtags)     && c.hashtags.some(Boolean);

  if (hasKw || hasHt) {
    const block = el("div", "tags-block");

    if (hasKw) {
      const lbl = el("div", "tags-section-title"); lbl.textContent = "SEO Keywords";
      const row = el("div", "tags-row");
      c.seo_keywords.filter(Boolean).forEach(kw => {
        const t = el("span", "tag kw"); t.textContent = kw; row.appendChild(t);
      });
      block.append(lbl, row);
    }

    if (hasHt) {
      const lbl = el("div", "tags-section-title");
      lbl.textContent = "Hashtags";
      if (hasKw) lbl.style.marginTop = "18px";
      const row = el("div", "tags-row");
      c.hashtags.filter(Boolean).forEach(ht => {
        const t = el("span", "tag ht"); t.textContent = ht; row.appendChild(t);
      });
      block.append(lbl, row);
    }

    campaignOutput.appendChild(block);
  }

  /* ── Image prompts ── */
  const hasImg = Array.isArray(c.image_prompts) && c.image_prompts.some(Boolean);
  if (hasImg) {
    const block = el("div", "img-prompts-block");
    const lbl = el("div", "img-prompts-title"); lbl.textContent = "Visual / Image Prompts";
    const list = el("div", "img-prompt-list");

    c.image_prompts.filter(Boolean).forEach((prompt, i) => {
      const row = el("div", "img-prompt-row");
      const num = el("div", "prompt-num"); num.textContent = i + 1;
      const txt = el("div", "prompt-text"); txt.textContent = prompt;
      row.append(num, txt);
      list.appendChild(row);
    });

    block.append(lbl, list);
    campaignOutput.appendChild(block);
  }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function buildText(c) {
  const parts = [];
  if (c.campaign_title)   parts.push(`CAMPAIGN: ${c.campaign_title}\n`);
  if (c.campaign_summary) parts.push(`SUMMARY\n${c.campaign_summary}\n`);
  if (c.call_to_action)   parts.push(`CALL TO ACTION\n${c.call_to_action}\n`);
  PLATFORMS.forEach(({ key, label }) => {
    if (c[key]) parts.push(`${label.toUpperCase()}\n${c[key]}\n`);
  });
  if (c.seo_keywords?.length) parts.push(`SEO KEYWORDS\n${c.seo_keywords.join(", ")}\n`);
  if (c.hashtags?.length)     parts.push(`HASHTAGS\n${c.hashtags.join(" ")}\n`);
  if (c.image_prompts?.length) {
    parts.push(`IMAGE PROMPTS\n${c.image_prompts.map((p,i)=>`${i+1}. ${p}`).join("\n")}\n`);
  }
  return parts.join("\n");
}

/* ── API ────────────────────────────────────────────────────────────────── */

async function apiFetch(endpoint, body) {
  const resp = await fetch(endpoint, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  let data;
  try { data = await resp.json(); }
  catch { throw new Error(`Server returned non-JSON (HTTP ${resp.status}).`); }

  if (!resp.ok) {
    const err = new Error(data?.reply || `Server error (HTTP ${resp.status}).`);
    err.retryable = data?.retryable ?? false;
    throw err;
  }
  return data;
}

/* ── Session ────────────────────────────────────────────────────────────── */

async function startSession() {
  hideErrorBanner();

  if (sessionId) {
    try { await apiFetch("/api/reset", { session_id: sessionId }); } catch { /* best-effort */ }
  }

  chatLog.innerHTML = "";
  campaignOutput.innerHTML = "";
  sessionId        = null;
  lastMessage      = "";
  lastMessageStage = null;

  showWelcome();
  // Hero shown — session starts when user clicks "Start Building"
}

async function beginSession() {
  showChat();
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
    showChat();
    showErrorBanner(err.message || "Failed to connect. Please refresh.", false);
    addMessage("⚠ Couldn't connect to the server. Please refresh.", "error");
  }
}

/* ── Message handling ───────────────────────────────────────────────────── */

async function sendMessage(text) {
  if (!text || isLoading || !sessionId) return;

  lastMessage      = text;
  lastMessageStage = currentStage;

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
    addMessage(`⚠ ${err.message}${retryable ? " You can retry above." : ""}`, "error");
    showErrorBanner(err.message, retryable);
  }
}

function processResponse(data) {
  setLoading(false);

  if (data.stage) setStep(data.stage);
  if (data.intake_progress) setProgress(data.intake_progress.current, data.intake_progress.total);

  // Soft error
  if (data.error) {
    addMessage(`⚠ ${data.reply}${data.retryable ? " Please retry." : ""}`, "error");
    showErrorBanner(data.reply, data.retryable ?? false);
    return;
  }

  // Campaign complete
  if (data.stage === "DONE" && data.campaign) {
    addMessage(data.reply || "Your campaign is ready!", "bot");
    setProgress(TOTAL_Q, TOTAL_Q);
    setTimeout(() => renderCampaign(data.campaign), 350);
    return;
  }

  addMessage(data.reply, "bot");
}

/* ── Events ─────────────────────────────────────────────────────────────── */

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text) sendMessage(text);
});

// "Start Building" hero button — starts the actual session
if (btnStart) {
  btnStart.addEventListener("click", () => {
    if (!isLoading) beginSession();
  });
}

btnRetry.addEventListener("click", () => {
  hideErrorBanner();
  if (!lastMessage) return;
  if (lastMessageStage && currentStage && currentStage !== lastMessageStage) return;
  sendMessage(lastMessage);
});

btnDismiss.addEventListener("click", hideErrorBanner);

btnNew.addEventListener("click", () => {
  if (isLoading) return;
  startSession(); // resets state and shows welcome hero
});

/* ── Boot ───────────────────────────────────────────────────────────────── */
// Show the welcome hero. Session begins when user clicks "Start Building".
showWelcome();
