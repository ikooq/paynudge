// PayNudge front end: composer -> AI draft -> PayPal invoice -> receivables grid -> AI nudges.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const icon = {
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
};

const state = {
  images: [],
  draft: null,
  rows: [],
  status: null,
  nudge: null,
  grid: null,
  samples: [],
  justPaid: new Set(),
  watchUntil: 0, // poll PayPal faster until this time (after an invoice is sent)
  seenActivity: null,
  agingBucket: null,
  planIds: [],
  pendingInvoice: null,
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.repeatConfirmationRequired = data.repeatConfirmationRequired === true;
    throw err;
  }
  return data;
}

async function sendReviewedReminder(row, subject, note) {
  const path = `/api/invoices/${encodeURIComponent(row.id)}/remind`;
  const body = { subject, note, client: row.client, number: row.number };
  try {
    return await api(path, { method: "POST", body });
  } catch (err) {
    if (!err.repeatConfirmationRequired || !confirm(`${err.message}\n\nHave you checked PayPal and confirmed you want to send another reminder to ${row.client}?`)) throw err;
    return api(path, { method: "POST", body: { ...body, confirmRepeat: true } });
  }
}

function recentReminder(row) {
  const h = row.reminderHistory;
  return Boolean(h && (h.status !== "sent" || Date.now() - Date.parse(h.at) < 48 * 3600_000));
}

function fmt(amount, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount || 0);
  } catch {
    return `${Number(amount || 0).toFixed(2)} ${currency}`;
  }
}

function fmtTotals(map) {
  const entries = Object.entries(map || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { main: fmt(0, "USD"), extra: "" };
  const [first, ...rest] = entries;
  return { main: fmt(first[1], first[0]), extra: rest.map(([c, v]) => `+ ${fmt(v, c)}`).join(" ") };
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

let toastTimer;
function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "error" ? 6000 : 3500);
}

// "gemini-2.5-flash" -> "Gemini 2.5 Flash", "openai/gpt-oss-120b" -> "GPT OSS 120B"
function modelName(id) {
  return id
    .split("/")
    .pop()
    .split("-")
    .map((w) =>
      /^(gpt|oss)$/i.test(w) || /^\d+b$/i.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

function aiLabel({ model, provider }) {
  const name = modelName(model);
  return provider.toLowerCase().includes(name.split(" ")[0].toLowerCase()) ? name : `${name} on ${provider}`;
}

function aiTitle({ model, visionModel, provider }) {
  return `AI by ${provider}: ${model}${visionModel ? ` (screenshots read by ${visionModel})` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Status chips + samples
// ---------------------------------------------------------------------------------------------
async function loadStatus() {
  const s = (state.status = await api("/api/status"));
  const chips = [
    s.paypal.live
      ? `<span class="chip"><i></i>PayPal ${s.paypal.env === "live" ? "Live" : "Sandbox"}</span>`
      : `<span class="chip demo" title="Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to use the real sandbox"><i></i>PayPal · demo mode</span>`,
    s.ai.live
      ? `<span class="chip" title="${esc(aiTitle(s.ai))}"><i></i>${esc(aiLabel(s.ai))}</span>`
      : `<span class="chip demo" title="Set GROQ_API_KEY to use the AI"><i></i>AI · demo mode</span>`,
    `<span class="chip hide-sm">Seller: ${esc(s.business)}</span>`,
  ];
  $("#statusChips").innerHTML = chips.join("");
  $("#dataNotice").textContent = s.ai.live
    ? `Chats and screenshots are sent to ${s.ai.provider} for processing. Use test data in this shared demo.`
    : "Demo mode uses local sample responses; no chat is sent to an AI provider.";
}

async function loadSamples() {
  const samples = await api("/api/samples");
  state.samples = samples;
  const wrap = $("#sampleChips");
  for (const s of samples) {
    const b = document.createElement("button");
    b.className = "sample-chip";
    b.type = "button";
    b.textContent = s.label;
    b.addEventListener("click", () => {
      $("#chatInput").value = s.text;
      state.images = [];
      renderThumbs();
      $("#chatInput").focus();
    });
    wrap.append(b);
  }
}

// ---------------------------------------------------------------------------------------------
// Composer: text + screenshots
// ---------------------------------------------------------------------------------------------
async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    return { media_type: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  for (const f of images) {
    if (state.images.length >= 3) {
      toast("Up to 3 screenshots per invoice.", "error");
      break;
    }
    try {
      state.images.push(await fileToImage(f));
    } catch {
      toast(`Couldn't read ${f.name}`, "error");
    }
  }
  renderThumbs();
}

function renderThumbs() {
  const wrap = $("#thumbs");
  wrap.innerHTML = "";
  state.images.forEach((img, i) => {
    const el = document.createElement("div");
    el.className = "thumb";
    el.innerHTML = `<img src="${img.preview}" alt="Screenshot ${i + 1}"><button type="button" aria-label="Remove screenshot">✕</button>`;
    el.querySelector("button").addEventListener("click", () => {
      state.images.splice(i, 1);
      renderThumbs();
    });
    wrap.append(el);
  });
  $("#ocrBtn").hidden = state.images.length === 0;
}

async function readScreenshotsLocally() {
  const images = [...state.images];
  if (!images.length) return;
  const btn = $("#ocrBtn");
  const status = $("#ocrStatus");
  btn.disabled = true;
  $("#extractBtn").disabled = true;
  status.hidden = false;
  status.textContent = "Loading local OCR (English, Russian and Spanish). First use downloads language data and may take a while.";
  let worker;
  let timeoutId;
  let timedOut = false;
  try {
    if (!window.Tesseract) await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/tesseract/tesseract.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load OCR files."));
      document.head.append(script);
    });
    const loading = window.Tesseract.createWorker(["eng", "rus", "spa"], 1, {
      workerPath: "/vendor/tesseract/worker.min.js",
      corePath: "/vendor/tesseract-core",
      langPath: "/vendor/ocr-data",
      logger: (progress) => {
        if (!timedOut && progress.status) status.textContent = `Preparing OCR: ${progress.status} (${Math.round((progress.progress || 0) * 100)}%)`;
      },
    });
    loading.then((lateWorker) => { if (timedOut) lateWorker.terminate(); }).catch(() => {});
    worker = await Promise.race([
      loading,
      new Promise((_, reject) => { timeoutId = setTimeout(() => { timedOut = true; reject(new Error("Loading took too long; refresh the page")); }, 45000); }),
    ]);
    clearTimeout(timeoutId);
    const parts = [];
    for (const [index, img] of images.entries()) {
      status.textContent = `Reading screenshot ${index + 1} of ${images.length} on your device…`;
      const result = await worker.recognize(img.preview);
      const text = result.data.text.trim();
      if (!text) throw new Error(`No text was found in screenshot ${index + 1}.`);
      parts.push(text);
    }
    const field = $("#chatInput");
    field.value = [field.value.trim(), ...parts].filter(Boolean).join("\n\n");
    state.images = state.images.filter((img) => !images.includes(img));
    renderThumbs();
    status.textContent = state.status?.ai.live
      ? "OCR text is ready for review. Correct any mistakes before drafting; the recognized text will be sent to the AI provider."
      : "OCR text is ready for review. Correct any mistakes before drafting; this is demo mode with no live AI.";
    field.focus();
  } catch (err) {
    status.textContent = `Local OCR could not finish: ${err.message}. You can paste the conversation as text.`;
  } finally {
    clearTimeout(timeoutId);
    if (worker) await worker.terminate();
    btn.disabled = timedOut;
    $("#extractBtn").disabled = false;
  }
}

function setupComposer() {
  const zone = $("#dropzone");
  $("#fileInput").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });
  $("#chatInput").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      if (!e.clipboardData.getData("text")) e.preventDefault();
      addFiles(files);
    }
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    addFiles(e.dataTransfer.files);
  });
  $("#extractBtn").addEventListener("click", extract);
  $("#ocrBtn").addEventListener("click", readScreenshotsLocally);
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) extract();
  });
}

// ---------------------------------------------------------------------------------------------
// Draft card
// ---------------------------------------------------------------------------------------------
function renderEmpty() {
  $("#draftBody").innerHTML = `
    <div class="empty">
      <div class="glyph">${icon.doc}</div>
      <div><b>Your AI draft appears here</b><br>The AI pulls out the client, line items, currency and due date.<br>Every field stays editable before anything is sent.</div>
    </div>`;
}

let thinkingTimer;
function renderThinking() {
  const steps = ["Reading the conversation…", "Finding what the client agreed to…", "Pricing the line items…", "Checking dates and contact details…"];
  let i = 0;
  $("#draftBody").innerHTML = `
    <div class="thinking">
      <div class="status"><span class="spinner"></span><span id="thinkingText">${steps[0]}</span></div>
      <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton tall"></div><div class="skeleton"></div>
    </div>`;
  clearInterval(thinkingTimer);
  thinkingTimer = setInterval(() => {
    const el = $("#thinkingText");
    if (!el) return clearInterval(thinkingTimer);
    el.textContent = steps[++i % steps.length];
  }, 1800);
}

async function extract() {
  if (state.pendingInvoice) return toast("Resolve the pending invoice before creating another draft.", "error");
  const text = $("#chatInput").value;
  if (!text.trim() && !state.images.length) {
    toast("Paste a conversation or add a screenshot first.", "error");
    return;
  }
  const btn = $("#extractBtn");
  btn.disabled = true;
  renderThinking();
  try {
    state.draft = await api("/api/extract", {
      method: "POST",
      body: { text, images: state.images.map(({ media_type, data }) => ({ media_type, data })) },
    });
    renderDraft();
    if (window.innerWidth < 960) $("#draftCard").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    renderEmpty();
    toast(err.message, "error");
  } finally {
    clearInterval(thinkingTimer);
    btn.disabled = false;
  }
}

function lineTotal(it) {
  return (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
}

function draftTotal() {
  return state.draft.items.reduce((s, it) => s + lineTotal(it), 0);
}

function renderDraft() {
  const d = state.draft;
  const warnings = d.warnings.length
    ? `<div class="warnings">${d.warnings.map((w) => `<div class="warning">${icon.alert}<span>${esc(w)}</span></div>`).join("")}</div>`
    : "";
  const rows = d.items
    .map(
      (it, i) => `
      <div class="item-row" data-index="${i}">
        <input data-item="name" value="${esc(it.name)}" placeholder="Item" aria-label="Item name">
        <input data-item="quantity" class="num" type="number" min="0" step="any" value="${esc(it.quantity)}" aria-label="Quantity">
        <input data-item="unit_price" class="num" type="number" min="0" step="0.01" value="${esc(it.unit_price)}" aria-label="Unit price">
        <span class="line-total">${fmt(lineTotal(it), d.currency)}</span>
        <button class="remove" type="button" data-remove="${i}" aria-label="Remove line">${icon.trash}</button>
        <small class="item-evidence">${it.evidence && it.evidence_source ? `Source match (${esc(it.evidence_source)}): “${esc(it.evidence)}”` : "No source excerpt linked. Check this item against the original conversation."}</small>
      </div>`,
    )
    .join("");

  $("#draftBody").innerHTML = `
    ${warnings}
    <div class="form-grid">
      <label class="field"><span>Contact</span><input data-field="client.name" value="${esc(d.client.name)}" placeholder="Client name"></label>
      <label class="field"><span>Company</span><input data-field="client.business_name" value="${esc(d.client.business_name)}" placeholder="Optional"></label>
      <label class="field"><span>Email</span><input data-field="client.email" type="email" value="${esc(d.client.email)}" placeholder="client@company.com"></label>
      <label class="field"><span>Currency</span><input data-field="currency" maxlength="3" value="${esc(d.currency)}"></label>
      <label class="field"><span>Due date</span><input data-field="due_date" type="date" value="${esc(d.due_date)}"></label>
      <label class="field"><span>Payment terms</span><span><input data-field="due_on_receipt" type="checkbox" ${d.due_on_receipt ? "checked" : ""}> Due on receipt (if no date is set)</span></label>
    </div>
    <div class="items">
      <div class="items-head"><span>Item</span><span class="num">Qty</span><span class="num">Unit price</span><span class="num">Total</span><span></span></div>
      ${rows}
      <button class="add-line" type="button" id="addLine">+ Add line</button>
      <p class="muted evidence-note">A matching excerpt is a review aid, not proof of agreement or price. Screenshot transcripts can contain errors.</p>
    </div>
    <div class="draft-foot">
      <label class="field"><span>Note to client</span><textarea data-field="note_to_client" rows="2">${esc(d.note_to_client)}</textarea></label>
      <div class="total"><span>Total</span><strong id="draftTotal">${fmt(draftTotal(), d.currency)}</strong></div>
    </div>
    <div class="send-row">
      <span class="muted" id="sendHint"></span>
      <button class="btn dark" id="sendBtn" type="button"></button>
    </div>`;
  updateSendHint();
  const body = $("#draftBody");
  body.classList.remove("reveal");
  void body.offsetWidth; // restart the entrance animation
  body.classList.add("reveal");
}

function updateSendHint() {
  if (state.pendingInvoice) {
    $("#sendHint").textContent = "An earlier attempt is unresolved. Retry the same invoice, or verify it in PayPal before starting over.";
    $("#sendBtn").textContent = "Retry this invoice";
    return;
  }
  const email = state.draft.client.email.trim();
  $("#sendHint").innerHTML = email
    ? `PayPal will email the invoice to <b>${esc(email)}</b>.`
    : "No email: PayPal creates a payment link you can share in the chat.";
  $("#sendBtn").innerHTML = `${icon.check} ${email ? "Create &amp; send via PayPal" : "Create PayPal payment link"}`;
}

function setupDraftEvents() {
  const body = $("#draftBody");
  body.addEventListener("input", (e) => {
    const d = state.draft;
    if (!d) return;
    const t = e.target;
    if (t.dataset.field) {
      const [a, b] = t.dataset.field.split(".");
      if (b) d[a][b] = t.value;
      else d[a] = a === "due_on_receipt" ? t.checked : a === "currency" ? t.value.toUpperCase() : t.value;
      if (t.dataset.field === "client.email") updateSendHint();
      if (t.dataset.field === "currency") {
        for (const item of d.items) { item.evidence = ""; item.evidence_source = ""; }
        $$(".item-evidence", body).forEach((el) => { el.textContent = "Currency changed: check this item against the original conversation."; });
      }
    }
    if (t.dataset.item) {
      const row = t.closest(".item-row");
      const it = d.items[Number(row.dataset.index)];
      it[t.dataset.item] = t.dataset.item === "name" ? t.value : Number(t.value);
      it.evidence = "";
      it.evidence_source = "";
      $(".item-evidence", row).textContent = "Edited item: check it against the original conversation.";
      $(".line-total", row).textContent = fmt(lineTotal(it), d.currency);
    }
    const total = $("#draftTotal");
    if (total) total.textContent = fmt(draftTotal(), /^[A-Z]{3}$/.test(d.currency) ? d.currency : "USD");
  });
  body.addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove]");
    if (remove) {
      state.draft.items.splice(Number(remove.dataset.remove), 1);
      renderDraft();
    } else if (e.target.closest("#addLine")) {
      state.draft.items.push({ name: "", description: "", quantity: 1, unit_price: 0 });
      renderDraft();
      $$(".item-row input[data-item='name']").at(-1)?.focus();
    } else if (e.target.closest("#sendBtn")) {
      sendInvoice();
    } else if (e.target.closest("#discardPending")) {
      if (!confirm("Check PayPal first. Starting over can create a duplicate if the previous attempt succeeded. Continue?")) return;
      state.pendingInvoice = null;
      sessionStorage.removeItem("paynudge.pendingInvoice");
      renderDraft();
    } else if (e.target.closest("#newInvoice")) {
      state.draft = null;
      $("#chatInput").value = "";
      state.images = [];
      renderThumbs();
      renderEmpty();
      $("#chatInput").focus();
    } else if (e.target.closest("#copyLink")) {
      navigator.clipboard?.writeText($("#payerLink").value).then(() => toast("Payment link copied"));
    }
  });
}

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function showPendingInvoice() {
  $("#draftBody").querySelectorAll("input, textarea, button").forEach((el) => { if (!["sendBtn", "discardPending"].includes(el.id)) el.disabled = true; });
  updateSendHint();
  if (!$("#discardPending")) $("#sendHint").insertAdjacentHTML("afterend", '<button type="button" class="btn ghost small" id="discardPending">I checked PayPal; start over</button>');
}

async function sendInvoice() {
  const d = state.draft;
  if (!d.items.length || draftTotal() <= 0) return toast("Add at least one line item with a price.", "error");
  if (d.client.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.client.email)) return toast("That email doesn't look right.", "error");
  if (!d.due_date && !d.due_on_receipt) return toast("Choose a due date or confirm payment is due on receipt.", "error");
  const btn = $("#sendBtn");
  if (!state.pendingInvoice) {
    state.pendingInvoice = { operationId: crypto.randomUUID(), draft: structuredClone(d) };
    sessionStorage.setItem("paynudge.pendingInvoice", JSON.stringify(state.pendingInvoice));
  }
  // Keep the invoice immutable while the outcome is uncertain, including after a reload.
  showPendingInvoice();
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Talking to PayPal…`;
  try {
    const { row, payerUrl, emailed } = await api("/api/invoices", { method: "POST", body: state.pendingInvoice });
    state.pendingInvoice = null;
    sessionStorage.removeItem("paynudge.pendingInvoice");
    renderSuccess(row, payerUrl, emailed);
    await loadInvoices({ flashId: row.id });
  } catch (err) {
    toast(err.message, "error");
    if (err.status === 400) {
      state.pendingInvoice = null;
      sessionStorage.removeItem("paynudge.pendingInvoice");
      renderDraft();
      return;
    }
    btn.disabled = false;
    updateSendHint();
    $("#sendHint").textContent = err.message;
  }
}

function renderSuccess(row, payerUrl, emailed) {
  const link = payerUrl ? new URL(payerUrl, location.origin).href : "";
  $("#draftBody").innerHTML = `
    <div class="success">
      <div class="badge">${icon.check}</div>
      <div>
        <h3>Invoice #${esc(row.number)} ${emailed ? "sent via PayPal" : "is ready to share"}</h3>
        <p class="muted">${esc(row.client)} · ${fmt(row.amount, row.currency)}${row.dueDate ? ` · due ${fmtDate(row.dueDate)}` : ""}${emailed ? ` · emailed to ${esc(row.email)}` : ""}</p>
      </div>
      ${link ? `<div class="linkbox"><input id="payerLink" readonly value="${esc(link)}" aria-label="Payment link"><button class="btn ghost icon" id="copyLink" type="button" aria-label="Copy link">${icon.copy}</button></div>` : ""}
      <div class="actions">
        ${link ? `<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener">${icon.external} Open client's payment page</a>` : ""}
        <button class="btn ghost" id="newInvoice" type="button">New invoice</button>
      </div>
      <p class="watching"><i></i> Watching PayPal for the payment. Pay it on the client's page and this dashboard will notice.</p>
    </div>`;
  state.watchUntil = Date.now() + 10 * 60 * 1000;
  confetti();
}

// ---------------------------------------------------------------------------------------------
// Celebration: a small dependency-free confetti burst
// ---------------------------------------------------------------------------------------------
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("#confetti");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ["#5b4cf0", "#8b80ff", "#c8f169", "#16803c", "#f1b45a", "#ffffff"];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 13 - 4,
    size: Math.random() * 7 + 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 2600);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < 2600) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(start);
}

function celebratePayment(row) {
  const amount = row.paid || row.amount;
  toast(`🎉 ${row.client} just paid ${fmt(amount, row.currency)} for invoice #${row.number}`, "paid");
  confetti();
  state.justPaid.add(row.id);
  setTimeout(() => {
    state.justPaid.delete(row.id);
    state.grid?.redrawRows();
  }, 6000);
}

// ---------------------------------------------------------------------------------------------
// Receivables: KPIs + AG Grid
// ---------------------------------------------------------------------------------------------
const STATUS = {
  PAID: ["ok", "Paid"], MARKED_AS_PAID: ["ok", "Paid"], PAID_EXTERNAL: ["ok", "Paid"],
  SENT: ["info", "Sent"], UNPAID: ["info", "Unpaid"], SHARED: ["info", "Shared"],
  PARTIALLY_PAID: ["warn", "Part paid"], PAYMENT_PENDING: ["warn", "Pending"],
  SCHEDULED: ["neutral", "Scheduled"], DRAFT: ["neutral", "Draft"], CANCELLED: ["neutral", "Cancelled"],
};

function cell(html) {
  const el = document.createElement("div");
  el.style.height = "100%";
  el.innerHTML = html;
  return el.firstElementChild;
}

const columnDefs = [
  {
    headerName: "Client",
    field: "client",
    flex: 2,
    minWidth: 210,
    getQuickFilterText: (p) => `${p.data.client} ${p.data.items} ${p.data.email} ${p.data.number}`,
    cellRenderer: (p) =>
      cell(`<div class="cell-client"><b>${esc(p.data.client)}</b><small>${esc(p.data.items || p.data.email || p.data.contact)}</small></div>`),
  },
  { headerName: "Invoice", field: "number", width: 105, valueFormatter: (p) => (p.value ? `#${p.value}` : "—") },
  { headerName: "Amount", field: "amount", width: 125, type: "rightAligned", valueFormatter: (p) => fmt(p.value, p.data.currency) },
  { headerName: "Balance", field: "due", width: 125, type: "rightAligned", valueFormatter: (p) => fmt(p.value, p.data.currency) },
  {
    headerName: "Status",
    field: "status",
    width: 130,
    cellRenderer: (p) => {
      const [kind, label] = p.data.daysOverdue > 0 ? ["bad", "Overdue"] : STATUS[p.value] || ["neutral", p.value];
      return cell(`<div style="display:flex;align-items:center;height:100%"><span class="pill ${kind}">${esc(label)}</span></div>`);
    },
  },
  {
    headerName: "Due",
    field: "dueDate",
    width: 140,
    cellRenderer: (p) => {
      const r = p.data;
      let sub = "";
      if (r.daysOverdue > 0) sub = `<small class="bad">${r.daysOverdue} day${r.daysOverdue === 1 ? "" : "s"} late</small>`;
      else if (r.due > 0 && r.dueDate) {
        const days = Math.round((Date.parse(r.dueDate) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5);
        sub = `<small class="muted">${days === 0 ? "due today" : `in ${days} day${days === 1 ? "" : "s"}`}</small>`;
      }
      return cell(`<div class="cell-due"><span>${esc(fmtDate(r.dueDate)) || "—"}</span>${sub}</div>`);
    },
  },
  {
    headerName: "Next step",
    field: "nextAction.label",
    flex: 1,
    minWidth: 220,
    sortable: false,
    cellRenderer: (p) => {
      const r = p.data;
      const key = r.nextAction.key;
      const open = r.payerUrl
        ? `<a class="open-link" href="${esc(new URL(r.payerUrl, location.origin).href)}" target="_blank" rel="noopener" title="Open payment page">${icon.external}</a>`
        : "";
      let main = "";
      if (["friendly", "firm", "final"].includes(key)) {
        main = `<button class="nudge-btn ${key}" data-tone="${key}">${icon.bell} ${esc(r.nextAction.label)}</button>`;
      } else if (key === "wait") {
        main = `<button class="nudge-btn" data-tone="friendly">${icon.bell} Nudge</button><span class="muted" style="font-size:12.5px">${esc(r.nextAction.label)}</span>`;
      } else if (key === "done") {
        main = `<span class="pill ok">${icon.check} Collected</span>`;
      } else {
        main = `<span class="muted">${esc(r.nextAction.label)}</span>`;
      }
      const el = cell(`<div class="cell-actions">${main}${open}</div>`);
      el.querySelector("[data-tone]")?.addEventListener("click", () => openNudge(r, el.querySelector("[data-tone]").dataset.tone));
      return el;
    },
  },
];

function gridTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const dark = cs.colorScheme === "dark";
  return agGrid.themeQuartz.withParams({
    accentColor: v("--accent"),
    backgroundColor: v("--surface"),
    foregroundColor: v("--ink"),
    borderColor: v("--border"),
    headerBackgroundColor: v("--surface"),
    headerTextColor: v("--muted"),
    headerFontWeight: 600,
    rowHoverColor: v("--surface-2"),
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 14,
    wrapperBorder: false,
    wrapperBorderRadius: 0,
    browserColorScheme: dark ? "dark" : "light",
  });
}

function setupGrid() {
  if (!window.agGrid) {
    $("#grid").innerHTML = '<p class="muted" style="padding:20px">The table library failed to load.</p>';
    return;
  }
  state.grid = agGrid.createGrid($("#grid"), {
    columnDefs,
    rowData: [],
    rowSelection: { mode: "multiRow", enableClickSelection: false },
    isExternalFilterPresent: () => state.agingBucket !== null,
    doesExternalFilterPass: (node) => node.data.due > 0 && BUCKETS[state.agingBucket].test(node.data),
    theme: gridTheme(),
    rowHeight: 60,
    headerHeight: 44,
    domLayout: "autoHeight",
    pagination: true,
    paginationPageSize: 10,
    paginationPageSizeSelector: [10, 25, 50],
    animateRows: true,
    getRowId: (p) => p.data.id,
    getRowClass: (p) => (state.justPaid.has(p.data.id) ? "just-paid" : ""),
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    overlayNoRowsTemplate: '<span class="muted">No invoices yet. Draft your first one above.</span>',
    loading: true,
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
    state.grid.setGridOption("theme", gridTheme()),
  );
  $("#gridSearch").addEventListener("input", (e) => state.grid.setGridOption("quickFilterText", e.target.value));
  $("#refreshBtn").addEventListener("click", () => loadInvoices({ announce: true }));
  $("#agingChart").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-bucket]");
    if (!button) return;
    state.agingBucket = Number(button.dataset.bucket);
    state.grid.deselectAll();
    state.grid.onFilterChanged();
    renderAging(state.rows);
    $("#gridGuidance").textContent = `Showing ${BUCKETS[state.agingBucket].label} open invoices. Select rows to prepare reminders.`;
  });
  $("#clearAging").addEventListener("click", () => {
    state.agingBucket = null;
    state.grid.onFilterChanged();
    renderAging(state.rows);
    $("#gridGuidance").textContent = "Select invoices in the table, then prepare reminders. If none are selected, the oldest overdue invoices are used.";
  });
}

function renderKpis(k) {
  const out = fmtTotals(k.outstanding);
  const over = fmtTotals(k.overdue);
  const coll = fmtTotals(k.collected);
  $("#kpis").innerHTML = `
    <div class="kpi"><span>Outstanding</span><strong>${out.main}</strong><small>${out.extra || `${k.openCount} open invoice${k.openCount === 1 ? "" : "s"}`}</small></div>
    <div class="kpi ${k.overdueCount ? "bad" : ""}"><span>Overdue</span><strong>${over.main}</strong><small>${over.extra || `${k.overdueCount} invoice${k.overdueCount === 1 ? "" : "s"} late`}</small></div>
    <div class="kpi ok"><span>Collected</span><strong>${coll.main}</strong><small>${coll.extra || "Recorded in PayPal"}</small></div>
    <div class="kpi"><span>Invoices</span><strong>${k.total}</strong><small>Tracked in PayPal</small></div>`;
}

const PAID = new Set(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"]);

async function loadInvoices({ flashId, announce } = {}) {
  try {
    const data = await api("/api/invoices");
    const before = new Map(state.rows.map((r) => [r.id, r]));
    const newlyPaid = state.rows.length
      ? data.rows.filter((r) => {
          const old = before.get(r.id);
          return old && ((PAID.has(r.status) && !PAID.has(old.status)) || r.paid > old.paid);
        })
      : [];
    state.rows = data.rows;
    renderKpis(data.kpis);
    renderAging(data.rows);
    renderPlan(data.rows);
    newlyPaid.forEach(celebratePayment);
    loadActivity();
    if (state.grid) {
      state.grid.setGridOption("loading", false);
      state.grid.setGridOption("rowData", data.rows);
      if (newlyPaid.length) state.grid.redrawRows();
      if (flashId) {
        const node = state.grid.getRowNode(flashId);
        if (node) {
          state.grid.ensureNodeVisible(node);
          state.grid.flashCells({ rowNodes: [node] });
        }
      }
    }
    const source = state.status?.paypal.live ? `Live from PayPal ${state.status.paypal.env}` : "Demo data";
    $("#updatedAt").textContent = `${source} · updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
    if (announce) toast("Refreshed from PayPal");
  } catch (err) {
    $("#updatedAt").textContent = err.message;
    state.grid?.setGridOption("loading", false);
    if (announce) toast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------------------------
// Insights: receivables aging (one series, ordered by age) + agent activity feed
// ---------------------------------------------------------------------------------------------
const BUCKETS = [
  { label: "Not due yet", test: (r) => r.daysOverdue === 0 },
  { label: "1–7 days", test: (r) => r.daysOverdue >= 1 && r.daysOverdue <= 7 },
  { label: "8–21 days", test: (r) => r.daysOverdue >= 8 && r.daysOverdue <= 21 },
  { label: "21+ days", test: (r) => r.daysOverdue > 21 },
];

function recentPayPalContact(row) {
  return Boolean(row.lastSent && Date.now() - Date.parse(row.lastSent) < 48 * 3600_000);
}

function renderPlan(rows) {
  const overdue = rows.filter((r) => r.due > 0 && r.daysOverdue > 0);
  const held = overdue.filter((r) => recentReminder(r) || recentPayPalContact(r));
  const candidates = overdue.filter((r) => !recentReminder(r) && !recentPayPalContact(r)).sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number)).slice(0, 3);
  state.planIds = candidates.map((r) => r.id);
  $("#planSelect").disabled = !candidates.length;
  const body = $("#planBody");
  body.innerHTML = candidates.length ? `<div class="plan-list">${candidates.map((r, i) => `<div class="plan-item"><span class="plan-rank">0${i + 1}</span><div class="plan-details"><b>${esc(r.client)} · #${esc(r.number)}</b><small>${r.daysOverdue} days overdue · ${esc(toneFor(r))} reminder · ${esc(r.language)}</small></div><span class="plan-amount">${fmt(r.due, r.currency)}</span><button type="button" class="btn ghost small" data-plan-id="${esc(r.id)}">Review reminder</button></div>`).join("")}</div>` : '<p class="muted plan-note">No invoices are ready for this plan. Check recent or unconfirmed contacts below before sending another reminder.</p>';
  body.insertAdjacentHTML("beforeend", `<p class="muted plan-note">${held.length} overdue invoice${held.length === 1 ? "" : "s"} set aside because of recent or unconfirmed contact. Ranking uses days overdue, not a prediction or currency conversion. Review every message before sending.</p>`);
}

function renderAging(rows) {
  $("#clearAging").hidden = state.agingBucket === null;
  const open = rows.filter((r) => r.due > 0);
  const data = BUCKETS.map((b) => {
    const list = open.filter(b.test);
    const totals = {};
    for (const r of list) totals[r.currency] = (totals[r.currency] || 0) + r.due;
    return { ...b, count: list.length, totals, clients: list.map((r) => r.client) };
  });
  const max = Math.max(1, ...data.map((d) => d.count));
  $("#agingChart").innerHTML = open.length
    ? data
        .map((d, i) => {
          const money = Object.entries(d.totals).map(([c, v]) => fmt(v, c)).join(" + ") || "—";
          const tip = d.count ? `${d.label}: ${d.count} invoice${d.count === 1 ? "" : "s"} (${d.clients.join(", ")}), ${money}` : `${d.label}: none`;
          return `<button type="button" class="aging-row" data-bucket="${i}" aria-pressed="${state.agingBucket === i}" aria-label="${esc(tip)}" title="${esc(tip)}">
            <span class="label">${d.label}</span>
            <div class="aging-track">
              <div class="aging-bar" style="width:${d.count ? Math.max(6, (d.count / max) * 62) : 0.6}%"></div>
              <span class="aging-value">${d.count ? esc(money) : "—"}<small>${d.count ? `${d.count} inv.` : ""}</small></span>
            </div>
          </button>`;
        })
        .join("")
    : '<p class="muted">No open invoices. Everything is collected.</p>';
}

const FEED_ICONS = {
  ai: icon.sparkle,
  agent: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  paypal: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg>',
  payment: icon.check,
};

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

let activityBusy = false;
async function loadActivity() {
  if (activityBusy) return;
  activityBusy = true;
  try {
    const items = await api("/api/activity");
    const firstLoad = state.seenActivity === null;
    const seen = state.seenActivity || new Set();
    $("#activityFeed").innerHTML = items.length
      ? items
          .map(
            (e) => `<li class="${!firstLoad && !seen.has(e.id) ? "new" : ""}">
              <span class="ico ${e.kind}">${FEED_ICONS[e.kind] || icon.sparkle}</span>
              <span>${esc(e.text)}</span>
              <time datetime="${esc(e.at)}">${timeAgo(e.at)}</time>
            </li>`,
          )
          .join("")
      : '<li class="empty-feed">Nothing yet. Draft an invoice to see the agent at work.</li>';
    state.seenActivity = new Set(items.map((e) => e.id));
  } catch {
    /* the feed is decorative; the grid shows the error */
  } finally {
    activityBusy = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Collections autopilot: the agent picks overdue invoices, drafts a reminder for each in the
// right tone and the client's language, and sends the approved ones through PayPal.
// ---------------------------------------------------------------------------------------------
const toneFor = (r) => (r.daysOverdue > 21 ? "final" : r.daysOverdue > 7 ? "firm" : "friendly");
const ap = { items: [], running: false };

function apSteps(active) {
  const steps = ["Review ledger", "Pick tone & language", "Draft reminders", "Your approval", "Send via PayPal"];
  $("#apSteps").innerHTML = steps
    .map((s, i) => `<li class="${i < active ? "done" : i === active ? "active" : ""}">${i < active ? icon.check : i === active ? '<span class="spinner"></span>' : ""}${s}</li>`)
    .join("");
}

function apCard(item, i) {
  const r = item.row;
  const recentContact = (r.lastSent && Date.now() - Date.parse(r.lastSent) < 2 * 864e5) || recentReminder(r);
  const state_ =
    item.status === "writing" ? `<span class="state"><span class="spinner"></span> writing…</span>`
    : item.status === "sending" ? `<span class="state"><span class="spinner"></span> sending…</span>`
    : item.status === "sent" ? `<span class="state ok">${icon.check} sent by PayPal</span>`
    : item.status === "error" ? `<span class="state err">${esc(item.error)}</span>`
    : "";
  const body =
    item.status === "writing"
      ? '<div class="skeleton"></div>'
      : `<input class="subject" data-i="${i}" data-f="subject" value="${esc(item.subject)}" aria-label="Subject" ${item.status === "sent" ? "disabled" : ""}>
         <textarea rows="3" data-i="${i}" data-f="note" aria-label="Message" ${item.status === "sent" ? "disabled" : ""}>${esc(item.note)}</textarea>`;
  return `<article class="ap-card ${item.include ? "" : "off"} ${item.status === "sent" ? "sent" : ""}">
    <div class="ap-top">
      <input type="checkbox" data-i="${i}" ${item.include ? "checked" : ""} ${item.status === "sent" ? "disabled" : ""} aria-label="Include ${esc(r.client)}">
      <b>${esc(r.client)}</b>
      <span class="meta">#${esc(r.number)} · ${fmt(r.due, r.currency)} · ${r.daysOverdue} days late · ${esc(r.language)}${r.lastSent ? ` · PayPal last sent ${esc(fmtDate(r.lastSent.slice(0, 10)))}` : " · no send date available"}${r.reminderHistory ? ` · reminder ${r.reminderHistory.status === "sent" ? "sent" : "unconfirmed"} ${esc(fmtDate(r.reminderHistory.at.slice(0, 10)))}` : ""}${recentContact ? " · review before sending" : ""}</span>
      <span class="pill ${item.tone === "final" ? "bad" : item.tone === "firm" ? "warn" : "info"}">${item.tone}</span>
      ${state_}
    </div>
    ${body}
  </article>`;
}

function apRender() {
  $("#apList").innerHTML = ap.items.length
    ? ap.items.map(apCard).join("")
    : '<div class="ap-empty">🎉 Nothing is overdue. The agent has nobody to chase right now.</div>';
  const chosen = ap.items.filter((x) => x.include && x.status === "ready");
  const btn = $("#apSend");
  btn.disabled = ap.running || !chosen.length;
  btn.textContent = chosen.length ? `Approve & send ${chosen.length} reminder${chosen.length > 1 ? "s" : ""} via PayPal` : "Approve & send via PayPal";
}

async function openAutopilot() {
  const dlg = $("#autopilotDialog");
  if (!dlg.open) dlg.showModal();
  if (ap.running) return;
  ap.running = true;
  apSteps(0);
  $("#apHint").textContent = "Nothing is sent until you approve.";
  try {
    const selectedIds = new Set(state.grid?.getSelectedRows().map((row) => row.id) || []);
    await loadInvoices();
    const overdue = state.rows.filter((r) => r.due > 0 && r.daysOverdue > 0 && (selectedIds.size ? selectedIds.has(r.id) : state.agingBucket === null || BUCKETS[state.agingBucket].test(r))).sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 8);
    ap.items = overdue.map((row) => ({ row, tone: toneFor(row), include: !recentReminder(row) && !(row.lastSent && Date.now() - Date.parse(row.lastSent) < 2 * 864e5), status: "writing", subject: "", note: "" }));
    $("#apSummary").textContent = overdue.length
      ? `Review up to ${overdue.length} overdue invoice${overdue.length > 1 ? "s" : ""}. Recent PayPal contact is unchecked by default; check the history before approving.`
      : selectedIds.size ? "None of the selected invoices are overdue." : "No overdue invoices found.";
    api("/api/autopilot/started", { method: "POST", body: { count: overdue.length } }).then(loadActivity).catch(() => {});
    apSteps(overdue.length ? 2 : 5);
    apRender();
    // Draft two at a time so the free AI quota is not hit all at once.
    let next = 0;
    const worker = async () => {
      while (next < ap.items.length) {
        const item = ap.items[next++];
        try {
          const r = await api(`/api/invoices/${encodeURIComponent(item.row.id)}/reminder-draft`, { method: "POST", body: { tone: item.tone } });
          Object.assign(item, { subject: r.subject, note: r.note, status: "ready" });
        } catch (err) {
          Object.assign(item, { status: "error", error: err.message, include: false });
        }
        apRender();
      }
    };
    await Promise.all([worker(), worker()]);
    if (ap.items.length) apSteps(3);
    loadActivity();
  } finally {
    ap.running = false;
    apRender();
  }
}

async function sendAutopilot() {
  const chosen = ap.items.filter((x) => x.include && x.status === "ready");
  if (!chosen.length) return;
  ap.running = true;
  apSteps(4);
  for (const item of chosen) {
    item.status = "sending";
    apRender();
    try {
      await sendReviewedReminder(item.row, item.subject, item.note);
      item.status = "sent";
    } catch (err) {
      Object.assign(item, { status: "error", error: err.message });
    }
    apRender();
  }
  ap.running = false;
  apSteps(5);
  apRender();
  const sent = chosen.filter((x) => x.status === "sent").length;
  $("#apHint").textContent = `${sent} reminder${sent === 1 ? "" : "s"} sent by PayPal.`;
  toast(`PayPal sent ${sent} approved reminder${sent === 1 ? "" : "s"}`);
  if (sent) confetti();
  loadInvoices();
}

function setupAutopilot() {
  $("#autopilotBtn").addEventListener("click", openAutopilot);
  $("#heroAutopilot").addEventListener("click", () => {
    $(".receivables").scrollIntoView({ behavior: "smooth" });
    openAutopilot();
  });
  $("#apClose").addEventListener("click", () => $("#autopilotDialog").close());
  $("#apSend").addEventListener("click", sendAutopilot);
  $("#apList").addEventListener("change", (e) => {
    const i = e.target.dataset.i;
    if (i !== undefined && e.target.type === "checkbox") {
      ap.items[i].include = e.target.checked;
      apRender();
    }
  });
  $("#apList").addEventListener("input", (e) => {
    const { i, f } = e.target.dataset;
    if (i !== undefined && f) ap.items[i][f] = e.target.value;
  });
}

// ---------------------------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------------------------
const SUGGESTIONS = ["Who should I chase first?", "How much is overdue, by currency?", "Which invoices are due this week?"];

function setupCopilot() {
  const wrap = $("#copilotSuggestions");
  for (const q of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sample-chip";
    b.textContent = q;
    b.addEventListener("click", () => {
      $("#copilotInput").value = q;
      ask(q);
    });
    wrap.append(b);
  }
  $("#copilotForm").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("#copilotInput").value);
  });
}

async function ask(question) {
  if (!question.trim()) return;
  const box = $("#copilotAnswer");
  box.hidden = false;
  box.innerHTML = `<div class="status" style="display:flex;gap:10px;align-items:center"><span class="spinner"></span> Reading your invoices in PayPal…</div>`;
  try {
    const { answer, actions } = await api("/api/copilot", { method: "POST", body: { question } });
    box.innerHTML = `<p>${esc(answer)}</p>${actions.length ? '<div class="actions"></div>' : ""}`;
    const bar = $(".actions", box);
    for (const a of actions) {
      const row = state.rows.find((r) => r.id === a.invoice_id);
      if (!row) continue;
      if (a.type === "remind") {
        const b = document.createElement("button");
        b.className = "btn primary small";
        b.innerHTML = `${icon.bell} ${esc(a.label)}`;
        b.addEventListener("click", () => openNudge(row, a.tone === "none" ? "friendly" : a.tone));
        bar.append(b);
      } else if (row.payerUrl) {
        const l = document.createElement("a");
        l.className = "btn ghost small";
        l.href = new URL(row.payerUrl, location.origin).href;
        l.target = "_blank";
        l.rel = "noopener";
        l.innerHTML = `${icon.external} ${esc(a.label)}`;
        bar.append(l);
      }
    }
  } catch (err) {
    box.innerHTML = `<p>${esc(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------------------------
// Nudge dialog: the AI writes the reminder, the user approves, PayPal sends it
// ---------------------------------------------------------------------------------------------
let nudgeRequest = 0;

function openNudge(row, tone = "friendly") {
  state.nudge = { row };
  $("#nudgeTitle").textContent = `Nudge ${row.client}`;
  const when = row.daysOverdue > 0 ? `${row.daysOverdue} days overdue` : row.dueDate ? `due ${fmtDate(row.dueDate)}` : "open";
  const history = row.reminderHistory ? ` · last reminder ${row.reminderHistory.status === "sent" ? "sent" : "unconfirmed"} ${fmtDate(row.reminderHistory.at.slice(0, 10))}` : "";
  $("#nudgeMeta").textContent = `Invoice #${row.number} · ${fmt(row.due, row.currency)} · ${when} · written in ${row.language}${history}`;
  $(`#nudgeForm input[name=tone][value=${tone}]`).checked = true;
  $("#nudgeDialog").showModal();
  writeNudge();
}

async function writeNudge() {
  const id = ++nudgeRequest;
  const tone = $("#nudgeForm input[name=tone]:checked").value;
  const subject = $("#nudgeSubject");
  const note = $("#nudgeNote");
  for (const el of [subject, note]) {
    el.value = "";
    el.disabled = true;
    el.classList.add("loading");
  }
  note.placeholder = "The AI is writing the reminder…";
  $("#sendNudgeBtn").disabled = true;
  try {
    const r = await api(`/api/invoices/${encodeURIComponent(state.nudge.row.id)}/reminder-draft`, { method: "POST", body: { tone } });
    if (id !== nudgeRequest) return;
    subject.value = r.subject;
    note.value = r.note;
  } catch (err) {
    if (id !== nudgeRequest) return;
    toast(err.message, "error");
  } finally {
    if (id === nudgeRequest) {
      for (const el of [subject, note]) {
        el.disabled = false;
        el.classList.remove("loading");
      }
      note.placeholder = "";
      $("#sendNudgeBtn").disabled = false;
    }
  }
}

function setupNudge() {
  $("#nudgeForm").addEventListener("change", (e) => {
    if (e.target.name === "tone") writeNudge();
  });
  $("#regenBtn").addEventListener("click", writeNudge);
  $("#sendNudgeBtn").addEventListener("click", async () => {
    const btn = $("#sendNudgeBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const row = state.nudge.row;
      await sendReviewedReminder(row, $("#nudgeSubject").value, $("#nudgeNote").value);
      $("#nudgeDialog").close();
      toast(`Reminder sent via PayPal${row.email ? ` to ${row.email}` : ""}`);
      loadInvoices();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send reminder via PayPal";
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
renderEmpty();
setupComposer();
setupDraftEvents();
setupCopilot();
setupNudge();
setupAutopilot();
setupGrid();
$("#planBody").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-plan-id]");
  const row = button && state.rows.find((r) => r.id === button.dataset.planId);
  if (row) openNudge(row, toneFor(row));
});
$("#planSelect").addEventListener("click", () => {
  if (!state.grid || !state.planIds.length) return;
  state.agingBucket = null;
  state.grid.onFilterChanged();
  $("#gridSearch").value = "";
  state.grid.setGridOption("quickFilterText", "");
  state.grid.deselectAll();
  for (const id of state.planIds) state.grid.getRowNode(id)?.setSelected(true);
  renderAging(state.rows);
  $("#gridGuidance").textContent = `${state.planIds.length} plan invoices selected. Choose Prepare reminders to review their messages.`;
  $("#grid").scrollIntoView({ behavior: "smooth", block: "center" });
});
try {
  const pending = JSON.parse(sessionStorage.getItem("paynudge.pendingInvoice") || "null");
  if (pending?.operationId && pending?.draft) {
    state.pendingInvoice = pending;
    state.draft = structuredClone(pending.draft);
    renderDraft();
    showPendingInvoice();
  }
} catch { sessionStorage.removeItem("paynudge.pendingInvoice"); }
$("#heroTry").addEventListener("click", () => {
  const sample = state.samples[0];
  if (sample) {
    $("#chatInput").value = sample.text;
    state.images = [];
    renderThumbs();
  }
  $(".create").scrollIntoView({ behavior: "smooth", block: "start" });
  if (sample) setTimeout(extract, 450);
});
await loadStatus().catch((e) => toast(e.message, "error"));
loadSamples();
loadInvoices();
// Poll PayPal every 15 s, or every 4 s while waiting for a payment after sending an invoice.
let lastPoll = Date.now();
setInterval(() => {
  const busy = $("#nudgeDialog").open || $("#autopilotDialog").open;
  const every = Date.now() < state.watchUntil ? 4000 : 15000;
  if (document.visibilityState === "visible" && !busy && Date.now() - lastPoll >= every) {
    lastPoll = Date.now();
    loadInvoices();
  }
}, 1000);
setInterval(() => $$("#activityFeed time").forEach((t) => (t.textContent = timeAgo(t.getAttribute("datetime")))), 30000);
