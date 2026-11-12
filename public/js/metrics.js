import { $, api, esc, fmtTotals } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Collection metrics: how fast clients pay and what reminders and payment plans brought in,
// computed from the seller's own PayPal invoices. Every number shows its sample size.
// ---------------------------------------------------------------------------------------------
const tile = (label, value, basis) => `<div class="metric"><span>${esc(label)}</span><strong>${value}</strong><small>${esc(basis)}</small></div>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function loadMetrics() {
  const body = $("#metricsBody");
  if (!body) return;
  let m;
  try {
    m = await api("/api/metrics");
  } catch (err) {
    body.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  const none = "—";
  const totals = (map) => {
    if (!Object.values(map).some((v) => v > 0)) return none;
    const t = fmtTotals(map);
    return t.extra ? `${t.main} <small>${t.extra}</small>` : t.main;
  };
  body.innerHTML = [
    tile("Median days to pay", m.medianDaysToPay ?? none, m.paidViaPayPal ? `invoice date to PayPal payment · ${plural(m.paidViaPayPal, "invoice")}` : "no invoice paid through PayPal yet"),
    tile("Paid by the due date", m.paidOnTime ? `${m.paidOnTime.count} of ${m.paidOnTime.of}` : none, "invoices paid through PayPal with a due date"),
    tile("Collected on payment plans", totals(m.planCollected), `${plural(m.plansOffered, "plan")} offered · ${m.plansPaidInFull} paid in full`),
    tile("Paid after a reminder", m.remindersSent ? `${m.paidAfterReminder} of ${m.remindersSent}` : none, "reminders sent from PayNudge, then any payment"),
    tile("Overdue now", totals(m.overdue), "open balances past their due date"),
  ].join("");
}
