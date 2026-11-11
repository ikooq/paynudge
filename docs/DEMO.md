# PayNudge: demo and judging guide

Use only PayPal sandbox accounts and fictional conversations. The deployed demo is shared, so do not paste confidential customer messages. The buyer and seller must be different sandbox accounts. Start the Render app ahead of time so the free instance can wake up. Confirm the current build is deployed before recording.

## Prepare

1. In PayPal Developer → Testing Tools → Sandbox Accounts, identify a **Personal** buyer account and its login credentials. Keep the password private. The app's PayPal sandbox credentials belong to the seller's **Business** account.
2. Open PayNudge and check the status chips say **PayPal Sandbox** and show a live AI provider. Demo mode uses mock payments and canned AI answers; do not present it as live integration.
3. Check there are overdue sandbox invoices for the collection plan. `npm run seed` creates sample invoices when run with sandbox credentials. Seeded data and its simulated external payment are examples, not evidence that a buyer paid through PayPal.
4. Prepare this fictional conversation, replacing the email with the Personal sandbox buyer's email:

   > Client: I approve the logo design for $1. Please invoice BUYER_SANDBOX_EMAIL. Payment is due on receipt.  
   > Freelancer: Confirmed. Thank you!

5. Record an actual sandbox payment at least once before filming. If the vision model's quota is exhausted, use pasted text or **Read screenshot locally**. Review the OCR text carefully and say which method is shown; do not imply the vision model succeeded when it did not.

## Suggested sequence (under three minutes)

- **0:00–0:20 — Problem.** Explain who it helps: freelancers turn an agreed chat into an invoice and review follow-ups without manually copying information.
- **0:20–0:55 — Draft.** Paste the conversation and generate a draft. Show the AI's source excerpt and review the $1 amount, the buyer email and payment terms. If no due date was extracted, explicitly select **Due on receipt**. Explain that a matching excerpt assists review but does not prove the agreement.
- **0:55–1:35 — PayPal sandbox.** Create the invoice, open the buyer page and show the sandbox buyer paying. Do not show passwords or real financial details. Return to PayNudge and show the invoice becoming **Paid** and the amounts updating. If the status does not update, stop and investigate; do not claim that the payment worked.
- **1:35–2:15 — Collections.** Show the aging filter and select overdue invoices in AG Grid. Prepare reminders, show their languages and tones, and explain that nothing is sent until the seller approves. If you actually send sandbox reminders, distinguish that action from the AI drafting them.
- **2:15–2:40 — Why it matters and limits.** Explain that PayPal supplies invoice and payment state, while AI helps interpret chats and draft messages. The collection plan prioritizes age using explicit rules; it is not a prediction. This prototype is a shared sandbox demo, not a production system with customer accounts.

Use a single uninterrupted recording where possible, or label any cuts and pre-seeded data clearly. Upload the final video publicly to YouTube and submit its URL on Devpost. Make sure it remains under three minutes.

## Judge access

- Live demo and setup instructions: see the repository README.
- `npm run demo` exercises the interface without API credentials using in-memory PayPal and canned AI responses. It is useful for exploration, not evidence of actual PayPal or live AI.
- `npm test` runs local automated tests. `npm run evaluate-ai` tests four synthetic examples against the configured live AI provider and consumes quota; it is not a measure of general accuracy.
- The reminder journal is single-instance local storage. Render's free filesystem can be reset. A durable production setup needs persistent storage and proper access control.
