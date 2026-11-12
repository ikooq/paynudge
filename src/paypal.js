// Thin client for the PayPal Invoicing API v2 (sandbox by default).
// Docs: https://developer.paypal.com/docs/api/invoicing/v2/
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { currentSeller } from "./context.js";

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

// One cached token per PayPal app: the shared demo app, or a seller's own app (their keys).
const tokens = new Map(); // clientId -> { token, expiresAt }

export async function getAccessToken(creds = { clientId, clientSecret }) {
  const cached = tokens.get(creds.clientId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    // PayPal reuses a cached token for up to 9 hours; ignoreCache makes it include
    // features (like Invoicing) that were enabled on the app after that token was issued.
    body: "grant_type=client_credentials&ignoreCache=true",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, body);
  tokens.set(creds.clientId, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

// Asks PayPal whether a webhook delivery is genuine (POST /v1/notifications/verify-webhook-signature).
export async function verifyWebhookSignature(headers, event, webhookId) {
  const h = (name) => headers[name] || headers[name.toLowerCase()] || "";
  const result = await request("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return result?.verification_status === "SUCCESS";
}

// A connected seller (PayPal partner onboarding) is addressed with an unsigned auth assertion naming
// their merchant ID; PayPal checks that the seller granted this app permission for the call.
export function authAssertion(merchantId) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ iss: clientId, payer_id: merchantId })}.`;
}

export async function request(path, { method = "GET", body, headers = {}, asPartner = false } = {}) {
  // A seller who connected their own PayPal app is called with that app's token; a partner-onboarded
  // seller through this app with an auth assertion; everyone else as the shared demo seller.
  const seller = asPartner ? null : currentSeller();
  const token = await getAccessToken(seller?.credentials || undefined);
  const merchantId = seller && !seller.credentials ? seller.merchantId : "";
  if (merchantId) headers = { "PayPal-Auth-Assertion": authAssertion(merchantId), ...headers };
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

export async function createDraftInvoice(invoice, { requestId = randomUUID() } = {}) {
  const created = await request("/v2/invoicing/invoices", {
    method: "POST",
    body: invoice,
    headers: { Prefer: "return=representation", "PayPal-Request-Id": requestId },
  });
  // Some accounts ignore the Prefer header and return only a link to the new invoice.
  if (created?.id) return created;
  if (created?.href) return request(created.href);
  throw new Error("PayPal did not return the created invoice");
}

export async function sendInvoice(id, { subject, note, sendToRecipient = true, requestId = randomUUID() } = {}) {
  const link = await request(`/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
    method: "POST",
    body: { subject, note, send_to_recipient: sendToRecipient, send_to_invoicer: false },
    headers: { "PayPal-Request-Id": requestId },
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

// Full update (PUT): PayPal has no partial update for invoices, so we send the whole invoice back
// without its read-only parts. Used to turn on partial payments for a payment plan.
const READ_ONLY = ["status", "links", "due_amount", "gratuity", "payments", "refunds", "amount"];
export async function updateInvoice(invoice) {
  const body = structuredClone(invoice);
  for (const key of READ_ONLY) delete body[key];
  if (body.detail) delete body.detail.metadata;
  return request(`/v2/invoicing/invoices/${encodeURIComponent(invoice.id)}?send_to_recipient=false&send_to_invoicer=false`, {
    method: "PUT",
    body,
    headers: { Prefer: "return=representation", "PayPal-Request-Id": randomUUID() },
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
