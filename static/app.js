/**
 * Nook — AI Marketing Studio
 * Frontend controller
 *
 * Flow:
 *  1. startSession() -> POST /api/start -> show first intake question
 *  2. sendMessage()  -> POST /api/message -> collect answers one by one
 *  3. On stage "DONE" -> renderCampaign(data.campaign) -> show campaign cards
 *
 * Error handling:
 *  - 2xx with error:true -> in-chat error bubble + banner
 *  - Network/4xx/5xx     -> in-chat error bubble + banner with optional retry
 *  - Stage-aware retry   -> replays lastMessage only if stage hasn't changed
 */

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const chatLog        = document.getElementById("chat-log");
const chatForm       = document.getElementById("chat-form");
const chatInput      = document.getElementById("chat-input");
const btnSend        = document.getElementById("btn-send");
const btnNew         = document.getElementById("btn-new");
const typingEl       = document.getElementById("typing");
const errorBanner    = document.getElementById("error-banner");
const errorText      = document.getElementById("error-text");
const btnRetry       = document.getElementById("btn-retry");
const btnDismiss     = document.getElementById("btn-dismiss-error");
const campaignOutput = document.getElementById("campaign-output");
const inputFooter    = document.getElementById("input-footer");
const progressFill   = document.getElementById("progress-fill");
const progressLabel  = document.getElementById("progress-label");
const topbarTitle    = document.getElementById("topbar-title");
const topbarBadge    = document.getElementById("topbar-badge");

/* ── State ──────────────────────────────────────────────────────────────── */
let sessionId        = null;
let isLoading        = false;
let lastMessage      = "";
let lastMessageStage = null;
let currentStage     = "INTAKE";

const TOTAL_QUESTIONS = 6;

/* ── Sidebar step tracker ───────────────────────────────────────────────── */

function setStep(stage) {
  currentStage = stage;
  document.querySelectorAll(".step-item").forEach(el => {
    const s = el.dataset.stage;
    el.classList.remove("active", "done");
    if (s === stage) {
      el.classList.add("active");
    } else if (stage === "DONE" && s === "INTAKE") {
      el.classList.add("done");
    }
  });

  // Update topbar
  if (stage === "DONE") {
    topbarBadge.textContent = "Campaign Ready";
    topbarBadge.style.background = "var(--success-bg)";
    topbarBadge.style.color = "var(--success)";
  } else {
    topbarBadge.textContent = "Brief";
    topbarBadge.style.background = "";
    topbarBadge.style.color = "";
  }
}

/* ── Progress bar ───────────────────────────────────────────────────────── */

function setProgress(current, total) {
  const pct = Math.round((current / total) * 100);
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${current} of ${total}`;
}

/* ── Error banner ───────────────────────────────────────────────────────── */

function showErrorBanner(message, retryable = false) {
  errorText.textContent = message;
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
  typingEl.classList.toggle("hidden", !active);
  if (!active) chatInput.focus();
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

const PLATFORM_CONFIGS = [
  { key: "facebook_post",  label: "Facebook",  dot: "fb" },
  { key: "instagram_post", label: "Instagram", dot: "ig" },
  { key: "linkedin_post",  label: "LinkedIn",  dot: "li" },
  { key: "email",          label: "Email",     dot: "email", full: true },
  { key: "blog",           label: "Blog Post", dot: "blog",  full: true },
];

function makeCopyBtn(text) {
  const btn = document.createElement("button");
  btn.className = "card-copy-btn";
  btn.textContent = "Copy";
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = "✓ Copied";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 2000);
    }).catch(() => {
      btn.textContent = "Select & copy manually";
    });
  });
  return btn;
}

function renderCampaign(campaign) {
  // Hide chat, show campaign
  chatLog.classList.add("hidden");
  campaignOutput.classList.remove("hidden");
  inputFooter.classList.add("hidden");
  campaignOutput.innerHTML = "";

  /* ── Header ── */
  const header = document.createElement("div");
  header.className = "campaign-header";

  const titleRow = document.createElement("div");
  titleRow.className = "campaign-title-row";

  const title = document.createElement("h2");
  title.className = "campaign-title";
  title.textContent = campaign.campaign_title || "Your Campaign";
  topbarTitle.textContent = campaign.campaign_title || "Your Campaign";

  const actions = document.createElement("div");
  actions.className = "campaign-actions";

  const copyAllBtn = document.createElement("button");
  copyAllBtn.className = "btn-export primary";
  copyAllBtn.innerHTML = `
    <svg viewBox="0 0 16 16" fill="none" width="13" height="13"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11H2.5A1.5 1.5 0 011 9.5V3A1.5 1.5 0 012.5 1.5H8A1.5 1.5 0 019.5 3V3.5" stroke="currentColor" stroke-width="1.5"/></svg>
    Copy All`;
  copyAllBtn.addEventListener("click", () => {
    const fullText = buildFullCampaignText(campaign);
    navigator.clipboard.writeText(fullText).then(() => {
      copyAllBtn.textContent = "✓ All Copied!";
      setTimeout(() => {
        copyAllBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" width="13" height="13"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11H2.5A1.5 1.5 0 011 9.5V3A1.5 1.5 0 012.5 1.5H8A1.5 1.5 0 019.5 3V3.5" stroke="currentColor" stroke-width="1.5"/></svg> Copy All`;
      }, 2500);
    });
  });

  actions.appendChild(copyAllBtn);
  titleRow.appendChild(title);
  titleRow.appendChild(actions);
  header.appendChild(titleRow);

  if (campaign.campaign_summary) {
    const summary = document.createElement("p");
    summary.className = "campaign-summary";
    summary.textContent = campaign.campaign_summary;
    header.appendChild(summary);
  }

  campaignOutput.appendChild(header);

  /* ── CTA Row ── */
  if (campaign.call_to_action) {
    const ctaRow = document.createElement("div");
    ctaRow.className = "cta-row";
    ctaRow.innerHTML = `
      <div class="cta-icon">🎯</div>
      <div class="cta-text">
        <div class="cta-label">Call to Action</div>
        <div class="cta-value">${escHtml(campaign.call_to_action)}</div>
      </div>`;
    const ctaCopy = makeCopyBtn(campaign.call_to_action);
    ctaCopy.style.flexShrink = "0";
    ctaRow.appendChild(ctaCopy);
    campaignOutput.appendChild(ctaRow);
  }

  /* ── Platform cards ── */
  const grid = document.createElement("div");
  grid.className = "cards-grid";

  PLATFORM_CONFIGS.forEach(({ key, label, dot, full }) => {
    const content = campaign[key];
    if (!content) return;

    const card = document.createElement("div");
    card.className = `content-card${full ? " full" : ""}`;

    const cardHeader = document.createElement("div");
    cardHeader.className = "card-header";
    cardHeader.innerHTML = `
      <div class="card-platform">
        <span class="platform-dot ${dot}"></span>
        <span class="platform-name">${escHtml(label)}</span>
      </div>`;
    cardHeader.appendChild(makeCopyBtn(content));

    const cardBody = document.createElement("div");
    cardBody.className = "card-body";
    cardBody.textContent = content;

    card.appendChild(cardHeader);
    card.appendChild(cardBody);
    grid.appendChild(card);
  });

  campaignOutput.appendChild(grid);

  /* ── SEO keywords + hashtags ── */
  const hasKeywords = Array.isArray(campaign.seo_keywords) && campaign.seo_keywords.some(Boolean);
  const hasHashtags = Array.isArray(campaign.hashtags) && campaign.hashtags.some(Boolean);

  if (hasKeywords || hasHashtags) {
    const tagsSection = document.createElement("div");
    tagsSection.className = "tags-section";

    if (hasKeywords) {
      const kLabel = document.createElement("div");
      kLabel.className = "tags-section-title";
      kLabel.textContent = "SEO Keywords";
      tagsSection.appendChild(kLabel);

      const kRow = document.createElement("div");
      kRow.className = "tags-row";
      campaign.seo_keywords.filter(Boolean).forEach(kw => {
        const tag = document.createElement("span");
        tag.className = "tag keyword";
        tag.textContent = kw;
        kRow.appendChild(tag);
      });
      tagsSection.appendChild(kRow);
    }

    if (hasHashtags) {
      const hLabel = document.createElement("div");
      hLabel.className = "tags-section-title";
      hLabel.style.marginTop = hasKeywords ? "18px" : "0";
      hLabel.textContent = "Hashtags";
      tagsSection.appendChild(hLabel);

      const hRow = document.createElement("div");
      hRow.className = "tags-row";
      campaign.hashtags.filter(Boolean).forEach(ht => {
        const tag = document.createElement("span");
        tag.className = "tag hashtag";
        tag.textContent = ht;
        hRow.appendChild(tag);
      });
      tagsSection.appendChild(hRow);
    }

    campaignOutput.appendChild(tagsSection);
  }

  /* ── Image prompts ── */
  const hasPrompts = Array.isArray(campaign.image_prompts) && campaign.image_prompts.some(Boolean);
  if (hasPrompts) {
    const imgSection = document.createElement("div");
    imgSection.className = "image-section";

    const imgTitle = document.createElement("div");
    imgTitle.className = "image-section-title";
    imgTitle.textContent = "Visual / Image Prompts";
    imgSection.appendChild(imgTitle);

    const list = document.createElement("div");
    list.className = "image-prompts-list";

    campaign.image_prompts.filter(Boolean).forEach((prompt, i) => {
      const item = document.createElement("div");
      item.className = "image-prompt-item";
      item.innerHTML = `
        <div class="image-prompt-num">${i + 1}</div>
        <div class="image-prompt-text">${escHtml(prompt)}</div>`;
      list.appendChild(item);
    });

    imgSection.appendChild(list);
    campaignOutput.appendChild(imgSection);
  }
}

function buildFullCampaignText(campaign) {
  const lines = [];
  if (campaign.campaign_title)   lines.push(`CAMPAIGN: ${campaign.campaign_title}\n`);
  if (campaign.campaign_summary) lines.push(`SUMMARY\n${campaign.campaign_summary}\n`);
  if (campaign.call_to_action)   lines.push(`CALL TO ACTION\n${campaign.call_to_action}\n`);
  PLATFORM_CONFIGS.forEach(({ key, label }) => {
    if (campaign[key]) lines.push(`${label.toUpperCase()}\n${campaign[key]}\n`);
  });
  if (campaign.seo_keywords?.length) lines.push(`SEO KEYWORDS\n${campaign.seo_keywords.join(", ")}\n`);
  if (campaign.hashtags?.length)     lines.push(`HASHTAGS\n${campaign.hashtags.join(" ")}\n`);
  if (campaign.image_prompts?.length) {
    lines.push(`IMAGE PROMPTS\n${campaign.image_prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n`);
  }
  return lines.join("\n");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  catch { throw new Error(`Server returned non-JSON response (HTTP ${resp.status}).`); }

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

  chatLog.classList.remove("hidden");
  chatLog.innerHTML = "";
  campaignOutput.innerHTML = "";
  campaignOutput.classList.add("hidden");
  inputFooter.classList.remove("hidden");

  sessionId        = null;
  lastMessage      = "";
  lastMessageStage = null;

  setStep("INTAKE");
  setProgress(0, TOTAL_QUESTIONS);
  topbarTitle.textContent = "New Campaign";

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
    showErrorBanner(err.message || "Failed to start. Please refresh.", false);
    addMessage("⚠ Couldn't connect. Please refresh the page.", "error");
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
    const hint = retryable ? " You can retry above." : "";
    addMessage(`⚠ ${err.message}${hint}`, "error");
    showErrorBanner(err.message, retryable);
  }
}

function processResponse(data) {
  setLoading(false);

  if (data.stage) setStep(data.stage);

  if (data.intake_progress) {
    setProgress(data.intake_progress.current, data.intake_progress.total);
  }

  // Soft error (2xx but error flag set)
  if (data.error) {
    const hint = data.retryable ? " Please retry." : " Please contact support.";
    addMessage(`⚠ ${data.reply}${hint}`, "error");
    showErrorBanner(data.reply, data.retryable ?? false);
    return;
  }

  // Campaign complete
  if (data.stage === "DONE" && data.campaign) {
    addMessage(data.reply || "Your campaign is ready!", "bot");
    setTimeout(() => renderCampaign(data.campaign), 400);
    setProgress(TOTAL_QUESTIONS, TOTAL_QUESTIONS);
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

btnRetry.addEventListener("click", () => {
  hideErrorBanner();
  if (!lastMessage) return;
  if (lastMessageStage && currentStage && currentStage !== lastMessageStage) return;
  sendMessage(lastMessage);
});

btnDismiss.addEventListener("click", hideErrorBanner);

btnNew.addEventListener("click", () => {
  if (isLoading) return;
  startSession();
});

/* ── Boot ───────────────────────────────────────────────────────────────── */
startSession();
