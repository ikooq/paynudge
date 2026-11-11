import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

test("reviewed invoice, retry, reminder safety, and simulated payment", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "paynudge-test-"));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const historyFile = path.join(tmp, "reminders.json");
  const child = spawn(process.execPath, ["server.js", "--demo"], { env: { ...process.env, PORT: String(port), REMINDER_HISTORY_FILE: historyFile, RENDER: "true", RENDER_GIT_COMMIT: "test-commit", AI_RATE_LIMIT: "1" }, stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    await rm(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  // Up to 20 s: the first run after a clean install starts Node and loads modules cold.
  for (let attempt = 0; attempt < 400; attempt++) {
    try { if ((await fetch(`${base}/api/status`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "server should start");
  assert.equal((await (await fetch(`${base}/api/status`)).json()).build, "test-commit");
  async function extractAs(ip) {
    return fetch(`${base}/api/extract`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ text: "Test invoice $10" }) });
  }
  assert.equal((await extractAs("198.51.100.10")).status, 200);
  assert.equal((await extractAs("198.51.100.11")).status, 200);
  assert.equal((await extractAs("198.51.100.10")).status, 429);
  const json = async (url, body) => {
    const response = await fetch(base + url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const invoice = { operationId: randomUUID(), draft: { client: { name: "Test Buyer", email: "buyer@example.com" }, currency: "USD", items: [{ name: "Design", quantity: 2, unit_price: 75 }], conversation_language: "English", due_on_receipt: true } };
  const created = await json("/api/invoices", invoice);
  assert.equal(created.status, 201);
  const retry = await json("/api/invoices", invoice);
  assert.equal(retry.data.row.id, created.data.row.id);
  const ledger = await json("/api/invoices");
  assert.equal(ledger.data.rows.filter((row) => row.id === created.data.row.id).length, 1);
  const reminder = { subject: "Invoice reminder", note: "Please review your invoice." };
  const reminderUrl = `/api/invoices/${created.data.row.id}/remind`;
  assert.equal((await json(reminderUrl, reminder)).status, 200);
  const repeat = await json(reminderUrl, reminder);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.data.repeatConfirmationRequired, true);
  assert.equal(JSON.parse(await readFile(historyFile, "utf8"))[created.data.row.id].status, "sent");
  assert.equal((await json(reminderUrl, { ...reminder, confirmRepeat: true })).status, 200);
  const payment = await fetch(base + created.data.payerUrl, { method: "POST", redirect: "manual" });
  assert.equal(payment.status, 302);
  const paid = await json("/api/invoices");
  assert.equal(paid.data.rows.find((row) => row.id === created.data.row.id).status, "PAID");
  assert.equal((await json(reminderUrl, reminder)).status, 409);
});
