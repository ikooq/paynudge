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

// --- Payment plans -------------------------------------------------------------------------------
// A plan lives in the invoice's private memo in PayPal, so it survives restarts and redeploys:
//   "Payment plan: 2026-11-15 500.00; 2026-12-01 500.00; 2026-12-15 500.00 USD"
const PLAN_RE = /^Payment plan:\s*(.+?)\s+([A-Z]{3})\s*$/m;

export function formatPlanLine(installments, currency) {
  return `Payment plan: ${installments.map((i) => `${i.due_date} ${money(i.amount, currency)}`).join("; ")} ${currency}`;
}

// Keep the schedule out of model-generated prose: append the approved numbers ourselves.
export function composePlanMessage(intro, installments, currency) {
  const text = String(intro || "").trim();
  if (!text) throw Object.assign(new Error("A message introduction is required."), { status: 400 });
  if (/\p{N}/u.test(text)) throw Object.assign(new Error("Remove numbers from the message introduction; the approved dates and amounts are added automatically."), { status: 400 });
  const schedule = installments.map((item) => `${item.due_date}: ${money(item.amount, currency)} ${currency}`).join("\n");
  const message = `${text}\n\n${schedule}`;
  if (message.length > 1000) throw Object.assign(new Error("The message and schedule must fit within 1000 characters."), { status: 400 });
  return message;
}

export function parsePlan(memo) {
  const m = PLAN_RE.exec(memo || "");
  if (!m) return null;
  const installments = m[1].split(";").map((part) => {
    const [due_date, amount] = part.trim().split(/\s+/);
    return { due_date, amount: Number(amount) };
  }).filter((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.due_date) && Number.isFinite(i.amount));
  const state = /^Payment plan state: (offered|accepted); paid_before: (\d+(?:\.\d{1,2})?)$/m.exec(memo || "");
  return installments.length ? { installments, currency: m[2], status: state?.[1] || "unknown", paidBefore: state ? Number(state[2]) : null } : null;
}

// Where the client is in the plan: the next unpaid installment, given how much PayPal says is paid.
export function planProgress(plan, paid, today = todayISO()) {
  if (plan.paidBefore == null || !Number.isFinite(plan.paidBefore)) return null;
  const paidTowardPlan = Math.max(0, paid - plan.paidBefore);
  let cumulative = 0;
  for (const [i, inst] of plan.installments.entries()) {
    cumulative = round2(cumulative + inst.amount);
    if (paidTowardPlan + 0.005 < cumulative) {
      return { index: i, count: plan.installments.length, next: inst, behind: inst.due_date < today, remainingInNext: round2(cumulative - paidTowardPlan) };
    }
  }
  return { index: plan.installments.length, count: plan.installments.length, next: null, behind: false, remainingInNext: 0 };
}

// Checks (and gently repairs) a proposed plan so the money adds up exactly.
export function validatePlan(installments, due, currency, today = todayISO()) {
  const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const list = (installments || []).map((i) => ({ due_date: String(i.due_date || ""), amount: Number(i.amount) }));
  if (list.length < 2 || list.length > 4) bad("A payment plan needs 2 to 4 installments.");
  for (const i of list) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.due_date) || Number.isNaN(Date.parse(`${i.due_date}T00:00:00Z`)) || new Date(`${i.due_date}T00:00:00Z`).toISOString().slice(0, 10) !== i.due_date) bad("Every installment needs a valid date.");
    if (!Number.isFinite(i.amount) || i.amount <= 0) bad("Every installment needs a positive amount.");
  }
  if (list[0].due_date < today) bad("The first installment cannot be in the past.");
  for (let k = 1; k < list.length; k++) if (list[k].due_date <= list[k - 1].due_date) bad("Installment dates must be in order, one per date.");
  if (daysBetween(today, list[list.length - 1].due_date) > 90) bad("Keep the whole plan within 90 days.");
  const factor = 10 ** digits;
  const rounded = list.map((i) => ({ ...i, amount: Math.round(i.amount * factor) / factor }));
  const sum = rounded.reduce((s, i) => s + i.amount, 0);
  const diff = Math.round((due - sum) * factor) / factor;
  if (Math.abs(diff) > Math.max(1, rounded.length - 1) / factor + 1e-9) bad(`Installments add up to ${sum.toFixed(digits)} ${currency}, but ${due.toFixed(digits)} ${currency} is due.`);
  // Absorb rounding cents in the last installment so the plan equals the balance exactly.
  rounded[rounded.length - 1].amount = Math.round((rounded[rounded.length - 1].amount + diff) * factor) / factor;
  if (rounded[rounded.length - 1].amount <= 0) bad("The last installment must be positive.");
  return rounded;
}

function nextAction(status, daysOverdue, daysUntilDue, progress) {
  if (PAID_STATUSES.has(status)) return { key: "done", label: "Paid" };
  if (progress?.next) {
    const n = progress.next;
    return progress.behind
      ? { key: "friendly", label: `Plan ${progress.index + 1}/${progress.count} late` }
      : { key: "plan", label: `Plan ${progress.index + 1}/${progress.count} · ${n.due_date.slice(5)}` };
  }
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
  const paid = Number(inv.payments?.paid_amount?.value ?? (inv.due_amount?.value != null ? Math.max(0, amount - Number(inv.due_amount.value)) : 0));
  const status = inv.status || "DRAFT";
  const isOpen = OPEN_STATUSES.has(status);
  const due = isOpen ? Number(inv.due_amount?.value ?? amount - paid) : 0;
  const dueDate = inv.detail?.payment_term?.due_date || inv.detail?.invoice_date || "";
  let daysOverdue = isOpen && dueDate ? Math.max(0, daysBetween(dueDate, today)) : 0;
  const daysUntilDue = isOpen && dueDate ? daysBetween(today, dueDate) : null;
  const memo = inv.detail?.memo || "";
  const lang = /Conversation language:\s*(.+)/.exec(memo)?.[1]?.trim() || "English";
  const anyPlan = parsePlan(memo);
  const plan = isOpen ? anyPlan : null;
  const paidDates = (inv.payments?.transactions || []).map((t) => String(t.payment_date || "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const progress = plan ? planProgress(plan, paid, today) : null;
  // A client keeping to an agreed plan is not overdue; a missed installment is late from its own date.
  if (plan?.status === "accepted" && progress?.next) daysOverdue = Math.max(0, daysBetween(progress.next.due_date, today));

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
    plan: plan ? { ...plan, progress } : null,
    hadPlan: Boolean(anyPlan),
    paidAt: PAID_STATUSES.has(status) || due === 0 ? paidDates.at(-1) || "" : "",
    firstPaymentAt: paidDates[0] || "",
    // PayPal's invoice list omits `configuration`; only the single-invoice call returns it. null = unknown.
    partialAllowed: inv.configuration ? Boolean(inv.configuration.partial_payment?.allow_partial_payment) : null,
    nextAction: nextAction(status, daysOverdue, daysUntilDue, plan?.status === "accepted" ? progress : null),
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
    // PAID = the client paid through PayPal; MARKED_AS_PAID / PAID_EXTERNAL = recorded by the seller.
    collectedViaPayPal: sumBy((r) => r.status === "PAID", "paid"),
    collectedRecorded: sumBy((r) => r.status !== "PAID" && (PAID_STATUSES.has(r.status) || r.paid > 0), "paid"),
    openCount: rows.filter((r) => OPEN_STATUSES.has(r.status)).length,
    total: rows.length,
  };
}
