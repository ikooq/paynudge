import test from "node:test";
import assert from "node:assert/strict";
import { validatePlan, formatPlanLine, parsePlan, planProgress, toRow } from "../src/invoices.js";

const today = "2026-11-11";

test("a plan must add up to the balance, in order, within 90 days", () => {
  const ok = validatePlan([{ due_date: "2026-11-15", amount: 500 }, { due_date: "2026-12-01", amount: 500 }, { due_date: "2026-12-15", amount: 500 }], 1500, "USD", today);
  assert.equal(ok.reduce((s, i) => s + i.amount, 0), 1500);
  assert.throws(() => validatePlan([{ due_date: "2026-11-15", amount: 1 }, { due_date: "2026-12-01", amount: 1 }], 1500, "USD", today), /add up/);
  assert.throws(() => validatePlan([{ due_date: "2026-12-01", amount: 750 }, { due_date: "2026-11-15", amount: 750 }], 1500, "USD", today), /order/);
  assert.throws(() => validatePlan([{ due_date: "2026-11-01", amount: 750 }, { due_date: "2026-12-01", amount: 750 }], 1500, "USD", today), /past/);
  assert.throws(() => validatePlan([{ due_date: "2026-11-15", amount: 1500 }], 1500, "USD", today), /2 to 4/);
  assert.throws(() => validatePlan([{ due_date: "2026-11-15", amount: 750 }, { due_date: "2027-03-01", amount: 750 }], 1500, "USD", today), /90 days/);
  assert.throws(() => validatePlan([{ due_date: "2026-11-31", amount: 750 }, { due_date: "2026-12-15", amount: 750 }], 1500, "USD", today), /valid date/);
});

test("rounding cents go into the last installment so the plan equals the balance exactly", () => {
  const plan = validatePlan([{ due_date: "2026-11-15", amount: 333.33 }, { due_date: "2026-11-29", amount: 333.33 }, { due_date: "2026-12-13", amount: 333.33 }], 1000, "USD", today);
  assert.equal(plan[2].amount, 333.34);
  assert.equal(Math.round(plan.reduce((s, i) => s + i.amount, 0) * 100) / 100, 1000);
});

test("the plan survives a round trip through the PayPal memo and tracks progress", () => {
  const inst = [{ due_date: "2026-11-15", amount: 500 }, { due_date: "2026-12-01", amount: 500 }, { due_date: "2026-12-15", amount: 500 }];
  const memo = `PayNudge memo: Landing page\nConversation language: English\n${formatPlanLine(inst, "USD")}\nPayment plan state: accepted; paid_before: 0.00`;
  const plan = parsePlan(memo);
  assert.deepEqual(plan.installments, inst);
  assert.equal(planProgress(plan, 0, today).index, 0);
  const afterOne = planProgress(plan, 500, today);
  assert.equal(afterOne.index, 1);
  assert.equal(afterOne.next.due_date, "2026-12-01");
  assert.equal(planProgress(plan, 500, "2026-12-05").behind, true);
});

test("an invoice on a plan is not overdue while the client keeps to it", () => {
  const inv = {
    id: "INV2-X", status: "PARTIALLY_PAID",
    detail: { invoice_number: "0042", currency_code: "USD", payment_term: { due_date: "2026-10-16" }, memo: `x\n${formatPlanLine([{ due_date: "2026-11-15", amount: 500 }, { due_date: "2026-12-01", amount: 500 }, { due_date: "2026-12-15", amount: 500 }], "USD")}\nPayment plan state: accepted; paid_before: 0.00` },
    amount: { currency_code: "USD", value: "1500.00" }, due_amount: { currency_code: "USD", value: "1000.00" },
    payments: { paid_amount: { currency_code: "USD", value: "500.00" } },
  };
  const onTrack = toRow(inv, "2026-11-20");
  assert.equal(onTrack.daysOverdue, 0);
  assert.equal(onTrack.nextAction.key, "plan");
  const missed = toRow(inv, "2026-12-04");
  assert.equal(missed.daysOverdue, 3);
});

test("prior payments do not count toward a newly offered plan", () => {
  const installments = [{ due_date: "2026-11-20", amount: 500 }, { due_date: "2026-12-01", amount: 500 }];
  const invoice = { id: "INV2-X", status: "PARTIALLY_PAID", amount: { currency_code: "USD", value: "1500" }, due_amount: { value: "1000" }, payments: { paid_amount: { value: "500" } }, detail: { payment_term: { due_date: "2026-10-01" }, memo: `${formatPlanLine(installments, "USD")}\nPayment plan state: offered; paid_before: 500.00` } };
  const offered = toRow(invoice, today);
  assert.equal(offered.plan.progress.index, 0);
  assert.equal(offered.plan.progress.remainingInNext, 500);
  assert.ok(offered.daysOverdue > 0, "an offer must not remove the original overdue status");
  invoice.detail.memo = invoice.detail.memo.replace("state: offered", "state: accepted");
  const accepted = toRow(invoice, today);
  assert.equal(accepted.daysOverdue, 0);
  assert.equal(accepted.plan.progress.index, 0);
  invoice.payments.paid_amount.value = "1000";
  assert.equal(toRow(invoice, today).plan.progress.index, 1);
});

test("legacy plans without a baseline do not invent progress or acceptance", () => {
  const p = parsePlan(formatPlanLine([{ due_date: "2026-11-20", amount: 500 }, { due_date: "2026-12-01", amount: 500 }], "USD"));
  assert.equal(p.status, "unknown");
  assert.equal(planProgress(p, 500, today), null);
});
