// Synthetic conversations only. This exercises the configured live AI provider via /api/extract
// and writes a summary to docs/AI-EVAL.md.
// Usage: start PayNudge with AI credentials (npm start), then: npm run evaluate-ai
// To use a hosted deployment, set AI_EVAL_BASE_URL. This consumes AI quota (one call per case).
import { writeFile } from "node:fs/promises";

const base = (process.env.AI_EVAL_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const status = await (await fetch(`${base}/api/status`)).json();
if (!status.ai?.live) throw new Error("Live AI is not configured. Demo-mode canned responses cannot be evaluated.");

const inDays = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// Each case lists objective checks. "total" is the sum of line items the client actually agreed to.
const cases = [
  // --- Edge cases about what was agreed ---------------------------------------------------------
  { lang: "English", name: "cancelled items", text: "Client: A logo for $500 and three posts at $50 each. Freelancer: Okay. Client: Cancel the posts; I only approve the logo for $500. Invoice ana@example.com.",
    expect: { total: 500, currency: "USD", items: 1, email: "ana@example.com" } },
  { lang: "English", name: "unapproved quote", text: "Client: Could you quote me $900 for a website? I have not approved it; do not start. Freelancer: Understood, waiting for your decision.",
    expect: { total: 0, items: 0, warnings: true } },
  { lang: "English", name: "unknown delivery date", text: "Client: $800 for the website, approved. Payment is due 10 days after delivery. Delivery date is not yet known. Email ada@example.com.",
    expect: { total: 800, currency: "USD", dueDate: "", warnings: true } },
  { lang: "English", name: "missing contact", text: "Client: I approve 2 posters for EUR 100 each. Please send an invoice. Freelancer: Confirmed.",
    expect: { total: 200, currency: "EUR", email: "" } },
  { lang: "English", name: "price changed later", text: "Me: Brand guide is $400.\nClient: Can you do $350?\nMe: OK, $350 works.\nClient: Great, approved. Bill tom@northbay.io",
    expect: { total: 350, currency: "USD", items: 1, email: "tom@northbay.io" } },
  { lang: "English", name: "k notation and hourly rate", text: "Client: Let's do the app prototype for $1.5k, plus 6 hours of consulting at $80/hour. Approved.\nMe: Perfect, invoice coming to lee@sprout.dev",
    expect: { total: 1980, currency: "USD", items: 2, email: "lee@sprout.dev" } },
  { lang: "English", name: "deposit already paid", text: "Client: Total for the video is $1,000. I already paid a $300 deposit last week.\nMe: Thanks! I'll invoice the remaining balance.\nClient: Yes please, to pay@reelhouse.co",
    expect: { total: 700, currency: "USD", email: "pay@reelhouse.co" } },
  { lang: "English", name: "explicit due date", text: `Client: Approved: 3 illustrations at $120 each. Please make the invoice payable by ${inDays(14)}. Send to mia@paperkite.com`,
    expect: { total: 360, currency: "USD", items: 1, email: "mia@paperkite.com", dueDate: inDays(14) } },
  { lang: "English", name: "email in signature", text: "Hi! We're happy with the quote: landing page $650. Go ahead and invoice us.\n\nBest,\nOmar Haddad\nHead of Marketing, Dune Labs\nomar.haddad@dunelabs.ae",
    expect: { total: 650, currency: "USD", email: "omar.haddad@dunelabs.ae" } },
  { lang: "English", name: "zero-decimal currency", text: "Client: We agree to ¥45,000 for the poster series. Invoice yuki@hikari.jp please.",
    expect: { total: 45000, currency: "JPY", email: "yuki@hikari.jp" } },
  { lang: "English", name: "discount mentioned", text: "Me: Logo $600, website $1,200. Since you're ordering both, I'll take 10% off the website.\nClient: Deal, both approved. Invoice sara@pinewood.studio",
    expect: { total: 1680, currency: "USD", email: "sara@pinewood.studio" } },
  // --- Other languages ----------------------------------------------------------------------------
  { lang: "Russian", name: "Russian chat, euros", text: "Клиент: Согласовываем 4 статьи для блога по 70 евро. Счёт на olga@kofeinya.ru, оплатим в течение недели.\nЯ: Отлично, принято!",
    expect: { total: 280, currency: "EUR", email: "olga@kofeinya.ru", dueDate: inDays(7) } },
  { lang: "Russian", name: "Russian chat, cancelled part", text: "Клиент: Делаем логотип за 300$ и визитки за 100$.\nЯ: Хорошо.\nКлиент: Визитки пока не нужно, только логотип.\nЯ: Понял, выставлю счёт только за логотип. Почта ivan@stroy.kz?\nКлиент: Да.",
    expect: { total: 300, currency: "USD", items: 1, email: "ivan@stroy.kz" } },
  { lang: "Spanish", name: "Spanish chat", text: "Cliente: Aprobado: 10 fotos de producto a 20 € cada una y la edición de vídeo por 150 €. Factura a pagos@verdemar.es\nYo: ¡Perfecto, gracias!",
    expect: { total: 350, currency: "EUR", email: "pagos@verdemar.es" } },
  { lang: "Spanish", name: "Spanish chat, no email", text: "Cliente: Vale, hacemos la traducción de 8 páginas a 30 dólares por página. ¿Me mandas la factura?\nYo: Claro.",
    expect: { total: 240, currency: "USD", email: "" } },
  { lang: "Kazakh", name: "Kazakh chat", text: "Клиент: Сайтқа 5 мақала керек, әрқайсысы 40$. Келістік. Шотты aidos@tulpar.kz поштасына жіберіңіз.\nМен: Жақсы, рахмет!",
    expect: { total: 200, currency: "USD", email: "aidos@tulpar.kz" } },
];

function check(c, d) {
  const e = c.expect;
  const fails = [];
  if ("total" in e && !near(d.total, e.total)) fails.push(`total ${d.total} ≠ ${e.total}`);
  if ("currency" in e && d.currency !== e.currency) fails.push(`currency ${d.currency} ≠ ${e.currency}`);
  if ("items" in e && d.items.length !== e.items) fails.push(`items ${d.items.length} ≠ ${e.items}`);
  if ("email" in e && (d.client?.email || "").toLowerCase() !== e.email) fails.push(`email "${d.client?.email}" ≠ "${e.email}"`);
  if ("dueDate" in e && (d.due_date || "") !== e.dueDate) fails.push(`due "${d.due_date}" ≠ "${e.dueDate}"`);
  if (e.warnings && !d.warnings?.length) fails.push("expected a warning");
  return fails;
}

console.log(`Testing ${status.ai.provider} / ${status.ai.model} at ${base} with ${cases.length} synthetic chats.`);
const results = [];
for (const c of cases) {
  const started = Date.now();
  let fails;
  let d = {};
  try {
    const response = await fetch(`${base}/api/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: c.text }) });
    d = await response.json();
    fails = response.ok ? check(c, d) : [`HTTP ${response.status}: ${d.error}`];
  } catch (error) {
    fails = [error.message];
  }
  const items = d.items || [];
  // The server keeps a quote only if it really appears in the chat (src/evidence.js).
  const withEvidence = items.filter((i) => i.evidence && i.evidence_source).length;
  const secs = (Date.now() - started) / 1000;
  results.push({ ...c, fails, secs, items: items.length, withEvidence });
  console.log(`${fails.length ? "FAIL" : "PASS"} ${c.name} (${secs.toFixed(1)}s)${fails.length ? ": " + fails.join("; ") : ""}`);
  await new Promise((r) => setTimeout(r, 2500)); // stay inside the free-tier rate limit
}

const passed = results.filter((r) => !r.fails.length).length;
const totalItems = results.reduce((s, r) => s + r.items, 0);
const evidenced = results.reduce((s, r) => s + r.withEvidence, 0);
const median = results.map((r) => r.secs).sort((a, b) => a - b)[Math.floor(results.length / 2)];
const summary = `${passed}/${cases.length} chats passed their selected checks · ${evidenced}/${totalItems} line items carry a quote from the chat · median ${median.toFixed(1)} s per draft`;
console.log(summary);

const md = `# AI extraction check

Run: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · ${status.ai.provider} / \`${status.ai.model}\` · build \`${(status.build || "local").slice(0, 7)}\`

**${summary}.**

${cases.length} synthetic client chats (English, Russian, Spanish, Kazakh). Each case checks a selected subset of total, currency, item count, email, due date and warnings; not every field is checked in every case.
These are hand-written examples, not real customer data, so they show behaviour on known edge cases, not general accuracy.

| Case | Language | Result | Time |
|---|---|---|---|
${results.map((r) => `| ${r.name} | ${r.lang} | ${r.fails.length ? `❌ ${r.fails.join("; ").replace(/\|/g, "/")}` : "✅"} | ${r.secs.toFixed(1)} s |`).join("\n")}

Reproduce: \`npm start\` with \`GROQ_API_KEY\` set, then \`npm run evaluate-ai\` (writes this file).
`;
await writeFile(new URL("../docs/AI-EVAL.md", import.meta.url), md);
console.log("Wrote docs/AI-EVAL.md");
if (passed < cases.length) process.exitCode = 1;
