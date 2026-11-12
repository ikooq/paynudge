// In-memory stand-in for the PayPal Invoicing API, used when no sandbox credentials are set.
// It returns objects shaped like the real API so the rest of the app runs unchanged.
import { randomBytes } from "node:crypto";
import { todayISO } from "./invoices.js";

const invoices = new Map();
const creationRequests = new Map();
let counter = 41;

function shiftDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return todayISO(d);
}

function newId() {
  return "INV2-DEMO-" + randomBytes(4).toString("hex").toUpperCase();
}

function totals(items, currency) {
  const value = items.reduce((s, it) => s + Number(it.quantity) * Number(it.unit_amount.value), 0);
  return { currency_code: currency, value: value.toFixed(2) };
}

function store(inv) {
  invoices.set(inv.id, inv);
  return structuredClone(inv);
}

export async function createDraftInvoice(body, { requestId } = {}) {
  if (requestId && creationRequests.has(requestId)) return getInvoice(creationRequests.get(requestId));
  const id = newId();
  if (requestId) creationRequests.set(requestId, id);
  const currency = body.detail.currency_code;
  const amount = totals(body.items, currency);
  return store({
    id,
    status: "DRAFT",
    detail: {
      ...body.detail,
      invoice_number: String(++counter).padStart(4, "0"),
      invoice_date: todayISO(),
      payment_term: {
        ...body.detail.payment_term,
        due_date: body.detail.payment_term?.due_date || todayISO(),
      },
      metadata: { create_time: new Date().toISOString(), recipient_view_url: `/demo-pay/${id}` },
    },
    invoicer: body.invoicer,
    primary_recipients: body.primary_recipients,
    items: body.items,
    amount,
    due_amount: amount,
  });
}

export async function sendInvoice(id) {
  const inv = invoices.get(id);
  if (!inv) throw Object.assign(new Error("Invoice not found"), { status: 404 });
  inv.status = inv.primary_recipients?.[0]?.billing_info?.email_address ? "SENT" : "UNPAID";
  inv.detail.metadata.last_sent_time = new Date().toISOString();
  inv.detail.metadata.first_sent_time = inv.detail.metadata.last_sent_time;
  return inv.detail.metadata.recipient_view_url;
}

export async function getInvoice(id) {
  const inv = invoices.get(id);
  if (!inv) throw Object.assign(new Error("Invoice not found"), { status: 404 });
  return structuredClone(inv);
}

export async function listInvoices() {
  return [...invoices.values()].reverse().map((i) => structuredClone(i));
}

export async function remindInvoice(id) {
  const inv = invoices.get(id);
  if (!inv) throw Object.assign(new Error("Invoice not found"), { status: 404 });
  inv.detail.metadata.last_sent_time = new Date().toISOString();
}

// amount omitted = pay everything that is still due (a partial payment needs allow_partial_payment).
export async function markPaid(id, amount) {
  const inv = invoices.get(id);
  if (!inv) throw Object.assign(new Error("Invoice not found"), { status: 404 });
  const currency = inv.amount.currency_code;
  const total = Number(inv.amount.value);
  const already = Number(inv.payments?.paid_amount?.value || 0);
  const pay = amount === undefined ? total - already : Math.min(Number(amount), total - already);
  if (amount !== undefined && !inv.configuration?.partial_payment?.allow_partial_payment) {
    throw Object.assign(new Error("This invoice does not accept partial payments"), { status: 400 });
  }
  const paid = Math.round((already + pay) * 100) / 100;
  const transactions = [...(inv.payments?.transactions || []), { payment_date: new Date().toISOString().slice(0, 10), amount: { currency_code: currency, value: pay.toFixed(2) } }];
  inv.payments = { paid_amount: { currency_code: currency, value: paid.toFixed(2) }, transactions };
  inv.due_amount = { currency_code: currency, value: Math.max(0, total - paid).toFixed(2) };
  inv.status = total - paid < 0.005 ? "PAID" : "PARTIALLY_PAID";
}

// Mirrors PayPal's full update (PUT): replaces the editable parts of the invoice.
export async function updateInvoice(body) {
  const inv = invoices.get(body.id);
  if (!inv) throw Object.assign(new Error("Invoice not found"), { status: 404 });
  inv.detail = { ...inv.detail, ...body.detail, metadata: inv.detail.metadata };
  inv.configuration = structuredClone(body.configuration || {});
  return structuredClone(inv);
}

export async function ping() {
  return true;
}

// Seed a few receivables so the dashboard is not empty in demo mode.
function seed(client, email, lang, memo, currency, items, invoiceDaysAgo, dueInDays, status) {
  const id = newId();
  const lineItems = items.map(([name, quantity, price]) => ({
    name,
    quantity: String(quantity),
    unit_amount: { currency_code: currency, value: price.toFixed(2) },
  }));
  const amount = totals(lineItems, currency);
  const paid = status === "PAID" || status === "MARKED_AS_PAID";
  const [given, ...rest] = client.contact.split(" ");
  invoices.set(id, {
    id,
    status,
    detail: {
      currency_code: currency,
      invoice_number: String(++counter).padStart(4, "0"),
      invoice_date: shiftDays(-invoiceDaysAgo),
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: shiftDays(dueInDays) },
      memo: `PayNudge memo: ${memo}\nConversation language: ${lang}`,
      metadata: { recipient_view_url: `/demo-pay/${id}`, last_sent_time: new Date(Date.now() - invoiceDaysAgo * 86_400_000).toISOString() },
    },
    primary_recipients: [
      { billing_info: { business_name: client.business, name: { given_name: given, surname: rest.join(" ") }, email_address: email } },
    ],
    items: lineItems,
    amount,
    due_amount: paid ? { currency_code: currency, value: "0.00" } : amount,
    ...(paid ? { payments: { paid_amount: amount, transactions: [{ payment_date: shiftDays(-Math.max(0, invoiceDaysAgo - 9)), amount }] } } : {}),
  });
}

seed({ business: "Northwind Labs", contact: "Sam Patel" }, "sam@northwind.dev", "English",
  "Landing page redesign and two A/B variants; relaxed, long-term client.", "USD",
  [["Landing page redesign", 1, 1200], ["A/B test variant", 2, 150]], 34, -26, "SENT");
seed({ business: "Kafe Arman", contact: "Arman Bekov" }, "arman@kafearman.kz", "Russian",
  "Menu photography and retouching for a cafe in Almaty; friendly, informal.", "USD",
  [["Menu photography", 18, 20], ["Retouching", 18, 5]], 19, -12, "SENT");
seed({ business: "Atelier Rosa", contact: "Rosa Martín" }, "rosa@atelierrosa.es", "Spanish",
  "Brand guidelines document; formal tone.", "EUR",
  [["Brand guidelines", 1, 600]], 12, -3, "SENT");
seed({ business: "Pixel & Pine", contact: "Jordan Lee" }, "jordan@pixelpine.io", "English",
  "Monthly social media retainer for October.", "USD",
  [["Social media retainer (October)", 1, 800]], 20, -6, "MARKED_AS_PAID"); // like the sandbox seed: recorded, not paid via PayPal
seed({ business: "Helio Studio", contact: "Mira Novak" }, "mira@heliostudio.co", "English",
  "Explainer video storyboard; quick, friendly communication.", "USD",
  [["Storyboard frames", 12, 35], ["Script polish", 1, 90]], 3, 11, "SENT");
