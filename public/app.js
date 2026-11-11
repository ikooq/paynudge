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

const state = { images: [], draft: null, rows: [], status: null, nudge: null, grid: null };

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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
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
}

async function loadSamples() {
  const samples = await api("/api/samples");
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
      <label class="field"><span>Terms</span><input data-field="payment_terms_label" value="${esc(d.payment_terms_label)}" placeholder="Due on receipt"></label>
    </div>
    <div class="items">
      <div class="items-head"><span>Item</span><span class="num">Qty</span><span class="num">Unit price</span><span class="num">Total</span><span></span></div>
      ${rows}
      <button class="add-line" type="button" id="addLine">+ Add line</button>
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
}

function updateSendHint() {
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
      else d[a] = a === "currency" ? t.value.toUpperCase() : t.value;
      if (t.dataset.field === "client.email") updateSendHint();
    }
    if (t.dataset.item) {
      const row = t.closest(".item-row");
      const it = d.items[Number(row.dataset.index)];
      it[t.dataset.item] = t.dataset.item === "name" ? t.value : Number(t.value);
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

async function sendInvoice() {
  const d = state.draft;
  if (!d.items.length || draftTotal() <= 0) return toast("Add at least one line item with a price.", "error");
  if (d.client.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.client.email)) return toast("That email doesn't look right.", "error");
  const btn = $("#sendBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Talking to PayPal…`;
  try {
    const { row, payerUrl, emailed } = await api("/api/invoices", { method: "POST", body: { draft: d } });
    renderSuccess(row, payerUrl, emailed);
    await loadInvoices({ flashId: row.id });
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
    updateSendHint();
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
      <p class="muted">PayNudge is now tracking it below and will suggest a nudge if it goes overdue.</p>
    </div>`;
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
    theme: gridTheme(),
    rowHeight: 60,
    headerHeight: 44,
    domLayout: "autoHeight",
    pagination: true,
    paginationPageSize: 10,
    paginationPageSizeSelector: [10, 25, 50],
    animateRows: true,
    getRowId: (p) => p.data.id,
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    overlayNoRowsTemplate: '<span class="muted">No invoices yet. Draft your first one above.</span>',
    loading: true,
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
    state.grid.setGridOption("theme", gridTheme()),
  );
  $("#gridSearch").addEventListener("input", (e) => state.grid.setGridOption("quickFilterText", e.target.value));
  $("#refreshBtn").addEventListener("click", () => loadInvoices({ announce: true }));
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

async function loadInvoices({ flashId, announce } = {}) {
  try {
    const data = await api("/api/invoices");
    state.rows = data.rows;
    renderKpis(data.kpis);
    if (state.grid) {
      state.grid.setGridOption("loading", false);
      state.grid.setGridOption("rowData", data.rows);
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
  $("#nudgeMeta").textContent = `Invoice #${row.number} · ${fmt(row.due, row.currency)} · ${when} · written in ${row.language}`;
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
      await api(`/api/invoices/${encodeURIComponent(row.id)}/remind`, {
        method: "POST",
        body: { subject: $("#nudgeSubject").value, note: $("#nudgeNote").value },
      });
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
setupGrid();
await loadStatus().catch((e) => toast(e.message, "error"));
loadSamples();
loadInvoices();
setInterval(() => {
  if (document.visibilityState === "visible" && !$("#nudgeDialog").open) loadInvoices();
}, 20000);
