// Collection metrics computed from the seller's own PayPal invoices (and PayNudge's reminder
// journal). They describe this seller's history only; with few invoices they are anecdotes, and
// the dashboard shows the sample size next to every number.
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const add = (totals, currency, value) => { totals[currency] = round2((totals[currency] || 0) + value); };

// Only invoices paid through PayPal count towards speed: seller-recorded payments have no reliable date.
export function computeMetrics(rows, reminders = {}) {
  const paid = rows.filter((r) => r.status === "PAID" && r.paidAt && r.invoiceDate);
  const toPay = paid.map((r) => Math.max(0, days(r.invoiceDate, r.paidAt)));
  const withDue = paid.filter((r) => r.dueDate);
  const onTime = withDue.filter((r) => r.paidAt <= r.dueDate).length;

  const planRows = rows.filter((r) => r.hadPlan);
  const planCollected = {};
  for (const r of planRows) if (r.paid > 0) add(planCollected, r.currency, r.paid);

  const reminded = rows.filter((r) => reminders[r.id]?.status === "sent");
  const paidAfterReminder = reminded.filter((r) => r.firstPaymentAt && r.firstPaymentAt >= String(reminders[r.id].at).slice(0, 10));

  const overdue = {};
  for (const r of rows) if (r.daysOverdue > 0 && r.due > 0) add(overdue, r.currency, r.due);

  return {
    paidViaPayPal: paid.length,
    medianDaysToPay: toPay.length ? median(toPay) : null,
    averageDaysToPay: toPay.length ? round1(toPay.reduce((a, b) => a + b, 0) / toPay.length) : null,
    paidOnTime: withDue.length ? { count: onTime, of: withDue.length } : null,
    plansOffered: planRows.length,
    plansPaidInFull: planRows.filter((r) => r.status === "PAID" || (r.due === 0 && r.paid > 0)).length,
    planCollected,
    remindersSent: reminded.length,
    paidAfterReminder: paidAfterReminder.length,
    overdue,
  };
}
