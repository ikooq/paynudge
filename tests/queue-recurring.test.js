import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated store file for this test process (must be set before the store module loads).
process.env.DATABASE_URL = "";
process.env.STORE_FILE = path.join(await mkdtemp(path.join(tmpdir(), "paynudge-q-")), "store.json");
const { buildQueue, pickOverdue, toneForDays, markItem, getQueue } = await import("../src/queue.js");
const { addInterval, cleanSchedule, saveSchedule, dueSchedules, markIssued, scheduleDraft } = await import("../src/recurring.js");

const now = Date.parse("2026-11-12T08:00:00Z");
const row = (over) => ({ id: "INV", number: "1", client: "Client", email: "c@example.com", currency: "USD", due: 300, daysOverdue: 5, language: "English", plan: null, reminderHistory: null, lastSent: "", ...over });

test("monthly and weekly dates advance correctly, clamping month ends", () => {
  assert.equal(addInterval("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(addInterval("2026-11-12", "monthly"), "2026-12-12");
  assert.equal(addInterval("2026-12-28", "weekly"), "2027-01-04");
});

test("recurring schedules are validated and issued once per date", async () => {
  assert.throws(() => cleanSchedule({ client: { name: "A" }, items: [{ name: "x", unit_price: 1 }], nextDate: "2026-12-01" }, "2026-11-12"), /email/);
  assert.throws(() => cleanSchedule({ client: { name: "A", email: "a@b.co" }, items: [{ name: "x", unit_price: 1 }], nextDate: "2026-11-01" }, "2026-11-12"), /past/);
  const s = await saveSchedule("t", { client: { name: "Dana", email: "dana@example.com" }, items: [{ name: "Maintenance", quantity: 1, unit_price: 300 }], nextDate: "2099-01-31", interval: "monthly", dueInDays: 10 });
  assert.equal(s.total, 300);
  assert.deepEqual(dueSchedules("t", "2099-01-30"), []);
  assert.equal(dueSchedules("t", "2099-01-31").length, 1);
  assert.equal(scheduleDraft(s, "2099-01-31").due_date, "2099-02-10");
  const after = await markIssued("t", s.id, "2099-01-31", "INV-9");
  assert.equal(after.nextDate, "2099-02-28");
  const again = await markIssued("t", s.id, "2099-01-31", "INV-9");
  assert.equal(again.issued.length, 1, "a repeated confirmation for the same date does not advance twice");
});

test("the queue skips recently contacted and agreed-plan invoices and picks plan offers for long overdue ones", async () => {
  const rows = [
    row({ id: "A", client: "Fresh", daysOverdue: 3 }),
    row({ id: "B", client: "Old", daysOverdue: 30 }),
    row({ id: "C", client: "Contacted", daysOverdue: 9, lastSent: "2026-11-11T10:00:00Z" }),
    row({ id: "D", client: "On plan", daysOverdue: 2, plan: { status: "accepted" } }),
    row({ id: "E", client: "Not due", daysOverdue: 0 }),
  ];
  assert.deepEqual(pickOverdue(rows, now).map((r) => r.id), ["B", "A"]);
  assert.equal(toneForDays(30), "final");
  assert.equal(toneForDays(9), "firm");
  const calls = [];
  const ai = {
    proposePaymentPlan: async ({ row: r }) => { calls.push(`plan:${r.id}`); return { installments: [{ due_date: "2026-11-20", amount: 150 }, { due_date: "2026-12-20", amount: 150 }], subject: "Plan", note: "Hi", rationale: "" }; },
    draftReminder: async ({ row: r, tone }) => { calls.push(`remind:${r.id}:${tone}`); return { subject: "Reminder", note: "Hi" }; },
  };
  const queue = await buildQueue({ seller: "q", rows, ai, now, date: "2026-11-12", recurringDue: [{ id: "R", client: { name: "Dana", email: "d@example.com" }, currency: "USD", total: 300, items: [], nextDate: "2026-11-12", interval: "monthly" }] });
  assert.deepEqual(calls, ["plan:B", "remind:A:friendly"]);
  assert.deepEqual(queue.items.map((i) => i.kind), ["plan", "reminder", "recurring"]);
  assert.equal(getQueue("q", "2026-11-12").items.length, 3);
});

test("a plan the model can't make add up falls back to a reminder", async () => {
  const ai = {
    proposePaymentPlan: async () => ({ installments: [{ due_date: "2026-11-20", amount: 1 }], subject: "", note: "" }),
    draftReminder: async () => ({ subject: "Reminder", note: "Hi" }),
  };
  const queue = await buildQueue({ seller: "f", rows: [row({ id: "B", daysOverdue: 40 })], ai, now, date: "2026-11-12" });
  assert.equal(queue.items[0].kind, "reminder");
  assert.equal(queue.items[0].tone, "final");
});
