// Daily approval queue. Each morning (or on demand) the agent prepares today's work: reminders for
// overdue invoices, payment-plan offers for long-overdue ones, and recurring invoices that are due.
// Nothing is sent here: the seller approves or skips each item, and approval goes through the same
// checked endpoints as the manual flows.
import { randomUUID } from "node:crypto";
import { store } from "./store.js";
import { todayISO, validatePlan } from "./invoices.js";

export const MAX_AI_ITEMS = 5;
const RECENT_MS = 3 * 86400_000;

export const toneForDays = (days) => (days > 21 ? "final" : days > 7 ? "firm" : "friendly");

export function queueKey(seller, date = todayISO()) {
  return `${seller}:${date}`;
}

export function getQueue(seller, date = todayISO()) {
  return store.get("queue", queueKey(seller, date));
}

function recentlyContacted(row, now) {
  const times = [row.reminderHistory?.at, row.lastSent].filter(Boolean).map((t) => Date.parse(t));
  return row.reminderHistory?.status === "pending" || times.some((t) => now - t < RECENT_MS);
}

// Overdue invoices worth acting on today, oldest first.
export function pickOverdue(rows, now = Date.now()) {
  return rows
    .filter((r) => r.daysOverdue > 0 && r.due > 0 && r.plan?.status !== "accepted" && !recentlyContacted(r, now))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export async function buildQueue({ seller, rows, recurringDue = [], ai, now = Date.now(), date = todayISO() }) {
  const items = [];
  const skipped = [];
  for (const row of pickOverdue(rows, now).slice(0, MAX_AI_ITEMS)) {
    const base = { id: randomUUID(), invoiceId: row.id, number: row.number, client: row.client, email: row.email, currency: row.currency, due: row.due, daysOverdue: row.daysOverdue, language: row.language, status: "pending" };
    try {
      if (row.daysOverdue > 21 && !row.plan) {
        const raw = await ai.proposePaymentPlan({ row });
        const installments = validatePlan(raw.installments, row.due, row.currency);
        items.push({ ...base, kind: "plan", subject: raw.subject, note: raw.note, installments, why: raw.rationale || "" });
        continue;
      }
    } catch {
      // A plan the model could not make add up falls back to a reminder below.
    }
    try {
      const tone = toneForDays(row.daysOverdue);
      const reminder = await ai.draftReminder({ row, tone });
      items.push({ ...base, kind: "reminder", tone, subject: reminder.subject, note: reminder.note });
    } catch (err) {
      skipped.push(`${row.client} (#${row.number}): ${err.message}`);
    }
  }
  for (const r of recurringDue) {
    items.push({ id: randomUUID(), kind: "recurring", recurringId: r.id, client: r.client.business_name || r.client.name || r.client.email, email: r.client.email, currency: r.currency, due: r.total, items: r.items, nextDate: r.nextDate, interval: r.interval, status: "pending" });
  }
  const queue = { date, builtAt: new Date(now).toISOString(), items, skipped };
  await store.set("queue", queueKey(seller, date), queue);
  return queue;
}

export async function markItem(seller, itemId, status, result = "") {
  const queue = getQueue(seller);
  const item = queue?.items.find((i) => i.id === itemId);
  if (!item) throw Object.assign(new Error("This approval item is not in today's queue. Refresh the queue."), { status: 404 });
  if (item.status !== "pending") throw Object.assign(new Error(`This item was already ${item.status}.`), { status: 409 });
  if (!["approved", "skipped", "failed"].includes(status)) throw Object.assign(new Error("Unknown status."), { status: 400 });
  item.status = status;
  item.result = String(result).slice(0, 300);
  item.at = new Date().toISOString();
  await store.set("queue", queueKey(seller), queue);
  return item;
}
