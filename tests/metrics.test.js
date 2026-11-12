import test from "node:test";
import assert from "node:assert/strict";
import { computeMetrics } from "../src/metrics.js";
import { toRow } from "../src/invoices.js";

test("payment dates come from PayPal's payment transactions", () => {
  const row = toRow({
    id: "I1", status: "PAID",
    detail: { invoice_number: "1", invoice_date: "2026-11-01", payment_term: { due_date: "2026-11-08" }, memo: "" },
    amount: { currency_code: "USD", value: "100.00" }, due_amount: { currency_code: "USD", value: "0.00" },
    payments: { paid_amount: { currency_code: "USD", value: "100.00" }, transactions: [{ payment_date: "2026-11-05" }, { payment_date: "2026-11-03" }] },
  }, "2026-11-12");
  assert.equal(row.paidAt, "2026-11-05");
  assert.equal(row.firstPaymentAt, "2026-11-03");
});

test("metrics use only PayPal payments for speed and report sample sizes", () => {
  const rows = [
    { id: "a", status: "PAID", invoiceDate: "2026-11-01", dueDate: "2026-11-08", paidAt: "2026-11-04", firstPaymentAt: "2026-11-04", currency: "USD", paid: 100, due: 0, daysOverdue: 0, hadPlan: false },
    { id: "b", status: "PAID", invoiceDate: "2026-10-01", dueDate: "2026-10-10", paidAt: "2026-10-20", firstPaymentAt: "2026-10-12", currency: "USD", paid: 1500, due: 0, daysOverdue: 0, hadPlan: true },
    { id: "c", status: "MARKED_AS_PAID", invoiceDate: "2026-10-01", dueDate: "2026-10-05", paidAt: "2026-10-02", currency: "USD", paid: 800, due: 0, daysOverdue: 0, hadPlan: false },
    { id: "d", status: "SENT", invoiceDate: "2026-10-20", dueDate: "2026-10-30", paidAt: "", firstPaymentAt: "", currency: "EUR", paid: 0, due: 600, daysOverdue: 13, hadPlan: true },
  ];
  const m = computeMetrics(rows, { b: { status: "sent", at: "2026-10-11T09:00:00Z" }, d: { status: "sent", at: "2026-11-01T09:00:00Z" } });
  assert.equal(m.paidViaPayPal, 2, "seller-recorded payments are left out");
  assert.equal(m.medianDaysToPay, 11);
  assert.deepEqual(m.paidOnTime, { count: 1, of: 2 });
  assert.equal(m.plansOffered, 2);
  assert.equal(m.plansPaidInFull, 1);
  assert.deepEqual(m.planCollected, { USD: 1500 });
  assert.equal(m.remindersSent, 2);
  assert.equal(m.paidAfterReminder, 1);
  assert.deepEqual(m.overdue, { EUR: 600 });
});
