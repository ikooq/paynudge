import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describeWebhookEvent } from "../src/webhook-events.js";
import { detectPayments, listActivity, logEvent } from "../src/activity.js";

test("payment webhook is described as activity, not proof of full settlement", () => {
  const event = { event_type: "INVOICING.INVOICE.PAID", resource: { id: "INV2-PARTIAL", detail: { invoice_number: "42" }, amount: { value: "100.00", currency_code: "USD" } } };
  const result = describeWebhookEvent(event);
  assert.match(result.text, /payment activity/);
  assert.doesNotMatch(result.text, /100\.00|fully paid|confirmed payment/i);
  assert.equal(result.invoiceId, "INV2-PARTIAL");
});

test("earlier webhook activity does not hide later partial payments", () => {
  const row = { id: "INV2-MULTI", number: "42", client: "Client", currency: "USD", amount: 100, paid: 0, status: "SENT" };
  detectPayments([row]);
  logEvent("paypal", "PayPal reported payment activity", { invoiceId: row.id, viaWebhook: true });
  detectPayments([{ ...row, paid: 30, status: "PARTIALLY_PAID" }]);
  detectPayments([{ ...row, paid: 60, status: "PARTIALLY_PAID" }]);
  assert.equal(listActivity([]).filter((entry) => entry.invoiceId === row.id && entry.kind === "payment").length, 2);
});

// Without PayPal credentials and a webhook ID the endpoint must refuse to act on anything.
test("webhook endpoint refuses deliveries when webhooks are not configured", async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["server.js", "--demo"], { env: { ...process.env, PORT: String(port), PAYPAL_WEBHOOK_ID: "" }, stdio: "ignore" });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  // Up to 20 s: the first run after a clean install starts Node and loads modules cold.
  for (let i = 0; i < 400 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/status`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(ready, "server should start");
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.paypal.webhooks, false);
  const fake = { event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-FAKE", detail: { invoice_number: "9999" } } } };
  const res = await fetch(`${base}/api/paypal/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fake) });
  assert.equal(res.status, 503);
  const feed = await (await fetch(`${base}/api/activity`)).json();
  assert.ok(!feed.some((e) => e.text.includes("9999")), "an unverified webhook must not reach the activity feed");
});
