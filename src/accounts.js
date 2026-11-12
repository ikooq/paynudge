// Per-seller PayPal accounts through PayPal partner onboarding (Partner Referrals API v2).
// A seller clicks "Connect PayPal", signs in on PayPal and grants this app permission to manage
// invoices. PayPal sends them back with a tracking ID we issued; we confirm the merchant ID with
// PayPal (never trusting the redirect's query string alone) and keep a signed session cookie.
// Without a connected account, a visitor uses the shared demo seller.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { store } from "./store.js";

const env = process.env;
export const partnerId = env.PAYPAL_PARTNER_MERCHANT_ID || "";
export const canConnect = () => Boolean(config.paypal.live && partnerId);
const COOKIE = "pn_seller";
const MAX_AGE = 30 * 86400;
const secret = env.SESSION_SECRET || createHash("sha256").update(`paynudge-session:${config.paypal.clientSecret || "demo"}`).digest("hex");

const sign = (value) => createHmac("sha256", secret).update(value).digest("base64url");

export function sessionCookie(merchantId) {
  const value = `${merchantId}.${sign(merchantId)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${env.RENDER === "true" ? "; Secure" : ""}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// Returns the connected seller for a request's cookie, or null.
export function sellerFromCookie(header) {
  const raw = String(header || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  const merchantId = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(merchantId));
  if (dot < 1 || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const record = store.get("sellers", merchantId);
  return record ? { id: `pp:${merchantId}`, merchantId, name: record.name, email: record.email } : null;
}

// Step 1: ask PayPal for an onboarding link that grants invoice permissions to this app.
export async function startOnboarding(paypal, returnBase) {
  if (!canConnect()) throw Object.assign(new Error("Connecting a PayPal account needs the live sandbox API and PAYPAL_PARTNER_MERCHANT_ID on this server."), { status: 503 });
  const trackingId = `pn-${randomBytes(12).toString("hex")}`;
  await store.set("onboarding", trackingId, { created: Date.now() });
  const result = await paypal.request("/v2/customer/partner-referrals", {
    method: "POST",
    asPartner: true,
    body: {
      tracking_id: trackingId,
      operations: [{
        operation: "API_INTEGRATION",
        api_integration_preference: { rest_api_integration: { integration_method: "PAYPAL", integration_type: "THIRD_PARTY", third_party_details: { features: ["INVOICE_READ_WRITE", "ACCESS_MERCHANT_INFORMATION"] } } },
      }],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      partner_config_override: { return_url: `${returnBase.replace(/\/$/, "")}/api/account/return?tracking=${trackingId}`, return_url_description: "Back to PayNudge" },
    },
  });
  const url = result?.links?.find((l) => l.rel === "action_url")?.href;
  if (!url) throw new Error("PayPal did not return an onboarding link.");
  return url;
}

// Step 2: PayPal redirected the seller back. Confirm with PayPal which merchant completed our
// tracking ID and that invoice permissions were granted, then remember the seller.
export async function finishOnboarding(paypal, trackingId) {
  const pending = store.get("onboarding", trackingId);
  if (!pending || Date.now() - pending.created > 3600_000) throw Object.assign(new Error("This connection link expired. Start again from PayNudge."), { status: 400 });
  const lookup = await paypal.request(`/v1/customer/partners/${encodeURIComponent(partnerId)}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`, { asPartner: true });
  const merchantId = lookup?.merchant_id;
  if (!merchantId) throw Object.assign(new Error("PayPal hasn't confirmed the connection yet. Finish the steps on PayPal, then try again."), { status: 409 });
  const status = await paypal.request(`/v1/customer/partners/${encodeURIComponent(partnerId)}/merchant-integrations/${encodeURIComponent(merchantId)}`, { asPartner: true });
  const granted = (status?.oauth_integrations || []).flatMap((o) => (o.oauth_third_party || []).flatMap((t) => t.scopes || []));
  if (!granted.some((s) => /invoic/i.test(s))) throw Object.assign(new Error("Invoice permission wasn't granted on PayPal, so PayNudge can't create invoices for this account."), { status: 403 });
  await store.delete("onboarding", trackingId);
  const previous = store.get("sellers", merchantId);
  const record = { merchantId, email: status?.primary_email || previous?.email || "", name: previous?.name || status?.primary_email || "My business", connectedAt: previous?.connectedAt || new Date().toISOString() };
  await store.set("sellers", merchantId, record);
  return record;
}

export async function renameSeller(merchantId, name) {
  const record = store.get("sellers", merchantId);
  const clean = String(name || "").trim().slice(0, 100);
  if (!record) throw Object.assign(new Error("Connect a PayPal account first."), { status: 400 });
  if (!clean) throw Object.assign(new Error("Enter the business name clients should see."), { status: 400 });
  return store.set("sellers", merchantId, { ...record, name: clean });
}

export function sellerRecord(sellerId) {
  return sellerId?.startsWith("pp:") ? store.get("sellers", sellerId.slice(3)) : null;
}
