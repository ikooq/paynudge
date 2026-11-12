# Devpost submission text

Copy each block into the matching Devpost field.

## Project name
PayNudge

## Tagline (short description)
Turn a client chat, screenshot or voice note into a PayPal invoice with source excerpts when found, and offer late clients a payment plan payable in parts.

## Links
- Live demo: https://paynudge-sz4i.onrender.com
- Code (MIT): https://github.com/ikooq/paynudge
- Video: https://youtu.be/J-J2dkYSYvA

---

## Inspiration
Freelancers close deals in Telegram, WhatsApp and email, often in two or three languages. Getting paid then means retyping the scope into an invoice, remembering who has not paid, and writing awkward "just checking in" messages. When a client is late, the usual tools only add pressure: another reminder, then a sterner one. We wanted the path from "Deal!" in a chat to money in PayPal to take seconds, and a late client to get an easier way to pay instead of a louder reminder.

## What it does
**1. Chat, screenshot or voice note → PayPal invoice.** The AI drafts line items, contact details and terms from the source. When it finds a matching excerpt, it shows it beneath the item; missing excerpts are flagged for review. A text match does not prove the client agreed to the work or price.

**2. Human review, then PayPal.** Every field is editable and validated (exact totals, real dates, valid email). One click creates and sends the invoice through the PayPal Invoicing API; the client gets PayPal's email with a Pay button, or a share link if there is no email.

**3. Payment plans instead of pressure.** For a late invoice, PayNudge proposes installments and a message. The seller reviews them before PayPal accepts partial payments and emails the offer. The exact schedule is generated from the reviewed figures. The invoice remains overdue until the seller records that the client agreed; only then does the dashboard use the plan dates for lateness. This confirmation is recorded by the seller, not verified automatically with the client.

**4. Reminders in the client's language.** Friendly, firm or final, chosen by how late an invoice is, drafted by the AI in the language the client used, sent by PayPal's remind endpoint after the seller approves. A batch view prepares several at once and holds back anyone contacted recently.

**5. A live receivables desk (AG Grid).** Status read live from PayPal, quick views (open, overdue, on a plan, paid), column filters, a paid-progress bar with ticks for each plan installment, per-currency totals that never mix currencies, CSV export, an aging chart, an activity feed and a copilot that answers "Who should I chase first?" from live PayPal data. When a client pays, the dashboard announces it and the row turns green.

**6. Straight from Telegram.** Forward a client conversation (text, screenshots or a voice note) to the PayNudge bot. It replies with the draft and the client's words behind each line; one tap creates and sends the PayPal invoice and returns the payment link. Chats link to a seller with a one-time code. Tested live: a forwarded chat became sandbox invoice #0010 (690.00 USD).

**7. Today's approvals.** Each morning the agent prepares the day's work: reminders for overdue invoices not contacted recently, payment-plan offers for invoices more than 21 days late, and recurring invoices for regular clients. The seller approves or skips each item; approval runs through the same checked PayPal calls as the manual flows.

**8. Price list and insights.** A seller's price list fills a price the chat left out and flags a chat price that differs from it (the model sees service names, never prices). Insights show median days to pay, share paid on time, money collected on payment plans and payments after a reminder, computed from the seller's own PayPal invoices with the sample size shown.

Nothing is sent without the seller's approval.

## How we built it
- **PayPal Developer Platform (sandbox), Invoicing API v2:** create, send, list, get, remind, full update (PUT) to turn on `partial_payment` for plans, record payment for seed data, idempotent create and send with `PayPal-Request-Id`, and a webhook receiver that verifies every delivery with `verify-webhook-signature`.
- **AI on Groq (free plan):** GPT-OSS 120B with strict JSON-schema output for invoice extraction, reminders, payment plans and the copilot; Qwen 3.8 27B to transcribe chat screenshots; Whisper large v3 turbo for voice notes; GPT-OSS 20B as a fallback. The provider is swappable (Gemini or any OpenAI-compatible API).
- **Server:** Node.js and Express; PayPal is the source of truth (no database): the deal summary, client language and payment plan live in the invoice's private memo.
- **Front end:** vanilla JavaScript, AG Grid Community, Tesseract.js for an on-device OCR fallback.
- **Hosting:** Render (Blueprint from `render.yaml`), with the server pinging its own public URL so the free instance stays awake.
- **Storage:** Neon Postgres for reminder history, price lists, recurring schedules, the approval queue and Telegram links (PayPal stays the source of truth for invoices).
- **Telegram Bot API:** webhook with a secret-token check; chats link to a seller with a one-time code.
- **Your own PayPal:** a seller connects their own PayPal sandbox REST app (Client ID and Secret, verified with PayPal, stored encrypted, never shown again); every PayPal call from their browser then uses their own token, and their price list, queue, recurring invoices and Telegram link are kept separately. PayPal partner onboarding is also built, but the sandbox refuses it without partner approval, so it stays off.
- **Quality:** automated tests cover invoice totals, dates, retries, reminder safety, payment-plan state, webhook handling and reuse of identical AI drafts; an evaluation script runs selected checks over 16 synthetic chats.

## AI tools used and how
| Tool | Used for |
|---|---|
| GPT-OSS 120B (Groq) | Reads chats and transcripts into a structured invoice draft with a source quote per line; writes reminders and payment-plan messages in the client's language; answers copilot questions from live PayPal data |
| Qwen 3.8 27B (Groq) | Transcribes chat screenshots into text before extraction |
| Whisper large v3 turbo (Groq) | Transcribes voice notes |
| GPT-OSS 20B (Groq) | Fallback when the main model is rate-limited or misses the schema |
| Claude Code | Pair-programming assistant during development |

## Challenges we ran into
- **Free AI access.** Our first two providers were not usable on a free tier for us, so we built a provider layer and moved to Groq; screenshot transcription still hits the free vision quota at times, so we added an on-device OCR fallback.
- **Models break schemas occasionally.** We use strict JSON schemas, ask the main model once more on a miss, then fall back, and validate every number on the server.
- **PayPal details.** Access tokens are cached for hours, so a newly enabled Invoicing permission did not appear until we requested a fresh token; the invoice list omits configuration, so plan settings are confirmed with a single-invoice read.
- **Honest money.** Invoice math must be exact: plan installments must add up to the cent, currencies are never summed together, and a manually recorded payment is labelled differently from a PayPal payment.

## Accomplishments that we're proud of
- In one run of 16 synthetic chats in English, Russian, Spanish and Kazakh, all 16 passed their selected checks and 18 of 18 extracted items carried a matching quote. Median time was 1.9 seconds. Each case checks only a subset of fields; the result does not establish general accuracy.
- Real sandbox payments: invoices #0008, #0009 and #0003 were paid by a sandbox buyer and shown as paid via PayPal. For #0003, after an AI payment plan was sent, the dashboard announced the payment and PayPal then delivered a signed `INVOICING.INVOICE.PAID` webhook, which the server verified with PayPal.
- A real PayPal invoice switched to installments by a payment plan (`allow_partial_payment: true`, minimum $135, schedule 180 + 135 + 135 = 450 USD, message in Russian).
- English and Russian voice notes turned into correct invoices ($950 and $350).

## What we learned
Matching source excerpts can make a draft easier to review, though they do not prove agreement. Offering partial payments is a possible alternative to a sterner reminder; its impact on collection rates has not been measured.

## What's next for PayNudge
- Applying for PayPal partner access to switch on per-seller PayPal connection (the onboarding flow is built; the sandbox refuses it without partner approval).
- WhatsApp alongside Telegram.
- Testing a single-installment payment by a real buyer, and testing with real freelancers to measure time saved and days-to-paid.

## Honest limits (shown in the README)
One shared sandbox seller and no login; reminder history on the free host can reset on redeploy; screenshot reading depends on a free vision quota; one real signed PayPal webhook was received and verified, but the sandbox did not emit an event in an earlier test, so polling (every 4–15 seconds) stays the primary way payments are detected; a sandbox buyer paid a plan invoice in full, but paying a single installment was tested only in demo mode; the AI evaluation uses synthetic chats.

## Built with
paypal, paypal-invoicing-api, groq, gpt-oss, qwen, whisper, node.js, express, javascript, ag-grid, tesseract.js, render, github-actions

## Was this project updated significantly during the submission period?
PayNudge was created from scratch during the submission period (first commit November 10, 2026).
