import { $, $$, api, esc, fmt, fmtDate, icon, state, toast } from "./helpers.js";
import { renderThumbs } from "./composer.js";
import { confetti } from "./celebrate.js";
import { loadInvoices } from "./tabs.js";

// ---------------------------------------------------------------------------------------------
// Draft card
// ---------------------------------------------------------------------------------------------
export function renderEmpty() {
  $("#draftBody").innerHTML = `
    <div class="empty">
      <div class="glyph">${icon.doc}</div>
      <div><b>Your AI draft appears here</b><br>The AI pulls out the client, line items, currency and due date.<br>Every field stays editable before anything is sent.</div>
    </div>`;
}

export let thinkingTimer;
export function renderThinking() {
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

export async function extract() {
  if (state.pendingInvoice) return toast("Resolve the pending invoice before creating another draft.", "error");
  const text = $("#chatInput").value;
  if (!text.trim() && !state.images.length) {
    toast("Paste a conversation or add a screenshot first.", "error");
    return;
  }
  state.draftStartedAt = Date.now(); // for the real-use "chat to sent invoice" time
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

export function lineTotal(it) {
  return (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
}

export function draftTotal() {
  return state.draft.items.reduce((s, it) => s + lineTotal(it), 0);
}

export function renderDraft() {
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
        ${it.catalog ? `<small class="item-catalog">${it.price_source === "catalog" ? "Price from your price list" : "Matches your price list"}: ${esc(it.catalog.name)} · ${fmt(it.catalog.price, d.currency)}${it.price_source !== "catalog" && Number(it.unit_price) !== it.catalog.price ? " (differs from the chat)" : ""}</small>` : ""}
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

export function updateSendHint() {
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

export function setupDraftEvents() {
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
      delete it.catalog;
      delete it.price_source;
      $(".item-catalog", row)?.remove();
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


export function showPendingInvoice() {
  $("#draftBody").querySelectorAll("input, textarea, button").forEach((el) => { if (!["sendBtn", "discardPending"].includes(el.id)) el.disabled = true; });
  updateSendHint();
  if (!$("#discardPending")) $("#sendHint").insertAdjacentHTML("afterend", '<button type="button" class="btn ghost small" id="discardPending">I checked PayPal; start over</button>');
}

export async function sendInvoice() {
  const d = state.draft;
  if (!d.items.length || draftTotal() <= 0) return toast("Add at least one line item with a price.", "error");
  if (d.client.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.client.email)) return toast("That email doesn't look right.", "error");
  if (!d.due_date && !d.due_on_receipt) return toast("Choose a due date or confirm payment is due on receipt.", "error");
  const btn = $("#sendBtn");
  if (!state.pendingInvoice) {
    const seconds = state.draftStartedAt ? Math.round((Date.now() - state.draftStartedAt) / 1000) : null;
    state.pendingInvoice = { operationId: crypto.randomUUID(), draft: structuredClone(d), timing: { channel: "web", seconds } };
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

export function renderSuccess(row, payerUrl, emailed) {
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
