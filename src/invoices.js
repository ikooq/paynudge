// Conversions between the AI draft, the PayPal invoice object and the rows shown in the dashboard.

const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);
const OPEN_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING", "SCHEDULED", "SHARED"]);
const PAID_STATUSES = new Set(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"]);

export function todayISO(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function money(value, currency) {
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  return Number(value || 0).toFixed(digits);
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

// Cleans up whatever the model (or the user, after editing) sent back.
export function normalizeDraft(draft, defaultCurrency = "USD") {
  const warnings = (Array.isArray(draft.warnings) ? draft.warnings : []).map(String).filter(Boolean);
  const currency = /^[A-Z]{3}$/.test(String(draft.currency || "").toUpperCase())
    ? String(draft.currency).toUpperCase()
    : defaultCurrency;
  if (!/^[A-Z]{3}$/.test(String(draft.currency || "").toUpperCase())) warnings.push(`Currency was missing or invalid; verify the default ${defaultCurrency}.`);
  const inputItems = Array.isArray(draft.items) ? draft.items : [];
  if (inputItems.some((it) => !Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0 || !Number.isFinite(Number(it.unit_price)) || Number(it.unit_price) < 0)) {
    warnings.push("One or more quantities or prices were invalid and have been adjusted. Check every line item against the agreement.");
  }
  if (inputItems.some((it) => !String(it.name || "").trim())) warnings.push("An item without a name was omitted. Check the conversation for missing work.");
  if (draft.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(draft.due_date)) warnings.push("The payment date was invalid and has been cleared. Confirm the payment terms.");
  const items = inputItems
    .map((it) => ({
      name: String(it.name || "").trim().slice(0, 200),
      description: String(it.description || "").trim().slice(0, 1000),
      quantity: round2(it.quantity) > 0 ? round2(it.quantity) : 1,
      unit_price: Math.max(0, round2(it.unit_price)),
      evidence: String(it.evidence || "").slice(0, 300),
      evidence_source: ["chat", "screenshot transcript"].includes(it.evidence_source) ? it.evidence_source : "",
    }))
    .filter((it) => it.name);
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(draft.due_date || "") ? draft.due_date : "";
  return {
    client: {
      name: String(draft.client?.name || "").trim(),
      business_name: String(draft.client?.business_name || "").trim(),
      email: String(draft.client?.email || "").trim(),
    },
    currency,
    items,
    due_date: dueDate,
    due_on_receipt: draft.due_on_receipt === true,
    payment_terms_label: String(draft.payment_terms_label || "").trim(),
    note_to_client: String(draft.note_to_client || "").trim().slice(0, 4000),
    summary: String(draft.summary || "").trim(),
    conversation_language: String(draft.conversation_language || "English").trim(),
    warnings,
    total: round2(items.reduce((sum, it) => sum + it.quantity * it.unit_price, 0)),
  };
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return undefined;
  if (parts.length === 1) return { given_name: parts[0] };
  return { given_name: parts[0], surname: parts.slice(1).join(" ") };
}

// Builds the request body for POST /v2/invoicing/invoices.
export function buildPayPalInvoice(draft, business) {
  const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!Array.isArray(draft.items) || !draft.items.length) bad("The invoice needs at least one line item.");
  if (draft.items.length > 100) bad("An invoice can have at most 100 line items.");
  if (draft.items.some((item) => !String(item.name || "").trim() || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 || !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0)) {
    bad("Each item needs a name, a positive quantity, and a valid non-negative price.");
  }
  if (draft.items.some((item) => Math.abs(Number(item.quantity) * 100 - Math.round(Number(item.quantity) * 100)) > 1e-7 || Math.abs(Number(item.unit_price) * 100 - Math.round(Number(item.unit_price) * 100)) > 1e-7)) {
    bad("Quantities and prices may have at most two decimal places.");
  }
  if (draft.currency && !/^[A-Za-z]{3}$/.test(String(draft.currency))) bad("Enter a three-letter currency code.");
  if (draft.client?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.client.email)) bad("Enter a valid client email address.");
  if (draft.due_date && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.due_date) || Number.isNaN(Date.parse(`${draft.due_date}T00:00:00Z`)) || new Date(`${draft.due_date}T00:00:00Z`).toISOString().slice(0, 10) !== draft.due_date)) bad("Enter a valid due date.");
  if (!draft.due_date && draft.due_on_receipt !== true) bad("Choose a due date or explicitly confirm payment is due on receipt.");
  const d = normalizeDraft(draft, business.defaultCurrency);
  if (d.total <= 0) bad("The invoice total must be greater than zero.");
  if (ZERO_DECIMAL.has(d.currency) && d.items.some((item) => !Number.isInteger(item.unit_price))) bad(`${d.currency} prices must be whole amounts.`);

  const billing = {};
  const name = splitName(d.client.name);
  if (name) billing.name = name;
  if (d.client.business_name) billing.business_name = d.client.business_name;
  if (d.client.email) billing.email_address = d.client.email;

  // PayPal rejects due dates before the invoice date.
  if (d.due_date && d.due_date < todayISO()) throw Object.assign(new Error("The due date is in the past. Choose a current or future date before sending."), { status: 400 });

  const languageLine = `Conversation language: ${d.conversation_language.slice(0, 80)}`;
  const memoPrefix = "PayNudge memo: ";
  const memo = `${memoPrefix}${d.summary.slice(0, 500 - memoPrefix.length - languageLine.length - 1)}\n${languageLine}`;

  const invoice = {
    detail: {
      currency_code: d.currency,
      note: d.note_to_client || undefined,
      memo: memo.slice(0, 500),
      payment_term: d.due_date
        ? { term_type: "DUE_ON_DATE_SPECIFIED", due_date: d.due_date }
        : { term_type: "DUE_ON_RECEIPT" },
    },
    invoicer: {
      business_name: business.name,
      ...(business.email ? { email_address: business.email } : {}),
    },
    items: d.items.map((it) => ({
      name: it.name,
      ...(it.description ? { description: it.description } : {}),
      quantity: String(it.quantity),
      unit_amount: { currency_code: d.currency, value: money(it.unit_price, d.currency) },
      unit_of_measure: "QUANTITY",
    })),
    configuration: { allow_tip: false },
  };
  if (Object.keys(billing).length) invoice.primary_recipients = [{ billing_info: billing }];
  return { invoice, draft: d };
}

function fullName(name) {
  if (!name) return "";
  return name.full_name || [name.given_name, name.surname].filter(Boolean).join(" ");
}

function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000);
}

function nextAction(status, daysOverdue, daysUntilDue) {
  if (PAID_STATUSES.has(status)) return { key: "done", label: "Paid" };
  if (status === "DRAFT") return { key: "send", label: "Send draft" };
  if (status === "CANCELLED" || status.includes("REFUNDED")) return { key: "none", label: "Closed" };
  if (daysOverdue > 21) return { key: "final", label: "Final notice" };
  if (daysOverdue > 7) return { key: "firm", label: "Firm nudge" };
  if (daysOverdue > 0) return { key: "friendly", label: "Friendly nudge" };
  if (daysUntilDue !== null && daysUntilDue <= 2) return { key: "friendly", label: "Heads-up nudge" };
  return { key: "wait", label: daysUntilDue === null ? "Wait" : `Due in ${daysUntilDue}d` };
}

// Flattens a PayPal invoice into a dashboard row.
export function toRow(inv, today = todayISO()) {
  const billing = inv.primary_recipients?.[0]?.billing_info || {};
  const currency = inv.amount?.currency_code || inv.detail?.currency_code || "USD";
  const amount = Number(inv.amount?.value || 0);
  const paid = Number(inv.payments?.paid_amount?.value || 0);
  const status = inv.status || "DRAFT";
  const isOpen = OPEN_STATUSES.has(status);
  const due = isOpen ? Number(inv.due_amount?.value ?? amount - paid) : 0;
  const dueDate = inv.detail?.payment_term?.due_date || inv.detail?.invoice_date || "";
  const daysOverdue = isOpen && dueDate ? Math.max(0, daysBetween(dueDate, today)) : 0;
  const daysUntilDue = isOpen && dueDate ? daysBetween(today, dueDate) : null;
  const memo = inv.detail?.memo || "";
  const lang = /Conversation language:\s*(.+)/.exec(memo)?.[1]?.trim() || "English";

  return {
    id: inv.id,
    number: inv.detail?.invoice_number || "",
    status,
    client: billing.business_name || fullName(billing.name) || billing.email_address || "Shared link",
    contact: fullName(billing.name),
    email: billing.email_address || "",
    currency,
    amount,
    paid,
    due,
    invoiceDate: inv.detail?.invoice_date || "",
    dueDate,
    daysOverdue,
    lastSent: inv.detail?.metadata?.last_sent_time || "",
    firstSent: inv.detail?.metadata?.first_sent_time || "",
    payerUrl: inv.detail?.metadata?.recipient_view_url || "",
    merchantUrl: inv.detail?.metadata?.invoicer_view_url || "",
    items: (inv.items || []).map((it) => `${it.quantity} × ${it.name}`).join(", "),
    memo: memo.replace(/^PayNudge memo:\s*/, "").split("\n")[0],
    language: lang,
    nextAction: nextAction(status, daysOverdue, daysUntilDue),
  };
}

export function computeKpis(rows) {
  const sumBy = (filter, field) => {
    const totals = {};
    for (const r of rows.filter(filter)) totals[r.currency] = round2((totals[r.currency] || 0) + r[field]);
    return totals;
  };
  return {
    outstanding: sumBy((r) => OPEN_STATUSES.has(r.status), "due"),
    overdue: sumBy((r) => r.daysOverdue > 0, "due"),
    overdueCount: rows.filter((r) => r.daysOverdue > 0).length,
    collected: sumBy((r) => PAID_STATUSES.has(r.status) || r.paid > 0, "paid"),
    openCount: rows.filter((r) => OPEN_STATUSES.has(r.status)).length,
    total: rows.length,
  };
}
