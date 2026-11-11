// In-memory agent activity log, plus payment detection between dashboard refreshes.
// PayPal stays the source of truth; this only remembers what PayNudge did and noticed.

const MAX = 60;
const events = [];
let lastStatuses = null; // id -> { paid, status }

// kind: "ai" | "paypal" | "payment" | "agent"
export function logEvent(kind, text, meta = {}) {
  events.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), kind, text, ...meta });
  if (events.length > MAX) events.length = MAX;
}

const PAID = new Set(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"]);

// Compares the new rows with the previous refresh and logs payments that just happened.
export function detectPayments(rows) {
  const current = new Map(rows.map((r) => [r.id, { paid: r.paid, status: r.status }]));
  if (lastStatuses) {
    for (const r of rows) {
      const before = lastStatuses.get(r.id);
      if (!before) continue;
      const nowPaid = PAID.has(r.status) && !PAID.has(before.status);
      const partial = r.paid > before.paid && !nowPaid;
      if (nowPaid || partial) {
        const amount = r.paid - before.paid || r.amount;
        logEvent("payment", `${r.client} paid ${amount.toFixed(2)} ${r.currency} for invoice #${r.number}`, { invoiceId: r.id });
      }
    }
  }
  lastStatuses = current;
}

// Older history, derived from PayPal itself, so the feed is never empty after a restart.
function derived(rows) {
  const out = [];
  for (const r of rows) {
    // first_sent_time when PayPal reports it; otherwise the invoice date (reminders move last_sent_time).
    const at = r.firstSent || (r.invoiceDate ? `${r.invoiceDate}T09:00:00Z` : "");
    if (at && r.status !== "DRAFT") {
      out.push({ id: `sent-${r.id}`, at, kind: "paypal", text: `PayPal sent invoice #${r.number} to ${r.client}`, invoiceId: r.id });
    }
  }
  return out;
}

// Live updates for open dashboards (Server-Sent Events): a webhook pushes, the page refreshes.
const listeners = new Set();
export function subscribe(send) {
  listeners.add(send);
  return () => listeners.delete(send);
}
export function broadcast(message) {
  for (const send of listeners) send(message);
}

export function listActivity(rows = []) {
  const sentLogged = new Set(events.filter((e) => e.sent).map((e) => e.invoiceId));
  const old = derived(rows).filter((e) => !sentLogged.has(e.invoiceId));
  return [...events, ...old].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
}
