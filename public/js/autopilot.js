import { $, api, esc, fmt, fmtDate, icon, recentReminder, sendReviewedReminder, state, toast } from "./helpers.js";
import { confetti } from "./celebrate.js";
import { loadInvoices, selectTab } from "./tabs.js";
import { BUCKETS, loadActivity } from "./insights.js";

// ---------------------------------------------------------------------------------------------
// Collections autopilot: the agent picks overdue invoices, drafts a reminder for each in the
// right tone and the client's language, and sends the approved ones through PayPal.
// ---------------------------------------------------------------------------------------------
export const toneFor = (r) => (r.daysOverdue > 21 ? "final" : r.daysOverdue > 7 ? "firm" : "friendly");
export const ap = { items: [], running: false };

export function apSteps(active) {
  const steps = ["Review ledger", "Pick tone & language", "Draft reminders", "Your approval", "Send via PayPal"];
  $("#apSteps").innerHTML = steps
    .map((s, i) => `<li class="${i < active ? "done" : i === active ? "active" : ""}">${i < active ? icon.check : i === active ? '<span class="spinner"></span>' : ""}${s}</li>`)
    .join("");
}

export function apCard(item, i) {
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

export function apRender() {
  $("#apList").innerHTML = ap.items.length
    ? ap.items.map(apCard).join("")
    : '<div class="ap-empty">🎉 Nothing is overdue. The agent has nobody to chase right now.</div>';
  const chosen = ap.items.filter((x) => x.include && x.status === "ready");
  const btn = $("#apSend");
  btn.disabled = ap.running || !chosen.length;
  btn.textContent = chosen.length ? `Approve & send ${chosen.length} reminder${chosen.length > 1 ? "s" : ""} via PayPal` : "Approve & send via PayPal";
}

export async function openAutopilot() {
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

export async function sendAutopilot() {
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

export function setupAutopilot() {
  $("#autopilotBtn").addEventListener("click", openAutopilot);
  $("#heroAutopilot").addEventListener("click", () => {
    selectTab("invoices");
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
