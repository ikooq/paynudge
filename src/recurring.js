// Recurring invoices for regular clients (monthly retainers, weekly services). PayNudge keeps the
// schedule; when an invoice is due it appears in the daily approval queue, and the seller's approval
// creates and sends a normal PayPal invoice. Nothing is billed automatically.
import { randomUUID } from "node:crypto";
import { store } from "./store.js";
import { todayISO } from "./invoices.js";

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function addInterval(iso, interval) {
  const [y, m, d] = iso.split("-").map(Number);
  if (interval === "weekly") return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  // Monthly: same day next month, clamped to the month's last day (Jan 31 -> Feb 28).
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}

export function listRecurring(seller) {
  return store.get("recurring", seller) || [];
}

export function cleanSchedule(input, today = todayISO()) {
  const client = {
    name: String(input?.client?.name || "").trim().slice(0, 120),
    business_name: String(input?.client?.business_name || "").trim().slice(0, 120),
    email: String(input?.client?.email || "").trim().slice(0, 200),
  };
  if (!client.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email)) throw bad("Enter the client's email address; PayPal emails each invoice to it.");
  if (!client.name && !client.business_name) throw bad("Enter the client's name or business.");
  const currency = String(input?.currency || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw bad("Use a three-letter currency code such as USD.");
  const items = (Array.isArray(input?.items) ? input.items : []).map((it) => ({
    name: String(it?.name || "").trim().slice(0, 200),
    description: String(it?.description || "").trim().slice(0, 500),
    quantity: round2(it?.quantity || 1),
    unit_price: round2(it?.unit_price),
  })).filter((it) => it.name);
  if (!items.length) throw bad("Add at least one item.");
  if (items.some((it) => !(it.quantity > 0) || !(it.unit_price >= 0))) throw bad("Every item needs a quantity above 0 and a price of 0 or more.");
  const interval = input?.interval === "weekly" ? "weekly" : "monthly";
  const nextDate = String(input?.nextDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) || Number.isNaN(Date.parse(nextDate))) throw bad("Pick the date of the next invoice.");
  if (nextDate < today) throw bad("The next invoice date can't be in the past.");
  const dueInDays = Math.max(0, Math.min(90, Math.round(Number(input?.dueInDays ?? 7))));
  return {
    client, currency, items, interval, nextDate, dueInDays,
    note: String(input?.note || "").trim().slice(0, 1000),
    total: round2(items.reduce((s, it) => s + it.quantity * it.unit_price, 0)),
  };
}

export async function saveSchedule(seller, input, id) {
  const all = listRecurring(seller);
  const clean = cleanSchedule(input);
  let schedule;
  if (id) {
    const i = all.findIndex((s) => s.id === id);
    if (i < 0) throw Object.assign(new Error("That recurring invoice no longer exists."), { status: 404 });
    schedule = all[i] = { ...all[i], ...clean };
  } else {
    if (all.length >= 50) throw bad("You can keep up to 50 recurring invoices.");
    schedule = { id: randomUUID(), active: true, created: new Date().toISOString(), issued: [], ...clean };
    all.push(schedule);
  }
  await store.set("recurring", seller, all);
  return schedule;
}

export async function setActive(seller, id, active) {
  const all = listRecurring(seller);
  const s = all.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error("That recurring invoice no longer exists."), { status: 404 });
  s.active = Boolean(active);
  await store.set("recurring", seller, all);
  return s;
}

export async function deleteSchedule(seller, id) {
  await store.set("recurring", seller, listRecurring(seller).filter((s) => s.id !== id));
}

export function dueSchedules(seller, today = todayISO()) {
  return listRecurring(seller).filter((s) => s.active && s.nextDate <= today);
}

// The draft for one occurrence, in the shape POST /api/invoices expects.
export function scheduleDraft(s, today = todayISO()) {
  const due = new Date(Date.parse(`${today}T00:00:00Z`) + s.dueInDays * 86400_000).toISOString().slice(0, 10);
  return {
    client: s.client,
    currency: s.currency,
    items: s.items,
    due_date: s.dueInDays ? due : "",
    due_on_receipt: !s.dueInDays,
    payment_terms_label: s.dueInDays ? `Net ${s.dueInDays}` : "Due on receipt",
    note_to_client: s.note || `Thank you! This is your ${s.interval} invoice.`,
    summary: `Recurring ${s.interval} invoice (${s.nextDate}).`,
    conversation_language: "English",
  };
}

// Called after the seller approved and PayPal sent the invoice for `forDate`; idempotent per date.
export async function markIssued(seller, id, forDate, invoiceId) {
  const all = listRecurring(seller);
  const s = all.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error("That recurring invoice no longer exists."), { status: 404 });
  if (s.nextDate !== forDate) return s; // already advanced
  s.issued = [...(s.issued || []).slice(-23), { date: forDate, invoiceId: String(invoiceId || "").slice(0, 40) }];
  s.nextDate = addInterval(s.nextDate, s.interval);
  await store.set("recurring", seller, all);
  return s;
}
