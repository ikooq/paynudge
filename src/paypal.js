// Thin client for the PayPal Invoicing API v2 (sandbox by default).
// Docs: https://developer.paypal.com/docs/api/invoicing/v2/
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const { baseUrl, clientId, clientSecret } = config.paypal;

export class PayPalError extends Error {
  constructor(status, body) {
    const detail = body?.details?.map((d) => d.description || d.issue).filter(Boolean).join("; ");
    super(detail || body?.message || body?.error_description || `PayPal request failed (${status})`);
    this.status = status;
    this.body = body;
    this.debugId = body?.debug_id;
  }
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    // PayPal reuses a cached token for up to 9 hours; ignoreCache makes it include
    // features (like Invoicing) that were enabled on the app after that token was issued.
    body: "grant_type=client_credentials&ignoreCache=true",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, body);
  cachedToken = body.access_token;
  tokenExpiresAt = Date.now() + body.expires_in * 1000;
  return cachedToken;
}

async function request(path, { method = "GET", body, headers = {} } = {}) {
  const token = await getAccessToken();
  const res = await fetch(path.startsWith("http") ? path : `${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new PayPalError(res.status, json);
  return json;
}

export async function createDraftInvoice(invoice) {
  const created = await request("/v2/invoicing/invoices", {
    method: "POST",
    body: invoice,
    headers: { Prefer: "return=representation", "PayPal-Request-Id": randomUUID() },
  });
  // Some accounts ignore the Prefer header and return only a link to the new invoice.
  if (created?.id) return created;
  if (created?.href) return request(created.href);
  throw new Error("PayPal did not return the created invoice");
}

export async function sendInvoice(id, { subject, note, sendToRecipient = true } = {}) {
  const link = await request(`/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
    method: "POST",
    body: { subject, note, send_to_recipient: sendToRecipient, send_to_invoicer: false },
    headers: { "PayPal-Request-Id": randomUUID() },
  });
  return link?.href || null; // payer view URL
}

export async function getInvoice(id) {
  return request(`/v2/invoicing/invoices/${encodeURIComponent(id)}`);
}

export async function listInvoices() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const data = await request(`/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
    out.push(...(data?.items || []));
    if (!data?.total_pages || page >= data.total_pages) break;
  }
  return out;
}

export async function remindInvoice(id, { subject, note }) {
  await request(`/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
    method: "POST",
    body: { subject, note, send_to_recipient: true, send_to_invoicer: false },
    headers: { "PayPal-Request-Id": randomUUID() },
  });
}

// Records an off-PayPal payment (used by the demo seed script to create a "paid" invoice).
export async function recordPayment(id, { amount, currency, date, method = "BANK_TRANSFER", note }) {
  return request(`/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
    method: "POST",
    body: { method, payment_date: date, amount: { currency_code: currency, value: amount }, note },
    headers: { "PayPal-Request-Id": randomUUID() },
  });
}

export async function ping() {
  await getAccessToken();
  return true;
}
