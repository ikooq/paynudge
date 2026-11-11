# PayNudge: from client chat to paid

**An AI receivables agent for freelancers and small businesses.** Paste a client conversation or drop a chat screenshot, in any language. AI (GPT-OSS 120B and Qwen 3.8 on Groq) drafts the invoice, the **PayPal Invoicing API** creates and sends it, and PayNudge follows up with AI-written reminders until the client pays.

**Live demo:** https://paynudge-sz4i.onrender.com (PayPal sandbox + Groq; the free instance may take up to a minute to wake up)

> Built for the PayPal AI Hackathon "Build What's Next with PayPal and AI".

## The problem

Freelancers agree on work in WhatsApp, Telegram and email threads, often in several languages. Then come the tedious parts: copying the scope into an invoice, remembering who hasn't paid, and writing awkward "just checking in…" messages. Late payments cost freelancers real money, and most never chase them consistently.

## What PayNudge does

1. **Chat → invoice.** Paste a conversation or upload screenshots. The AI finds the client, line items, quantities, prices, currency and due date ("pay within 10 days after delivery" becomes a date). It writes everything in English even when the chat is in Russian or Spanish, and it flags anything doubtful, such as a missing email or "about 20 photos".
2. **Human review, then PayPal.** Every field stays editable. One click creates the invoice through the PayPal Invoicing API and sends it, so the client gets PayPal's email with a "Pay" button. If there is no email, PayPal returns a payment link to drop into the chat.
3. **Receivables in one table.** An AG Grid dashboard reads invoice status live from PayPal: paid, sent, overdue and how late, with a suggested next step for each invoice.
4. **AI nudges, sent by PayPal.** For overdue invoices the AI writes a reminder in the tone that fits (friendly, firm or final notice) and in the client's original language. You approve it, and PayPal's `remind` endpoint emails it with the pay button.
5. **Collections autopilot.** One click and the agent works through the whole ledger: it picks every overdue invoice, chooses the tone from how late it is (1–7 days friendly, 8–21 firm, 21+ final notice), and writes each reminder in that client's language. You review the batch, untick or edit anything, and PayPal sends the approved reminders.
6. **Receivables copilot.** Ask "Who should I chase first?" The AI answers from your live PayPal data and proposes one-click actions.
7. **Insights and a live agent feed.** A receivables aging chart (not due, 1–7, 8–21, 21+ days) and an activity feed of everything the AI and PayPal did: drafts, sent invoices, reminders, payments.
8. **The payment moment.** After an invoice is sent, the dashboard watches PayPal. When the client pays, it announces "Bloom Coffee just paid $690", the row lights up and the KPIs update.

The AI never sends anything on its own. Every invoice and reminder is reviewed by a person first.

### Try it in 60 seconds (live demo)

1. Click **Try it with a sample chat**: the AI drafts an invoice from a real-looking client chat.
2. Click **Create & send via PayPal**, then **Open client's payment page** to see the real PayPal sandbox invoice.
3. Click **Collections autopilot** to watch the agent draft reminders for the overdue invoices in English, Russian and Spanish.
4. Ask the copilot "Who should I chase first?"

## How PayPal is used

| Step | PayPal API call |
|---|---|
| Authenticate | `POST /v1/oauth2/token` (client credentials) |
| Create invoice from the AI draft | `POST /v2/invoicing/invoices` |
| Send it, or create a share link | `POST /v2/invoicing/invoices/{id}/send` |
| Dashboard and copilot data | `GET /v2/invoicing/invoices` |
| Invoice details for a reminder | `GET /v2/invoicing/invoices/{id}` |
| Send the AI-written reminder | `POST /v2/invoicing/invoices/{id}/remind` |

PayPal is the source of truth: PayNudge has no database. The AI's deal summary and the client's language are kept in the invoice's private `memo` field, so later reminders have that context.

## How AI is used

PayNudge runs on **Groq's free plan** with two open models:

- **GPT-OSS 120B** (`openai/gpt-oss-120b`, medium reasoning) does the thinking: invoice extraction, reminders and the copilot. Every call uses **strict structured output**, so the response is constrained to a JSON schema and the app can act on it safely.
- **Qwen 3.8 27B** (`qwen/qwen3.8-27b`) only reads screenshots: it transcribes the chat to text, and GPT-OSS then builds the invoice from that transcript.

On the three sample chats (English, Russian, Spanish), the extraction gets the client, email, currency, every line item and the total right, in about 1.5–2.5 seconds. It also resolves "10 days after delivery by Friday" into a calendar date.

| Feature | Input | Output |
|---|---|---|
| Invoice extraction | chat text and/or screenshots (vision) | client, line items, currency, due date, warnings, private summary |
| Reminder writer | invoice facts, days overdue, chosen tone, original language | email subject and message for PayPal's reminder |
| Receivables copilot | question plus live invoice list from PayPal | short answer and up to 3 proposed actions |

If the main model hits its free quota or returns output that fails the schema, the request is retried once on `openai/gpt-oss-20b`. AI endpoints are also rate-limited per IP to protect a public demo.

The provider is swappable through `.env`: Groq (default), Google Gemini (`AI_PROVIDER=gemini`), or any OpenAI-compatible API (`AI_PROVIDER=openai` with `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`).

## Architecture

```mermaid
flowchart LR
  U[Seller in browser] -->|chat text / screenshots| S[Node.js + Express]
  S -->|screenshots| V[Qwen 3.8 on Groq]
  V -->|transcript| S
  S -->|structured output| C[GPT-OSS 120B on Groq]
  S -->|Invoicing API v2| P[PayPal sandbox]
  P -->|invoice email + Pay button| K[Client]
  S -->|rows + KPIs| G[AG Grid dashboard]
```

- `server.js`: REST API and static hosting
- `src/ai.js`: the three AI calls, their JSON schemas and the provider adapters
- `src/paypal.js`: PayPal Invoicing API client (OAuth token caching, idempotency keys)
- `src/invoices.js`: AI draft → PayPal invoice → dashboard row conversions
- `src/mockPaypal.js`: in-memory PayPal stand-in for demo mode
- `src/activity.js`: agent activity log and payment detection between refreshes
- `public/`: front end (vanilla JS + AG Grid Community)

## Run it locally

Requirements: Node.js 20 or newer.

```bash
git clone <this repo>
cd paynudge
npm install
```

**Option A: demo mode (no keys, 30 seconds).** Uses an in-memory PayPal and canned AI answers so you can click through the whole flow:

```bash
npm run demo
```

Open http://localhost:3000.

**Option B: real PayPal sandbox and AI.**

1. Create a sandbox app at [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → Sandbox → Create App. In the app's Features, make sure **Invoicing** is checked. Copy the client ID and secret.
2. Get a free Groq API key (no card needed) at [console.groq.com](https://console.groq.com) → API Keys → Create API Key.
3. Copy `.env.example` to `.env` and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `GROQ_API_KEY`.
4. Check the setup (uses no AI quota), then start:

```bash
npm run check
npm start
```

Optional: fill the sandbox with realistic demo invoices (three overdue, one paid, one upcoming, all backdated) so the dashboard, AI nudges and copilot have data to work with:

```bash
npm run seed
```

### Paying a sandbox invoice

1. In the PayPal developer dashboard, open Testing Tools → Sandbox Accounts and copy the email of the **Personal** sandbox account.
2. Put that email in the chat you paste (or in the Email field of the draft) and send the invoice.
3. Click **Open client's payment page** and log in with the personal sandbox account to pay.
4. Click refresh in PayNudge: the invoice moves to **Paid** and the KPIs update.

## Deploy to Render

The repo includes `render.yaml`. In Render: New → Blueprint → select this repo, then fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `GROQ_API_KEY`.

## Tools used

- **PayPal Developer Platform:** Invoicing API v2 in the sandbox environment
- **Groq API** (free plan): GPT-OSS 120B extracts invoices, writes reminders and answers copilot questions with strict structured output. Qwen 3.8 27B transcribes chat screenshots. GPT-OSS 20B is the fallback.
- **Google Gemini API** (optional, `@google/genai` SDK): alternative provider
- **AG Grid Community:** receivables table with sorting, search and pagination
- **Render:** hosting
- Node.js, Express, vanilla JavaScript

## License

MIT, see [LICENSE](LICENSE).
