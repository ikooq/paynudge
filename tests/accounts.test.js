import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATABASE_URL = "";
process.env.STORE_FILE = path.join(await mkdtemp(path.join(tmpdir(), "paynudge-acct-")), "store.json");
process.env.PAYPAL_CLIENT_ID = "test-client";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNER1";
process.env.SESSION_SECRET = "test-session-secret";
const accounts = await import("../src/accounts.js");
const { runAsSeller } = await import("../src/context.js");
const { logEvent, listActivity } = await import("../src/activity.js");
const { authAssertion } = await import("../src/paypal.js");

function fakePayPal({ merchantId = "MERCHANT9", scopes = ["https://uri.paypal.com/services/invoicing"] } = {}) {
  const calls = [];
  return {
    calls,
    request: async (url, opts = {}) => {
      calls.push({ url, ...opts });
      if (url === "/v2/customer/partner-referrals") return { links: [{ rel: "action_url", href: "https://www.sandbox.paypal.com/bizsignup/xyz" }] };
      if (url.includes("merchant-integrations?tracking_id=")) return { merchant_id: merchantId };
      if (url.includes(`merchant-integrations/${merchantId}`)) return { primary_email: "seller@example.com", oauth_integrations: [{ oauth_third_party: [{ scopes }] }] };
      throw new Error(`unexpected ${url}`);
    },
  };
}

test("onboarding asks PayPal for invoice permission and confirms the merchant via the tracking ID", async () => {
  const paypal = fakePayPal();
  const url = await accounts.startOnboarding(paypal, "https://paynudge.example");
  assert.equal(url, "https://www.sandbox.paypal.com/bizsignup/xyz");
  const body = paypal.calls[0].body;
  assert.equal(paypal.calls[0].asPartner, true);
  assert.deepEqual(body.operations[0].api_integration_preference.rest_api_integration.third_party_details.features, ["INVOICE_READ_WRITE", "ACCESS_MERCHANT_INFORMATION"]);
  const tracking = body.tracking_id;
  assert.match(body.partner_config_override.return_url, new RegExp(`/api/account/return\\?tracking=${tracking}$`));
  const record = await accounts.finishOnboarding(paypal, tracking);
  assert.equal(record.merchantId, "MERCHANT9");
  assert.equal(record.email, "seller@example.com");
  await assert.rejects(accounts.finishOnboarding(paypal, tracking), /expired/, "a tracking ID works once");
  await assert.rejects(accounts.finishOnboarding(paypal, "pn-forged"), /expired/, "unknown tracking IDs are refused");
});

test("a seller who didn't grant invoice permission is not connected", async () => {
  const paypal = fakePayPal({ merchantId: "NOPERM", scopes: ["https://uri.paypal.com/services/payments/payment"] });
  await accounts.startOnboarding(paypal, "https://paynudge.example");
  await assert.rejects(accounts.finishOnboarding(paypal, paypal.calls[0].body.tracking_id), /Invoice permission/);
});

test("session cookies are signed; a forged or unknown merchant is ignored", () => {
  const cookie = accounts.sessionCookie("MERCHANT9").split(";")[0];
  assert.equal(accounts.sellerFromCookie(cookie).id, "pp:MERCHANT9");
  assert.equal(accounts.sellerFromCookie(cookie.replace("MERCHANT9", "OTHER")), null);
  assert.equal(accounts.sellerFromCookie(accounts.sessionCookie("NOT_STORED").split(";")[0]), null);
  assert.equal(accounts.sellerFromCookie("pn_seller=garbage"), null);
});

test("PayPal calls for a seller carry an auth assertion naming their merchant ID", () => {
  const [header, payload, sig] = authAssertion("MERCHANT9").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "none" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iss: "test-client", payer_id: "MERCHANT9" });
  assert.equal(sig, "");
});

test("the activity feed of one seller never shows another seller's events", () => {
  runAsSeller({ id: "pp:A", merchantId: "A" }, () => logEvent("agent", "only for A"));
  runAsSeller({ id: "pp:B", merchantId: "B" }, () => logEvent("agent", "only for B"));
  const a = runAsSeller({ id: "pp:A", merchantId: "A" }, () => listActivity([]).map((e) => e.text));
  assert.deepEqual(a, ["only for A"]);
  assert.deepEqual(listActivity([]).map((e) => e.text), [], "the shared demo seller sees neither");
});
