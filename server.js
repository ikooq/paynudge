import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { config } from "./src/config.js";
import { extractDraft, draftReminder, askCopilot, transcribeAudio, audioSupported, proposePaymentPlan, AIError } from "./src/ai.js";
import { buildPayPalInvoice, normalizeDraft, toRow, computeKpis, todayISO, validatePlan, formatPlanLine, composePlanMessage, money } from "./src/invoices.js";
import { publicSamples } from "./src/samples.js";
import { logEvent, detectPayments, listActivity, subscribe, broadcast } from "./src/activity.js";
import { reminderHistory, recordReminder } from "./src/reminder-history.js";
import { describeWebhookEvent } from "./src/webhook-events.js";
import { getCatalog, saveCatalog, applyCatalog, catalogPromptHint } from "./src/catalog.js";

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

// The seller a request acts for: the connected PayPal seller, or the shared demo seller.
const sellerOf = (req) => req.seller?.id || "default";

async function allRows() {
  const today = todayISO();
  const rows = (await paypal.listInvoices()).map((inv) => { const row = toRow(inv, today); return { ...row, reminderHistory: reminderHistory(row.id) }; });
  return rows.sort((a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || "") || b.number.localeCompare(a.number));
}

// --- API -------------------------------------------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({
    paypal: { live: config.paypal.live, env: config.paypal.env, webhooks: Boolean(config.paypal.live && config.paypal.webhookId), lastWebhookAt },
    ai: { live: config.ai.live, model: config.ai.model, visionModel: config.ai.visionModel, provider: config.ai.name, voice: !config.ai.live || audioSupported() },
    business: config.business.name,
    build: process.env.RENDER_GIT_COMMIT || null,
  });
});

app.get("/api/samples", (req, res) => res.json(publicSamples()));

// 1) Conversation -> invoice draft (AI)
const draftCache = new Map();
app.post("/api/extract", aiLimit, async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 20000);
  const images = (req.body?.images || [])
    .filter((i) => /^image\/(png|jpeg|webp|gif)$/.test(i?.media_type) && typeof i?.data === "string")
    .slice(0, 4);
  if (!text.trim() && !images.length) return res.status(400).json({ error: "Paste a conversation or add a screenshot." });
  const started = Date.now();
  // Text-only drafts are cached for the day (relative due dates depend on today), so judges
  // clicking the same sample chat don't each spend the shared free AI quota.
  const catalog = getCatalog(sellerOf(req));
  const cacheKey = !images.length && config.ai.live ? createHash("sha256").update(`${todayISO()}\n${config.ai.model}\n${JSON.stringify(catalog)}\n${text}`).digest("hex") : null;
  const cached = cacheKey && draftCache.get(cacheKey);
  if (cached) {
    logEvent("ai", `AI draft for ${cached.client.business_name || cached.client.name || "a client"} reused from an identical chat earlier today`);
    return res.json(cached);
  }
  const draft = applyCatalog(normalizeDraft(await extractDraft({ text, images, catalogHint: catalogPromptHint(catalog) }), config.business.defaultCurrency), catalog);
  if (cacheKey) {
    draftCache.set(cacheKey, draft);
    if (draftCache.size > 200) draftCache.delete(draftCache.keys().next().value);
  }
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

// Seller price list (fills missing prices and flags differences in AI drafts).
app.get("/api/catalog", (req, res) => res.json({ items: getCatalog(sellerOf(req)) }));
app.put("/api/catalog", writeLimit, async (req, res) => {
  const items = await saveCatalog(sellerOf(req), req.body?.items);
  logEvent("agent", `Price list saved: ${items.length} service${items.length === 1 ? "" : "s"}`);
  res.json({ items });
});

// 1b) Voice note -> text (Whisper). The seller sees the transcript before anything is drafted.
app.post("/api/transcribe", aiLimit, async (req, res) => {
  const result = await transcribeAudio({ media_type: req.body?.media_type, data: req.body?.data });
  logEvent("ai", `AI transcribed a ${result.seconds ? `${result.seconds}-second ` : ""}voice note${result.language ? ` in ${result.language}` : ""}`);
  res.json(result);
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
  const description = describeWebhookEvent(event);
  if (description) {
    logEvent("paypal", description.text, { invoiceId: description.invoiceId, viaWebhook: true });
    broadcast({ type: event.event_type, invoiceId: description.invoiceId });
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

// 5b) Payment plan: the AI proposes a schedule and a message in the client's language.
app.post("/api/invoices/:id/plan-draft", aiLimit, async (req, res) => {
  const row = toRow(await paypal.getInvoice(req.params.id));
  if (row.due <= 0) return res.status(409).json({ error: "This invoice has no outstanding balance." });
  const raw = await proposePaymentPlan({ row });
  let installments;
  try {
    installments = validatePlan(raw.installments, row.due, row.currency);
  } catch (err) {
    return res.status(502).json({ error: `The AI proposed a plan that does not add up (${err.message}) Try again or edit it.` });
  }
  const changed = installments.some((inst, i) => Math.abs(inst.amount - Number(raw.installments[i]?.amount)) > 0.001);
  logEvent("ai", `AI proposed a ${installments.length}-part payment plan in ${row.language} for ${row.client} (#${row.number})`, { invoiceId: row.id });
  res.json({
    installments,
    rationale: raw.rationale,
    subject: raw.subject,
    note: raw.note,
    adjusted: changed ? "Amounts were adjusted by a few minor currency units so the schedule equals the balance. Review it before sending." : "",
    row,
  });
});

// 5c) Approve the plan: PayPal accepts partial payments on the same invoice, the schedule is saved
// in the invoice's private memo (so it survives restarts), and PayPal emails the client the plan.
app.post("/api/invoices/:id/plan", writeLimit, async (req, res) => {
  const id = req.params.id;
  const subject = String(req.body?.subject || "").trim().slice(0, 200);
  const note = String(req.body?.note || "").trim().slice(0, 1000);
  if (!subject || !note) return res.status(400).json({ error: "Subject and message are required." });
  if (reminderLocks.has(id)) return res.status(409).json({ error: "A message is already being sent for this invoice." });
  reminderLocks.add(id);
  let row;
  try {
    const invoice = await paypal.getInvoice(id);
    row = toRow(invoice);
    if (row.due <= 0) return res.status(409).json({ error: "This invoice no longer has an outstanding balance." });
    if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(row.status)) return res.status(409).json({ error: `A plan can only be offered on a sent, unpaid invoice (status ${row.status}).` });
    const installments = validatePlan(req.body?.installments, row.due, row.currency);
    const message = composePlanMessage(note, installments, row.currency);
    const previous = reminderHistory(id);
    if (previous && (previous.status !== "sent" || Date.now() - Date.parse(previous.at) < 48 * 3600_000) && req.body?.confirmRepeat !== true) {
      return res.status(409).json({ error: "This client was contacted recently or a delivery is unconfirmed. Review PayPal before sending a plan.", repeatConfirmationRequired: true });
    }

    // Keep the memo within PayPal's 500 characters: replace any old plan line, shorten the summary if needed.
    const planLine = formatPlanLine(installments, row.currency);
    const stateLine = `Payment plan state: offered; paid_before: ${money(row.paid, row.currency)}`;
    const lines = String(invoice.detail?.memo || "").split("\n").filter((l) => l.trim() && !/^Payment plan(?::| state:)/.test(l));
    // Leave space for "accepted" (one character longer than "offered").
    while (lines.length && [...lines, planLine, stateLine].join("\n").length > 499) {
      const over = [...lines, planLine, stateLine].join("\n").length - 499;
      lines[0] = lines[0].length > over + 20 ? lines[0].slice(0, lines[0].length - over - 1) + "…" : "";
      if (!lines[0]) lines.shift();
    }
    const smallest = Math.min(...installments.map((i) => i.amount));
    await paypal.updateInvoice({
      ...invoice,
      detail: { ...invoice.detail, memo: [...lines, planLine, stateLine].join("\n") },
      configuration: {
        ...invoice.configuration,
        // The minimum is the smallest installment, so every part of the plan can be paid with the same link.
        partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: row.currency, value: money(smallest, row.currency) } },
      },
    });

    await recordReminder(id, "pending");
    await paypal.remindInvoice(id, { subject, note: message });
    await recordReminder(id, "sent");
    logEvent(
      "agent",
      `Payment plan sent to ${row.client} for #${row.number}: ${installments.map((i) => `${i.due_date.slice(5)} ${money(i.amount, row.currency)}`).join(", ")} ${row.currency}. PayPal now accepts partial payments`,
      { invoiceId: id },
    );
  } finally {
    reminderLocks.delete(id);
  }
  res.json({ ok: true, row: toRow(await paypal.getInvoice(id)) });
});

// The seller records an agreement obtained from the client; sending an offer is not acceptance.
app.post("/api/invoices/:id/plan/accept", writeLimit, async (req, res) => {
  if (req.body?.clientAgreed !== true) return res.status(400).json({ error: "Confirm the client has agreed before marking this plan accepted." });
  const id = req.params.id;
  if (reminderLocks.has(id)) return res.status(409).json({ error: "This invoice is being updated. Try again." });
  reminderLocks.add(id);
  try {
    const invoice = await paypal.getInvoice(id);
    const row = toRow(invoice);
    if (row.due <= 0 || !row.plan) return res.status(409).json({ error: "There is no open payment plan to accept." });
    if (row.plan.paidBefore == null) return res.status(409).json({ error: "This older plan has no payment baseline. Create a new offer before confirming acceptance." });
    if (row.plan.status !== "accepted") {
      const memo = String(invoice.detail?.memo || "").replace(/^Payment plan state: offered; paid_before: (\d+(?:\.\d{1,2})?)$/m, "Payment plan state: accepted; paid_before: $1");
      if (memo === invoice.detail?.memo) return res.status(409).json({ error: "The plan status could not be confirmed. Refresh and try again." });
      await paypal.updateInvoice({ ...invoice, detail: { ...invoice.detail, memo } });
      logEvent("agent", `Seller recorded client agreement for invoice #${row.number}'s payment plan`, { invoiceId: id });
    }
    res.json({ ok: true, row: toRow(await paypal.getInvoice(id)) });
  } finally { reminderLocks.delete(id); }
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
${inv.plan?.progress?.next ? `<p>Payment plan: part ${inv.plan.progress.index + 1} of ${inv.plan.progress.count}, ${inv.plan.progress.remainingInNext.toFixed(2)} ${row.currency} by ${esc(inv.plan.progress.next.due_date)}</p><form method="post"><input type="hidden" name="amount" value="${inv.plan.progress.remainingInNext}"><button>Simulate paying this part</button></form><p></p>` : ""}
${row.due > 0 ? `<form method="post"><button>Simulate full payment</button></form>` : "<p><b>Paid. Thank you!</b></p>"}</main>`);
  });
  app.post("/demo-pay/:id", express.urlencoded({ extended: false }), async (req, res) => {
    const amount = req.body?.amount ? Number(req.body.amount) : undefined;
    await paypal.markPaid(req.params.id, amount);
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
  keepAwake();
});

// Render's free plan sleeps after 15 minutes without inbound traffic, and GitHub's scheduled
// keep-warm runs are best-effort (often hours apart). While running on Render, the server
// requests its own public URL every 10 minutes so visitors don't land on a cold start.
// Uses ~744 of the 750 free instance hours in a 31-day month; set KEEP_AWAKE=false to turn off.
function keepAwake() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url || process.env.KEEP_AWAKE === "false") return;
  setInterval(() => {
    fetch(`${url}/api/status`, { signal: AbortSignal.timeout(30000) }).catch((err) => console.warn("keep-awake ping failed:", err.message));
  }, 10 * 60 * 1000);
  console.log(`  Keep-awake: pinging ${url} every 10 minutes`);
}
