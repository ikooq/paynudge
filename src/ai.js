// Everything PayNudge asks the AI to do. Each call requests structured output (a strict JSON
// schema), so the response always has a shape the app can act on.
//
// Providers (see src/config.js): Groq (default, free plan), Google Gemini, or any
// OpenAI-compatible API.
import { GoogleGenAI, ApiError } from "@google/genai";
import { config } from "./config.js";
import { samples } from "./samples.js";
import { todayISO } from "./invoices.js";
import { attachEvidence } from "./evidence.js";

const ai = config.ai;
const gemini = ai.live && ai.kind === "gemini" ? new GoogleGenAI({ apiKey: ai.apiKey }) : null;

export class AIError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- Provider calls: each returns the raw JSON text --------------------------------------------

// Network-level failures (connection reset, TLS errors from a flaky proxy) get one quick retry,
// then surface as a 503 so structured() can still try the fallback model.
async function fetchWithRetry(url, options, attempts = 2) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const code = err?.cause?.code || err?.code || err.message;
      if (i >= attempts) throw new ProviderError(503, `Network error reaching ${ai.name}: ${code}`);
      console.warn(`${ai.name} network error (${code}); retrying`);
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

// `schema` is optional: without it the model answers in plain text (used for transcription).
async function callOpenAICompatible(model, { system, text, images = [], schema, name, effort = ai.reasoningEffort, maxCompletionTokens }) {
  const user = images.length
    ? [
        { type: "text", text },
        ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.media_type};base64,${img.data}` } })),
      ]
    : text;
  const res = await fetchWithRetry(`${ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(schema ? { response_format: { type: "json_schema", json_schema: { name, strict: true, schema } } } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, body?.error?.message || `HTTP ${res.status}`);
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") throw new AIError("The AI response was cut off. Try a shorter conversation.");
  if (choice?.finish_reason === "content_filter") throw new AIError("The AI declined to process this content.", 422);
  return choice?.message?.content || "";
}

async function callGemini(model, { system, text, images, schema }) {
  let response;
  try {
    response = await gemini.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [...images.map((img) => ({ inlineData: { mimeType: img.media_type, data: img.data } })), { text }],
        },
      ],
      config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema },
    });
  } catch (err) {
    if (err instanceof ApiError) throw new ProviderError(err.status, err.message);
    throw err;
  }
  const candidate = response.candidates?.[0];
  if (response.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") {
    throw new AIError("The AI declined to process this content.", 422);
  }
  if (candidate?.finishReason === "MAX_TOKENS") throw new AIError("The AI response was cut off. Try a shorter conversation.");
  return response.text || "";
}

// --- Shared plumbing ----------------------------------------------------------------------------

// Free quotas are per model, so on a rate limit, an overload or an output that failed the
// schema check we retry once on the fallback model.
const RETRYABLE = new Set([429, 500, 502, 503]);
const shouldRetry = (err) =>
  err instanceof ProviderError && (RETRYABLE.has(err.status) || (err.status === 400 && /schema|failed_generation/i.test(err.message)));

function friendlyError(err) {
  if (!(err instanceof ProviderError)) return err;
  console.error(`${ai.name} API error`, err.status, err.message);
  if (err.status === 429) return new AIError("The free AI quota is used up for the moment. Please wait a minute and try again.", 429);
  if (err.status === 401 || /api key/i.test(err.message)) return new AIError(`The ${ai.name} API key is invalid.`, 500);
  if (err.status === 403) return new AIError(`${ai.name} refused the request: ${err.message.split(". ")[0]}.`, 500);
  return new AIError("The AI service failed. Please try again.", 502);
}

function parseJson(raw) {
  const text = String(raw).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    throw new AIError("The AI returned an unreadable response. Please try again.");
  }
}

const schemaMiss = (err) => err instanceof ProviderError && err.status === 400 && /schema|failed_generation/i.test(err.message);

async function structured({ system, text, images = [], schema, name }) {
  const call = ai.kind === "gemini" ? callGemini : callOpenAICompatible;
  const models = ai.fallbackModel && ai.fallbackModel !== ai.model ? [ai.model, ai.fallbackModel] : [ai.model];
  // An occasional output that misses the schema is usually fixed by asking the same model again,
  // so the main model gets one extra attempt for that case before the (weaker) fallback.
  let secondTry = true;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      return parseJson(await call(model, { system, text, images: images.slice(0, ai.maxImages), schema, name }));
    } catch (err) {
      if (i === 0 && secondTry && schemaMiss(err)) {
        secondTry = false;
        console.warn(`${ai.name} ${model} output missed the schema; asking it once more`);
        i -= 1;
        continue;
      }
      if (i < models.length - 1 && shouldRetry(err)) {
        console.warn(`${ai.name} ${model} failed (${err.status}); retrying on ${models[i + 1]}`);
        continue;
      }
      throw friendlyError(err);
    }
  }
}

// Step 1 for screenshots when a separate vision model is configured: turn the images into a
// plain-text transcript, which the (stronger) reasoning model then reads like a pasted chat.
async function transcribeScreenshots(images) {
  try {
    const transcript = await callOpenAICompatible(ai.visionModel, {
      system: "You transcribe screenshots of chat conversations. Output only the transcript, nothing else.",
      text: "Transcribe every message in these chat screenshots, in order. One message per line as `Sender: message`. Keep the original language and copy names, amounts, currencies, emails and dates exactly. If a screenshot is not a conversation, describe its text content instead.",
      images: images.slice(0, ai.maxImages),
      // Qwen's default reasoning and output budget can exceed the free tier's token limit
      // even for a short screenshot. This call only transcribes; it does not need reasoning.
      effort: ai.id === "groq" && ai.visionModel === "qwen/qwen3.8-27b" ? "none" : "",
      maxCompletionTokens: ai.id === "groq" ? 1500 : undefined,
    });
    return String(transcript).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  } catch (err) {
    if (err instanceof ProviderError && err.status === 429) {
      throw new AIError("Screenshot AI quota is exhausted. Use ‘Read screenshot locally’, paste the chat as text, or try again later.", 429);
    }
    throw friendlyError(err);
  }
}

// ---------------------------------------------------------------------------
// Voice note -> text (Whisper on Groq). The transcript is shown to the seller and then read by
// the same invoice extraction as a pasted chat, so every line item still quotes its source.
// ---------------------------------------------------------------------------
const AUDIO_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];
const AUDIO_TYPES = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac" };

export function audioSupported() {
  return ai.live && ai.kind === "openai" && ai.id === "groq";
}

export async function transcribeAudio({ media_type, data }) {
  const type = String(media_type || "").split(";")[0].trim().toLowerCase();
  const ext = AUDIO_TYPES[type];
  if (!ext) throw new AIError("Unsupported audio format. Use webm, ogg, mp3, m4a, wav or flac.", 400);
  const bytes = Buffer.from(String(data || ""), "base64");
  if (!bytes.length) throw new AIError("The voice note is empty.", 400);
  if (bytes.length > 10 * 1024 * 1024) throw new AIError("Voice notes can be up to 10 MB (about 10 minutes).", 400);

  if (!ai.live) {
    return {
      text: "Voice note: Invoice Maya Chen from Bloom Coffee. Logo package 450 dollars, three Instagram templates at 40 dollars each. Email maya@bloomcoffee.co, payment within a week.",
      language: "english",
      seconds: 9,
      demo: true,
    };
  }
  if (!audioSupported()) throw new AIError(`Voice notes need the Groq provider; ${ai.name} is configured.`, 501);

  for (const [i, model] of AUDIO_MODELS.entries()) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), `voice-note.${ext}`);
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    const res = await fetchWithRetry(`${ai.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ai.apiKey}` },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = String(body.text || "").trim();
      if (!text) throw new AIError("No speech was recognized in the voice note.", 422);
      return { text, language: body.language || "", seconds: Math.round(Number(body.duration) || 0) };
    }
    const err = new ProviderError(res.status, body?.error?.message || `HTTP ${res.status}`);
    if (i < AUDIO_MODELS.length - 1 && RETRYABLE.has(res.status)) continue;
    throw friendlyError(err);
  }
}

function dateContext() {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${todayISO(now)} (${weekday})`;
}

// ---------------------------------------------------------------------------
// 1. Conversation (text and/or screenshots) -> invoice draft
// ---------------------------------------------------------------------------

const draftSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "client",
    "currency",
    "items",
    "due_date",
    "payment_terms_label",
    "note_to_client",
    "summary",
    "conversation_language",
    "warnings",
  ],
  properties: {
    client: {
      type: "object",
      additionalProperties: false,
      required: ["name", "business_name", "email"],
      properties: {
        name: { type: "string", description: "Client contact person, transliterated to Latin script. Empty if unknown." },
        business_name: { type: "string", description: "Client company or brand. Empty if unknown." },
        email: { type: "string", description: "Only if it literally appears in the conversation. Otherwise empty." },
      },
    },
    currency: { type: "string", description: "ISO 4217 code, e.g. USD, EUR." },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "quantity", "unit_price", "evidence"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          quantity: { type: "number" },
          unit_price: { type: "number" },
          evidence: { type: "string", description: "A short exact quote from the conversation supporting this item and price; empty if unavailable." },
        },
      },
    },
    due_date: { type: "string", description: "YYYY-MM-DD, or empty string when no timing was agreed." },
    payment_terms_label: { type: "string", description: "Short human label such as 'Net 10' or 'Due on receipt'." },
    note_to_client: { type: "string" },
    summary: { type: "string" },
    conversation_language: { type: "string", description: "Language the client wrote in, in English, e.g. 'Russian'." },
    warnings: { type: "array", items: { type: "string" } },
  },
};

function extractSystemPrompt() {
  return `You are the billing assistant inside PayNudge, a tool freelancers and small businesses use to turn client conversations into PayPal invoices. The user is the seller, "${config.business.name}". The conversation may be pasted text or chat screenshots, in any language.

Draft the invoice the seller should send:
- Bill only what the client actually agreed to. Each distinct deliverable or fee becomes one line item with a quantity and a unit price. Do not invent items, prices or discounts.
- For each item provide evidence: a brief verbatim excerpt from the conversation supporting the item and price. Copy it exactly in the original language; if you cannot find a quote, leave evidence empty. Do not paraphrase or fabricate quotations.
- Treat quotes, proposals, and unaccepted estimates as unapproved; do not bill them. Follow the latest explicit agreement when earlier work, prices, or quantities are changed or cancelled. Warn when it is unclear what was approved.
- Write item names, descriptions and the note to the client in English, whatever language the chat is in. Keep proper names as written, transliterated to Latin script when needed.
- currency: the ISO 4217 code used in the conversation ($ means USD unless context says otherwise). If no currency appears, use ${config.business.defaultCurrency}.
- due_date: today is ${dateContext()}. Resolve relative payment timing ("by Friday", "within a week", "10 days after delivery") into a calendar date. Leave it empty if payment timing was never discussed.
- If payment depends on an event whose date is unknown (such as delivery), leave due_date empty and warn that the date needs confirmation. Never assume the missing event happened today.
- When payment terms are absent or uncertain, do not claim that payment is due on receipt. Warn that the seller must confirm the terms.
- client.email: only an address that literally appears in the conversation. Never guess one.
- warnings: anything the seller should double-check before sending, such as a missing email, an approximate quantity, a price that was mentioned but not clearly agreed, or an assumption you made about dates. One short sentence each. Return an empty list when everything is clear.
- summary: one sentence for the seller's private records describing the deal and the tone of the relationship.
- note_to_client: one or two warm sentences thanking the client for the specific work.
- If the content is not a commercial conversation, return no items and explain why in warnings.`;
}

export async function extractDraft({ text = "", images = [] }) {
  if (!config.ai.live) return demoExtract(text);

  let conversation = text.trim();
  let attach = images;
  let transcript = "";
  if (images.length && ai.visionModel) {
    transcript = await transcribeScreenshots(images);
    conversation = [conversation, transcript && `Transcribed from screenshots:\n${transcript}`].filter(Boolean).join("\n\n");
    attach = [];
  }
  const draft = await structured({
    system: extractSystemPrompt(),
    text: conversation
      ? `Client conversation:\n<conversation>\n${conversation}\n</conversation>`
      : "The client conversation is in the attached screenshots.",
    images: attach,
    schema: draftSchema,
    name: "invoice_draft",
  });
  return attachEvidence(draft, { text, transcript });
}

// ---------------------------------------------------------------------------
// 2. Overdue invoice -> payment reminder that PayPal emails to the client
// ---------------------------------------------------------------------------

const reminderSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "note"],
  properties: {
    subject: { type: "string" },
    note: { type: "string" },
  },
};

const TONES = {
  friendly: "Friendly: assume they simply forgot. Light, warm, no pressure.",
  firm: "Firm: polite but direct. Mention how many days overdue it is and ask for a payment date.",
  final: "Final notice: formal and clear. Say this is the last reminder before work on new requests is paused. Never threaten legal action or late fees that were not agreed.",
};

export async function draftReminder({ row, tone = "friendly" }) {
  if (!config.ai.live) return demoReminder(row, tone);

  const system = `You write payment reminders for ${config.business.name}. PayPal emails your text to the client together with a "View and pay" button for the invoice, so never include links, bank details or the full invoice table.

Tone: ${TONES[tone] || TONES.friendly}
${
  row.daysOverdue > 0
    ? `The invoice is ${row.daysOverdue} days past its payment due date.`
    : "The invoice is NOT overdue yet. Write a courteous heads-up about the upcoming payment due date, whatever the tone, and never say or imply that it is late."
}
Write in the language the client used in the original conversation (given below). Address the contact by first name when known. Subject: at most 70 characters. Note: at most 450 characters, plain text, no sign-off placeholders like [Name]; sign as ${config.business.name}.`;

  const facts = {
    client: row.client,
    contact: row.contact,
    invoice_number: row.number,
    invoice_date: row.invoiceDate,
    items: row.items,
    amount_due: `${row.due} ${row.currency}`,
    payment_due_date: row.dueDate,
    days_overdue: row.daysOverdue,
    today: todayISO(),
    conversation_language: row.language,
    relationship_notes: row.memo,
  };
  return structured({
    system,
    text: `Invoice facts:\n${JSON.stringify(facts, null, 2)}`,
    schema: reminderSchema,
    name: "payment_reminder",
  });
}

// ---------------------------------------------------------------------------
// 3. Receivables copilot: answers questions about invoices and proposes actions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2b. Late invoice -> payment plan proposal (schedule + message in the client's language).
// The server re-checks the schedule (src/invoices.js validatePlan); the seller approves it;
// PayPal then accepts partial payments on the same invoice.
// ---------------------------------------------------------------------------
const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["installments", "rationale", "subject", "note"],
  properties: {
    installments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["due_date", "amount"],
        properties: {
          due_date: { type: "string", description: "YYYY-MM-DD" },
          amount: { type: "number" },
        },
      },
    },
    rationale: { type: "string", description: "One or two sentences for the seller (English): why this schedule." },
    subject: { type: "string" },
    note: { type: "string" },
  },
};

export async function proposePaymentPlan({ row }) {
  if (!config.ai.live) return demoPlan(row);
  const system = `You help ${config.business.name}, a freelancer, recover a late invoice by offering the client a payment plan instead of more pressure.
Propose 2 to 4 installments that add up EXACTLY to the amount due. The first installment is due within 7 days of today and should be the largest or equal share (at least 30% of the balance); the whole plan ends within 60 days; dates strictly increase; prefer round amounts. Use more installments for larger balances or longer delays, fewer for small ones.
Then write the message PayPal will email with the invoice's "View and pay" button: in the language the client used in the original conversation, warm and respectful, no blame. It must list each installment with date and amount, say that the invoice now accepts partial payments so each installment can be paid with the same PayPal link, and thank them. Subject at most 70 characters; note at most 600 characters, plain text; sign as ${config.business.name}. Never include links or bank details. The rationale is for the seller, in English.`;
  const facts = {
    client: row.client,
    contact: row.contact,
    invoice_number: row.number,
    amount_due: row.due,
    currency: row.currency,
    original_due_date: row.dueDate,
    days_overdue: row.daysOverdue,
    today: todayISO(),
    conversation_language: row.language,
    relationship_notes: row.memo,
  };
  return structured({
    system,
    text: `Invoice facts:\n${JSON.stringify(facts, null, 2)}`,
    schema: planSchema,
    name: "payment_plan",
  });
}

const copilotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "actions"],
  properties: {
    answer: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "invoice_id", "tone", "label"],
        properties: {
          type: { type: "string", enum: ["remind", "open"] },
          invoice_id: { type: "string" },
          tone: { type: "string", enum: ["friendly", "firm", "final", "none"] },
          label: { type: "string" },
        },
      },
    },
  },
};

export async function askCopilot({ question, rows }) {
  if (!config.ai.live) return demoCopilot(rows);

  const system = `You are the receivables copilot in PayNudge for ${config.business.name}. You get the seller's invoices, pulled live from PayPal, as JSON. Today is ${dateContext()}.
Answer the question in at most 4 short sentences with exact figures and currencies (never add amounts in different currencies together). In the answer, refer to invoices by client name and number like "#0003", never by their id.
Then propose up to 3 concrete next actions: "remind" or "open". Reminder tone follows days overdue: 1-7 friendly, 8-21 firm, more than 21 final; not yet due: friendly. Put the invoice id from the data in invoice_id, and never propose a reminder for a paid, draft or cancelled invoice. Each action label is at most 6 words, e.g. "Nudge Northwind (final)".`;

  const data = rows.map((r) => ({
    id: r.id,
    number: r.number,
    client: r.client,
    status: r.status,
    amount: r.amount,
    amount_due: r.due,
    currency: r.currency,
    due_date: r.dueDate,
    days_overdue: r.daysOverdue,
    items: r.items,
  }));
  return structured({
    system,
    text: `Invoices:\n${JSON.stringify(data)}\n\nQuestion: ${question}`,
    schema: copilotSchema,
    name: "copilot_answer",
  });
}

// ---------------------------------------------------------------------------
// Demo mode (no API key): canned but realistic answers so the UI can be explored.
// ---------------------------------------------------------------------------

function shift(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return todayISO(d);
}

function demoExtract(text) {
  // The demo voice note (see transcribeAudio) describes the Bloom Coffee job, so it maps to that sample.
  const sample = samples.find((s) => s.text.trim() === text.trim()) || (/Bloom Coffee/.test(text) && /Voice note/.test(text) ? samples[0] : null);
  if (sample) {
    const { dueInDays, ...rest } = sample.expected;
    return { ...rest, due_date: dueInDays ? shift(dueInDays) : "" };
  }
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0] || "";
  const amounts = [...text.matchAll(/(?:\$|USD\s?)(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:\$|USD|usd)/g)].map((m) =>
    Number((m[1] || m[2]).replace(",", ".")),
  );
  return {
    client: { name: "", business_name: "", email },
    currency: "USD",
    items: amounts.map((a, i) => ({ name: `Item ${i + 1}`, description: "", quantity: 1, unit_price: a })),
    due_date: "",
    payment_terms_label: "Due on receipt",
    note_to_client: "Thank you for your business!",
    summary: "Drafted in demo mode without AI.",
    conversation_language: "English",
    warnings: ["Demo mode: the AI is not connected, so this draft is a rough guess. Set GROQ_API_KEY for real extraction."],
  };
}

function demoReminder(row, tone) {
  const name = row.contact?.split(" ")[0] || "there";
  const amount = `${row.due} ${row.currency}`;
  const text = {
    friendly: {
      subject: `Quick reminder: invoice #${row.number}`,
      note: `Hi ${name}! Just a friendly reminder that invoice #${row.number} for ${amount} is ready whenever you are. Thanks again for working with us! — ${config.business.name}`,
    },
    firm: {
      subject: `Invoice #${row.number} is ${row.daysOverdue} days overdue`,
      note: `Hi ${name}, invoice #${row.number} for ${amount} was due on ${row.dueDate} and is now ${row.daysOverdue} days overdue. Could you let us know when we can expect payment? — ${config.business.name}`,
    },
    final: {
      subject: `Final reminder: invoice #${row.number}`,
      note: `Hello ${name}, this is our final reminder about invoice #${row.number} for ${amount}, due on ${row.dueDate}. We will pause work on new requests until it is settled. — ${config.business.name}`,
    },
  };
  return text[tone] || text.friendly;
}

function demoPlan(row) {
  const n = row.due >= 1000 ? 3 : 2;
  const step = Math.floor((row.due / n) * 100) / 100;
  const installments = Array.from({ length: n }, (_, i) => ({ due_date: shift(3 + i * 14), amount: i === n - 1 ? Math.round((row.due - step * (n - 1)) * 100) / 100 : step }));
  const name = row.contact?.split(" ")[0] || "there";
  const lines = installments.map((i) => `${i.due_date}: ${i.amount.toFixed(2)} ${row.currency}`).join("\n");
  return {
    installments,
    rationale: `Demo mode: ${n} equal installments over about ${(n - 1) * 2} weeks for a ${row.daysOverdue}-day-late balance.`,
    subject: `A payment plan for invoice #${row.number}`,
    note: `Hi ${name}, to make invoice #${row.number} easier, you can pay it in ${n} parts:\n${lines}\nThe invoice now accepts partial payments, so you can use the same PayPal link for each part. Thank you! — ${config.business.name}`,
  };
}

function demoCopilot(rows) {
  const overdue = rows.filter((r) => r.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue);
  if (!overdue.length) return { answer: "Nothing is overdue right now. Nice work!", actions: [] };
  const top = overdue[0];
  return {
    answer: `${overdue.length} invoices are overdue. The oldest is ${top.client} (#${top.number}): ${top.due} ${top.currency}, ${top.daysOverdue} days late. (Demo mode: connect the AI for real answers.)`,
    actions: overdue.slice(0, 3).map((r) => {
      const tone = r.daysOverdue > 21 ? "final" : r.daysOverdue > 7 ? "firm" : "friendly";
      return { type: "remind", invoice_id: r.id, tone, label: `Nudge ${r.client} (${tone})` };
    }),
  };
}
