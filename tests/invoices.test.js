import test from "node:test";
import assert from "node:assert/strict";
import { buildPayPalInvoice, toRow } from "../src/invoices.js";
import * as mock from "../src/mockPaypal.js";

const business = { name: "Studio", defaultCurrency: "USD" };
const draft = () => ({ client: { name: "Ada", email: "ada@example.com" }, currency: "USD", items: [{ name: "Design", quantity: 2, unit_price: 75 }], summary: "x".repeat(600), conversation_language: "Russian" });

test("invoice amounts and language survive conversion", () => {
  const { invoice, draft: normalized } = buildPayPalInvoice(draft(), business);
  assert.equal(normalized.total, 150);
  assert.equal(invoice.items[0].unit_amount.value, "75.00");
  assert.ok(invoice.detail.memo.length <= 500);
  assert.match(invoice.detail.memo, /Conversation language: Russian/);
});

test("unsafe dates and amounts are rejected instead of silently changed", () => {
  for (const value of ["2020-01-01", "2026-02-31", "not-a-date"]) {
    assert.throws(() => buildPayPalInvoice({ ...draft(), due_date: value }, business), /date/i);
  }
  for (const item of [
    { name: "Design", quantity: -1, unit_price: 50 },
    { name: "Design", quantity: 1, unit_price: -10 },
    { name: "Design", quantity: 1, unit_price: 0 },
    { name: "Design", quantity: 1, unit_price: 1.234 },
  ]) assert.throws(() => buildPayPalInvoice({ ...draft(), items: [item] }, business));
  assert.throws(() => buildPayPalInvoice({ ...draft(), currency: "JPY", items: [{ name: "Work", quantity: 1, unit_price: 1.5 }] }, business), /whole/);
});

test("retrying a demo invoice returns one invoice and can be paid", async () => {
  const payload = buildPayPalInvoice(draft(), business).invoice;
  const requestId = "test-operation";
  const first = await mock.createDraftInvoice(payload, { requestId });
  const second = await mock.createDraftInvoice(payload, { requestId });
  assert.equal(first.id, second.id);
  await mock.sendInvoice(first.id);
  await mock.markPaid(first.id);
  const row = toRow(await mock.getInvoice(first.id));
  assert.equal(row.status, "PAID");
  assert.equal(row.due, 0);
  assert.equal(row.paid, 150);
});
