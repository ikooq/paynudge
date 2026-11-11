// Fills your PayPal SANDBOX account with a few realistic, backdated invoices (some overdue,
// one paid) so the dashboard, the AI nudges and the copilot have something to work with.
// Safe to run twice: clients that already have an invoice are skipped.
//
//   npm run seed
import { config } from "../src/config.js";
import * as paypal from "../src/paypal.js";

if (!config.paypal.live || config.paypal.env !== "sandbox") {
  console.error("This script only runs against the PayPal sandbox. Set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET and PAYPAL_ENV=sandbox.");
  process.exit(1);
}

const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const invoices = [
  {
    business: "Northwind Labs", contact: ["Sam", "Patel"], email: "sam@northwind.dev", lang: "English", currency: "USD",
    memo: "Landing page redesign and two A/B variants; relaxed, long-term client.",
    items: [["Landing page redesign", 1, 1200], ["A/B test variant", 2, 150]], issued: -34, due: -26,
  },
  {
    business: "Kafe Arman", contact: ["Arman", "Bekov"], email: "arman@kafearman.kz", lang: "Russian", currency: "USD",
    memo: "Menu photography and retouching for a cafe in Almaty; friendly, informal.",
    items: [["Menu photography", 18, 20], ["Retouching", 18, 5]], issued: -19, due: -12,
  },
  {
    business: "Atelier Rosa", contact: ["Rosa", "Martín"], email: "rosa@atelierrosa.es", lang: "Spanish", currency: "EUR",
    memo: "Brand guidelines document; formal tone.",
    items: [["Brand guidelines", 1, 600]], issued: -12, due: -3,
  },
  {
    business: "Pixel & Pine", contact: ["Jordan", "Lee"], email: "jordan@pixelpine.io", lang: "English", currency: "USD",
    memo: "Monthly social media retainer for October.",
    items: [["Social media retainer (October)", 1, 800]], issued: -20, due: -6, paid: true,
  },
  {
    business: "Helio Studio", contact: ["Mira", "Novak"], email: "mira@heliostudio.co", lang: "English", currency: "USD",
    memo: "Explainer video storyboard; quick, friendly communication.",
    items: [["Storyboard frames", 12, 35], ["Script polish", 1, 90]], issued: -3, due: 11,
  },
];

const existing = new Set(
  (await paypal.listInvoices()).map((inv) => inv.primary_recipients?.[0]?.billing_info?.business_name).filter(Boolean),
);

for (const s of invoices) {
  if (existing.has(s.business)) {
    console.log(`- ${s.business}: already in the sandbox, skipped`);
    continue;
  }
  try {
    const created = await paypal.createDraftInvoice({
      detail: {
        currency_code: s.currency,
        invoice_date: day(s.issued),
        payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: day(s.due) },
        note: "Thank you for working with us!",
        memo: `PayNudge memo: ${s.memo}\nConversation language: ${s.lang}`,
      },
      invoicer: { business_name: config.business.name },
      primary_recipients: [
        { billing_info: { business_name: s.business, name: { given_name: s.contact[0], surname: s.contact[1] }, email_address: s.email } },
      ],
      items: s.items.map(([name, quantity, price]) => ({
        name,
        quantity: String(quantity),
        unit_amount: { currency_code: s.currency, value: price.toFixed(2) },
        unit_of_measure: "QUANTITY",
      })),
      configuration: { allow_tip: false },
    });
    await paypal.sendInvoice(created.id, { subject: `Invoice from ${config.business.name}`, sendToRecipient: true });
    if (s.paid) {
      const total = s.items.reduce((sum, [, q, p]) => sum + q * p, 0).toFixed(2);
      await paypal.recordPayment(created.id, { amount: total, currency: s.currency, date: day(s.due - 2), note: "Paid by bank transfer" });
    }
    const inv = await paypal.getInvoice(created.id);
    console.log(`✓ ${s.business}: #${inv.detail.invoice_number} ${inv.status}, due ${inv.detail.payment_term?.due_date}`);
  } catch (err) {
    console.log(`✗ ${s.business}: ${err.message}`);
    if (err.body) console.log("  ", JSON.stringify(err.body).slice(0, 400));
  }
}
