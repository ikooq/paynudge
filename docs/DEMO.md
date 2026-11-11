# PayNudge: demo and judging guide

Use only PayPal sandbox accounts and fictional conversations. The deployed demo is shared, so do not paste confidential customer messages. The buyer and seller must be different sandbox accounts. Open the live site a few minutes before recording (a GitHub Action keeps it awake, but check), and confirm the current build in `/api/status` (`build`).

## Prepare

1. In PayPal Developer → Testing Tools → Sandbox Accounts, identify a **Personal** buyer account and its login. Keep the password private. The app's PayPal sandbox credentials belong to the seller's **Business** account.
2. Open PayNudge and check the header chips say **PayPal Sandbox** and **AI · Groq**. Demo mode uses mock payments and canned AI answers; do not present it as the live integration.
3. Check there are overdue sandbox invoices (`npm run seed` creates them with sandbox credentials). Seeded data and its manually recorded payment are examples, not evidence that a buyer paid through PayPal; the dashboard labels that payment "Recorded paid".
4. Prepare this fictional chat, replacing the email with the Personal sandbox buyer's email:

   > Client: I approve the logo design for $1. Please invoice BUYER_SANDBOX_EMAIL. Payment is due within 7 days.
   > Freelancer: Confirmed. Thank you!

5. Optional voice clip: on a phone or the laptop, record yourself saying "Invoice Dana from Northbay Studio, website redesign nine hundred dollars, payment within two weeks." Do not dictate an email address; voice recognition rarely gets it right, and the app flags it rather than guessing.
6. Rehearse one real sandbox payment before filming. If the screenshot model's quota is exhausted, paste the text or use **Read screenshot locally** and say which method is shown.

## Suggested sequence (2:50 at most)

- **0:00–0:15 — Problem and promise.** "Freelancers agree on work in chats, in any language. PayNudge turns that chat into a PayPal invoice, shows the client's own words behind every line, and when a client is late, offers a payment plan PayPal collects in parts."
- **0:15–0:45 — Voice note → draft.** Click **Voice note**, say the clip, stop. The transcript appears in the chat box and the draft follows. Point at the quote under each line item and the totals. Mention: the AI never sends anything; you review every field.
- **0:45–1:05 — Any language.** Click the **Russian chat** sample, draft it. Show the English invoice with Russian quotes as evidence.
- **1:05–1:45 — PayPal for real.** Paste the $1 chat, draft, **Create & send via PayPal**, open the client's payment page, pay as the sandbox buyer (hide the password). Back in PayNudge: "just paid", the row turns green, Collected rises. If it does not update within 20 seconds, stop and investigate; do not claim it worked.
- **1:45–2:25 — Payment plan.** In **Invoices**, click **Overdue**, then **Plan** on Northwind Labs. The AI proposes installments that add up exactly to the balance and writes the message in the client's language. Change one amount to show the live check turn red, fix it, approve. Explain: PayPal now accepts partial payments on the same invoice, and the schedule lives in the invoice in PayPal. Show the row change to "Plan 1/3".
- **2:25–2:50 — Table and honesty.** Show the quick views, the paid-progress bar with plan ticks, the per-currency totals and **Export CSV**. Close with the measured result (16 of 16 test chats correct, quotes on 18 of 18 items) and one limit stated plainly: one shared sandbox seller, no login, a hackathon prototype.

Record in one take where possible, or mark cuts and pre-seeded data clearly. No background music unless you hold the rights. Upload publicly to YouTube and submit the URL on Devpost; keep it under three minutes.

## Judge access

- Live demo, features, PayPal calls and limits: the repository README.
- `npm run demo` runs the interface without credentials (in-memory PayPal, canned AI). Useful for exploring, not evidence of the live integration.
- `npm test` runs 13 automated tests. `npm run evaluate-ai` sends 16 synthetic chats to the configured live AI and writes `docs/AI-EVAL.md` (consumes quota; not a measure of general accuracy).
- What is verified live and what is not (webhooks, partial payment by a real buyer, live voice) is listed in the README under "Payment updates" and "Known limitations".
