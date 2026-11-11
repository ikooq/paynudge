import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { config } from "./src/config.js";
import { extractDraft, draftReminder, askCopilot, AIError } from "./src/ai.js";
import { buildPayPalInvoice, normalizeDraft, toRow, computeKpis, todayISO } from "./src/invoices.js";
import { publicSamples } from "./src/samples.js";
import { logEvent, detectPayments, listActivity, subscribe, broadcast } from "./src/activity.js";
import { reminderHistory, recordReminder } from "./src/reminder-history.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const paypal = config.paypal.live ? await import("./src/paypal.js") : await import("./src/mockPaypal.js");
const { PayPalError } = config.paypal.live ? paypal : { PayPalError: class {} };

const app = express();
// Render terminates HTTPS at its load balancer. Trust one hop only there so
// per-client limits don't accidentally treat every judge as the same visitor.
if (process.env.RENDER === "true") app.set("trust proxy", 1);
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(here, "public")));
app.use("/vendor/ag-grid", express.static(path.join(here, "node_modules/ag-grid-community/dist")));
app.use("/vendor/tesseract", express.static(path.join(here, "node_modules/tesseract.js/dist")));
app.use("/vendor/tesseract-core", express.static(path.join(here, "node_modules/tesseract.js-core")));
for (const lang of ["eng", "rus", "spa"]) {
  app.use("/vendor/ocr-data", express.static(path.join(here, "node_modules/@tesseract.js-data", lang, "4.0.0_best_int")));
}

// --- Small per-IP rate limit for the endpoints that call the AI -------------------------------
const hits = new Map();
const writeHits = new Map();
function writeLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (writeHits.get(req.ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= 30) return res.status(429).json({ error: "Too many invoice or reminder requests. Please wait a few minutes." });
  list.push(now);
  writeHits.set(req.ip, list);
  if (writeHits.size > 1000) for (const [key, times] of writeHits) if (now - times[times.length - 1] >= windowMs) writeHits.delete(key);
  next();
}
function aiLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= config.aiRateLimit) {
    return res.status(429).json({ error: "Too many AI requests. Please wait a few minutes." });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}

async function allRows() {
  const today = todayISO();
  const rows = (await paypal.listInvoices()).map((inv) => { const row = toRow(inv, today); return { ...row, reminderHistory: reminderHistory(row.id) }; });
  return rows.sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || "") || b.number.localeCompare(a.number));
}

// --- API -------------------------------------------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({
    paypal: { live: config.paypal.live, env: config.paypal.env, webhooks: Boolean(config.paypal.live && config.paypal.webhookId), lastWebhookAt },
    ai: { live: config.ai.live, model: config.ai.model, visionModel: config.ai.visionModel, provider: config.ai.name },
    business: config.business.name,
    build: process.env.RENDER_GIT_COMMIT || null,
  });
});

app.get("/api/samples", (req, res) => res.json(publicSamples()));

// 1) Conversation -> invoice draft (AI)
app.post("/api/extract", aiLimit, async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 20000);
  const images = (req.body?.images || [])
    .filter((i) => /^image\/(png|jpeg|webp|gif)$/.test(i?.media_type) && typeof i?.data === "string")
    .slice(0, 4);
  if (!text.trim() && !images.length) return res.status(400).json({ error: "Paste a conversation or add a screenshot." });
  const started = Date.now();
  const draft = normalizeDraft(await extractDraft({ text, images }), config.business.defaultCurrency);
  const lang = draft.conversation_language;
  const source = images.length
    ? `${images.length} screenshot${images.length > 1 ? "s" : ""}`
    : `${/^[aeiou]/i.test(lang) ? "an" : "a"} ${lang} chat`;
  logEvent(
    "ai",
    `AI drafted an invoice for ${draft.client.business_name || draft.client.name || "a client"} from ${source}: ${draft.items.length} line items, ${draft.total.toFixed(2)} ${draft.currency} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  res.json(draft);
});

// 2) Draft -> PayPal invoice, created and sent through the Invoicing API
app.post("/api/invoices", writeLimit, async (req, res) => {
  const operationId = String(req.body?.operationId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    return res.status(400).json({ error: "A valid invoice operation ID is required." });
  }
  const { invoice, draft } = buildPayPalInvoice(req.body?.draft || {}, config.business);
  const created = await paypal.createDraftInvoice(invoice, { requestId: operationId });
  const hasEmail = Boolean(draft.client.email);
  let payerUrl;
  let fresh;
  try {
    const existing = await paypal.getInvoice(created.id);
    if (existing.status !== "DRAFT") payerUrl = toRow(existing).payerUrl;
    else payerUrl = await paypal.sendInvoice(created.id, {
      subject: `Invoice from ${config.business.name}`,
      note: draft.note_to_client || undefined,
      sendToRecipient: hasEmail,
      requestId: createHash("sha256").update(`send:${operationId}`).digest("hex").slice(0, 32),
    });
    fresh = await paypal.getInvoice(created.id);
  } catch (err) {
    console.error("Invoice created but sending failed", created.id, err.message);
    return res.status(502).json({ error: `Invoice ${created.id} exists, but its delivery could not be confirmed. Retry this same operation; check PayPal before starting a new invoice.` });
  }
  const row = toRow(fresh);
  logEvent(
    "paypal",
    hasEmail
      ? `PayPal sent invoice #${row.number} to ${row.client} (${row.amount.toFixed(2)} ${row.currency})`
      : `PayPal created a payment link for invoice #${row.number} (${row.client})`,
    { invoiceId: row.id, sent: true },
  );
  res.status(201).json({ row, payerUrl: payerUrl || row.payerUrl, emailed: hasEmail });
});

// 3) Receivables dashboard data, read live from PayPal
app.get("/api/invoices", async (req, res) => {
  const rows = await allRows();
  detectPayments(rows);
  res.json({ rows, kpis: computeKpis(rows), updatedAt: new Date().toISOString() });
});

// The collections autopilot runs in the browser (so each step shows live); it reports its start here.
app.post("/api/autopilot/started", (req, res) => {
  const count = Math.max(0, Math.min(50, Number(req.body?.count) || 0));
  logEvent("agent", `Reminder review started for ${count} overdue invoice${count === 1 ? "" : "s"}`);
  res.json({ ok: true });
});

// PayPal webhooks: PayPal calls this when an invoice is paid, cancelled or refunded.
// Every delivery is verified with PayPal before anything is logged or pushed to the dashboard.
let lastWebhookAt = null;
const WEBHOOK_EVENTS = {
  "INVOICING.INVOICE.PAID": (inv) => `PayPal confirmed payment of invoice #${inv.number} (${inv.amount}) by webhook`,
  "INVOICING.INVOICE.CANCELLED": (inv) => `PayPal reports invoice #${inv.number} was cancelled`,
  "INVOICING.INVOICE.REFUNDED": (inv) => `PayPal reports invoice #${inv.number} was refunded`,
};
app.post("/api/paypal/webhook", async (req, res) => {
  if (!config.paypal.live || !config.paypal.webhookId) return res.status(503).json({ error: "Webhooks are not configured." });
  const event = req.body || {};
  let genuine = false;
  try {
    genuine = await paypal.verifyWebhookSignature(req.headers, event, config.paypal.webhookId);
  } catch (err) {
    console.error("Webhook verification failed", err.message);
    return res.status(502).json({ error: "Could not verify the webhook with PayPal." });
  }
  if (!genuine) return res.status(400).json({ error: "Webhook signature is not valid." });
  lastWebhookAt = new Date().toISOString();
  const describe = WEBHOOK_EVENTS[event.event_type];
  if (describe) {
    const invoice = event.resource?.invoice || event.resource || {};
    const amount = invoice.amount ? `${invoice.amount.value} ${invoice.amount.currency_code}` : "amount in PayPal";
    const info = { number: invoice.detail?.invoice_number || invoice.id || "?", amount };
    logEvent(event.event_type === "INVOICING.INVOICE.PAID" ? "payment" : "paypal", describe(info), { invoiceId: invoice.id, viaWebhook: true });
    broadcast({ type: event.event_type, invoiceId: invoice.id });
  }
  res.json({ ok: true }); // acknowledge quickly, also for event types we don't use
});

// Live stream for open dashboards (Server-Sent Events): pushes webhook news without polling delay.
app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  const unsubscribe = subscribe((message) => res.write(`data: ${JSON.stringify(message)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// Agent activity feed: what the AI and PayPal did, newest first
app.get("/api/activity", async (req, res) => {
  const rows = await allRows();
  detectPayments(rows);
  res.json(listActivity(rows));
});

// 4) AI-written reminder for one invoice (not sent yet: the user reviews it first)
app.post("/api/invoices/:id/reminder-draft", aiLimit, async (req, res) => {
  const row = { ...toRow(await paypal.getInvoice(req.params.id)), reminderHistory: reminderHistory(req.params.id) };
  const tone = ["friendly", "firm", "final"].includes(req.body?.tone) ? req.body.tone : "friendly";
  const reminder = await draftReminder({ row, tone });
  logEvent("ai", `AI wrote a ${tone} reminder in ${row.language} for ${row.client} (#${row.number})`, { invoiceId: row.id });
  res.json({ ...reminder, tone, row });
});

// 5) Send the approved reminder through PayPal
const reminderLocks = new Set();
app.post("/api/invoices/:id/remind", writeLimit, async (req, res) => {
  const subject = String(req.body?.subject || "").trim().slice(0, 200);
  const note = String(req.body?.note || "").trim().slice(0, 1000);
  if (!subject || !note) return res.status(400).json({ error: "Subject and message are required." });
  const id = req.params.id;
  if (reminderLocks.has(id)) return res.status(409).json({ error: "A reminder is already being sent for this invoice." });
  reminderLocks.add(id);
  try {
    const current = toRow(await paypal.getInvoice(id));
    if (current.due <= 0) return res.status(409).json({ error: "This invoice no longer has an outstanding balance. Refresh the dashboard before sending." });
    const previous = reminderHistory(id);
    if (previous && (previous.status !== "sent" || Date.now() - Date.parse(previous.at) < 48 * 3600_000) && req.body?.confirmRepeat !== true) {
      return res.status(409).json({ error: "A reminder was sent recently or its delivery is unconfirmed. Review PayPal before sending another.", repeatConfirmationRequired: true });
    }
    await recordReminder(id, "pending");
    try {
      await paypal.remindInvoice(id, { subject, note });
    } catch (err) {
      // Keep pending: a timeout does not prove that PayPal failed to send.
      throw err;
    }
    await recordReminder(id, "sent");
  } finally {
    reminderLocks.delete(id);
  }
  const who = String(req.body?.client || "the client").slice(0, 80);
  logEvent("paypal", `PayPal emailed a reminder to ${who}${req.body?.number ? ` for invoice #${String(req.body.number).slice(0, 12)}` : ""}`, {
    invoiceId: req.params.id,
  });
  res.json({ ok: true });
});

// 6) Copilot: questions about receivables, answered from live PayPal data
app.post("/api/copilot", aiLimit, async (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "Ask a question first." });
  const rows = await allRows();
  const result = await askCopilot({ question, rows });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const actions = (result.actions || [])
    .filter((a) => byId.has(a.invoice_id))
    .filter((a) => a.type !== "remind" || byId.get(a.invoice_id).due > 0)
    .slice(0, 3);
  logEvent("ai", `Copilot answered “${question.slice(0, 60)}”${actions.length ? ` and proposed ${actions.length} action${actions.length > 1 ? "s" : ""}` : ""}`);
  res.json({ answer: result.answer, actions });
});

// Demo mode only: a stand-in for PayPal's payer page so the full loop can be shown without keys.
if (!config.paypal.live) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  app.get("/demo-pay/:id", async (req, res) => {
    const inv = toRow(await paypal.getInvoice(req.params.id));
    const row = { ...inv, number: esc(inv.number), client: esc(inv.client), items: esc(inv.items), currency: esc(inv.currency) };
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo payer view</title><style>body{font-family:system-ui,sans-serif;background:#f4f4f7;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{background:#fff;border-radius:16px;padding:28px;max-width:420px;width:100%;box-shadow:0 10px 30px #0001}button{width:100%;padding:12px;border:0;border-radius:10px;background:#14171f;color:#fff;font-size:16px;cursor:pointer}
small{color:#666}</style><main><small>DEMO MODE: this page stands in for PayPal's invoice page</small><h2>Invoice #${row.number}</h2>
<p>${row.client}<br>${row.items}</p><h1>${row.due.toFixed(2)} ${row.currency}</h1>
${row.due > 0 ? `<form method="post"><button>Simulate payment</button></form>` : "<p><b>Paid. Thank you!</b></p>"}</main>`);
  });
  app.post("/demo-pay/:id", async (req, res) => {
    await paypal.markPaid(req.params.id);
    res.redirect(`/demo-pay/${req.params.id}`);
  });
}

// --- Errors ------------------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof PayPalError) {
    console.error("PayPal error", err.status, err.debugId, JSON.stringify(err.body));
    return res.status(err.status >= 500 ? 502 : 400).json({ error: `PayPal: ${err.message}`, debugId: err.debugId });
  }
  if (err instanceof AIError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
});

app.listen(config.port, () => {
  console.log(`PayNudge running at http://localhost:${config.port}`);
  console.log(`  PayPal: ${config.paypal.live ? `${config.paypal.env} API` : "demo mode (in-memory mock)"}`);
  const vision = config.ai.visionModel ? ` (screenshots: ${config.ai.visionModel})` : "";
  console.log(`  AI:     ${config.ai.live ? `${config.ai.name} · ${config.ai.model}${vision}` : "demo mode (canned responses)"}`);
});
