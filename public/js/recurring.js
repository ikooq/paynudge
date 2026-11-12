import { $, api, esc, fmt, fmtDate, toast } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Recurring invoices for regular clients. PayNudge keeps the schedule; each due invoice shows up
// in Today's approvals and is only created and sent after the seller approves it.
// ---------------------------------------------------------------------------------------------
let schedules = [];
const tomorrow = () => new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

function listHtml() {
  if (!schedules.length) return `<p class="muted">No recurring invoices yet.</p>`;
  return schedules
    .map((s) => `<div class="settings-card" data-id="${esc(s.id)}">
      <div class="row"><h4>${esc(s.client.business_name || s.client.name)}</h4><span class="muted">${esc(s.client.email)}</span></div>
      <p class="muted">${fmt(s.total, s.currency)} ${esc(s.interval)} · ${s.active ? `next invoice ${fmtDate(s.nextDate)}` : "paused"} · due ${s.dueInDays ? `${s.dueInDays} days after sending` : "on receipt"}${s.issued?.length ? ` · ${s.issued.length} sent so far` : ""}</p>
      <div class="row">
        <button class="btn ghost" type="button" data-toggle>${s.active ? "Pause" : "Resume"}</button>
        <button class="btn ghost" type="button" data-delete>Delete</button>
      </div>
    </div>`)
    .join("");
}

function formHtml() {
  return `<form class="settings-card rec-form" id="recForm" novalidate>
    <h4>New recurring invoice</h4>
    <div class="rec-grid">
      <label class="field"><span>Client name</span><input name="name" maxlength="120" autocomplete="off"></label>
      <label class="field"><span>Business</span><input name="business_name" maxlength="120" autocomplete="off"></label>
      <label class="field rec-wide"><span>Client email <em class="muted">PayPal emails each invoice here</em></span><input name="email" type="email" maxlength="200" autocomplete="off"></label>
      <label class="field rec-wide"><span>Item</span><input name="item" maxlength="200" placeholder="Monthly website maintenance"></label>
      <label class="field"><span>Price</span><input name="price" type="number" min="0" step="0.01"></label>
      <label class="field"><span>Currency</span><input name="currency" value="USD" maxlength="3"></label>
      <label class="field"><span>Repeat</span><select name="interval"><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></label>
      <label class="field"><span>Next invoice on</span><input name="nextDate" type="date" value="${tomorrow()}"></label>
      <label class="field"><span>Payment due <em class="muted">days after sending</em></span><input name="dueInDays" type="number" min="0" max="90" value="7"></label>
      <label class="field rec-wide"><span>Note to the client <em class="muted">optional</em></span><input name="note" maxlength="1000"></label>
    </div>
    <div class="rec-actions"><span class="muted">Each invoice waits in Today's approvals until you approve it.</span><span class="spacer"></span><button class="btn primary" type="submit">Save recurring invoice</button></div>
  </form>`;
}

function draw(panel) {
  panel.innerHTML = `<p class="muted">For regular clients: retainers, subscriptions, weekly services. On the due date the invoice appears in Today's approvals; PayPal sends it only after you approve.</p>
    <div class="rec-list">${listHtml()}</div>${formHtml()}`;
  $("#recForm", panel).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      client: { name: f.get("name"), business_name: f.get("business_name"), email: f.get("email") },
      items: [{ name: f.get("item"), quantity: 1, unit_price: Number(f.get("price")) }],
      currency: String(f.get("currency")).toUpperCase(),
      interval: f.get("interval"),
      nextDate: f.get("nextDate"),
      dueInDays: Number(f.get("dueInDays")),
      note: f.get("note"),
    };
    const button = $("button[type=submit]", e.currentTarget);
    button.disabled = true;
    try {
      const { schedule } = await api("/api/recurring", { method: "POST", body });
      schedules.push(schedule);
      draw(panel);
      toast(`Recurring invoice saved. The next one waits for your approval on ${fmtDate(schedule.nextDate)}.`, "ok");
    } catch (err) {
      toast(err.message, "error");
      button.disabled = false;
    }
  });
  $(".rec-list", panel).addEventListener("click", async (e) => {
    const card = e.target.closest("[data-id]");
    const s = card && schedules.find((x) => x.id === card.dataset.id);
    if (!s) return;
    try {
      if (e.target.closest("[data-toggle]")) {
        Object.assign(s, (await api(`/api/recurring/${encodeURIComponent(s.id)}/active`, { method: "POST", body: { active: !s.active } })).schedule);
      } else if (e.target.closest("[data-delete]")) {
        if (!confirm(`Delete the recurring invoice for ${s.client.business_name || s.client.name}? Invoices already sent stay in PayPal.`)) return;
        await api(`/api/recurring/${encodeURIComponent(s.id)}`, { method: "DELETE" });
        schedules = schedules.filter((x) => x.id !== s.id);
      } else return;
      draw(panel);
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

export async function renderRecurring(panel) {
  panel.innerHTML = `<p class="muted">Loading recurring invoices…</p>`;
  try {
    schedules = (await api("/api/recurring")).items;
  } catch (err) {
    panel.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  draw(panel);
}
