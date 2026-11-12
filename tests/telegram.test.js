import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATABASE_URL = "";
process.env.STORE_FILE = path.join(await mkdtemp(path.join(tmpdir(), "paynudge-tg-")), "store.json");
process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
const { createBot, createLinkCode, verifySecret, telegram, linkedChats, draftSummary } = await import("../src/telegram.js");

// Fake Telegram Bot API: records every call the bot makes.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const method = String(url).split("/").pop();
  const body = init?.body ? JSON.parse(init.body) : {};
  sent.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "paynudge_test_bot" } : true }));
};
test.after(() => { globalThis.fetch = realFetch; });

const draft = { client: { name: "Maya", business_name: "Bloom Coffee", email: "maya@example.com" }, currency: "USD", items: [{ name: "Logo", quantity: 1, unit_price: 450, evidence: "$450 for the logo" }], total: 450, due_date: "2026-11-19", warnings: [] };
const created = [];
const bot = createBot({
  extract: async ({ text }) => ({ ...draft, text }),
  transcribe: async () => ({ text: "voice" }),
  voice: true,
  createInvoice: async (d, operationId) => { created.push(operationId); return { row: { number: "0048", amount: 450, currency: "USD", email: "maya@example.com" }, payerUrl: "https://www.sandbox.paypal.com/invoice/p/#X", emailed: true }; },
  sellerName: () => "Studio Nord",
});
const lastText = () => sent.filter((c) => c.method === "sendMessage").at(-1)?.body.text || "";
const msg = (text, extra = {}) => ({ message: { chat: { id: 42, type: "private" }, from: { first_name: "Ilias" }, text, ...extra } });

test("the webhook secret is derived from the token and checked in constant time", () => {
  assert.ok(telegram.secret.length >= 32);
  assert.equal(verifySecret(telegram.secret), true);
  assert.equal(verifySecret("wrong"), false);
  assert.equal(verifySecret(""), false);
});

test("an unlinked chat can't draft; a one-time code links it to the seller", async () => {
  await bot.handleUpdate(msg("Maya: logo for $450"));
  assert.match(lastText(), /To connect/);
  const { code } = await createLinkCode("default");
  await bot.handleUpdate(msg(`/start ${code}`));
  assert.match(lastText(), /Linked to <b>Studio Nord<\/b>/);
  assert.equal(linkedChats("default").length, 1);
  await bot.handleUpdate({ message: { chat: { id: 7, type: "private" }, text: `/link ${code}` } });
  assert.match(lastText(), /invalid or expired/, "a code works only once");
});

test("forwarded messages become a draft; one tap sends it once, with the draft ID as request ID", async () => {
  await bot.handleUpdate(msg("Logo for $450, deal!", { forward_origin: { type: "user", sender_user: { first_name: "Maya", last_name: "Chen" } } }));
  assert.match(lastText(), /Got it/);
  await bot.handleUpdate({ callback_query: { id: "q1", data: "draft:now", message: { chat: { id: 42 }, message_id: 5 } } });
  const summary = sent.filter((c) => c.method === "sendMessage").at(-1);
  assert.match(summary.body.text, /Invoice draft<\/b> for Bloom Coffee/);
  assert.match(summary.body.text, /“\$450 for the logo”/);
  const sendData = summary.body.reply_markup.inline_keyboard[0][0].callback_data;
  await bot.handleUpdate({ callback_query: { id: "q2", data: sendData, message: { chat: { id: 42 }, message_id: 6 } } });
  assert.match(lastText(), /PayPal sent invoice <b>#0048<\/b>/);
  await bot.handleUpdate({ callback_query: { id: "q3", data: sendData, message: { chat: { id: 42 }, message_id: 6 } } });
  assert.match(lastText(), /no longer current/);
  assert.deepEqual(created, [sendData.slice(5)]);
});

test("the draft summary escapes HTML from the chat", () => {
  const text = draftSummary({ ...draft, client: { name: "<b>x</b>", business_name: "", email: "" }, warnings: ["Check <this>"] });
  assert.doesNotMatch(text, /<b>x<\/b>/);
  assert.match(text, /&lt;this&gt;/);
});
