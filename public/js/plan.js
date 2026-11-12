import { $, api, esc, fmt, icon, state, toast } from "./helpers.js";
import { confetti } from "./celebrate.js";
import { loadInvoices } from "./tabs.js";

// ---------------------------------------------------------------------------------------------
// Payment plan agent: the AI proposes installments + a message in the client's language, the
// seller edits and approves, PayPal accepts partial payments and emails the plan.
// ---------------------------------------------------------------------------------------------
export const plan = { row: null, installments: [], request: 0 };

export function planTitle(r) {
  if (!r.plan) return "";
  return r.plan.installments.map((i, k) => `${k + 1}. ${i.due_date}: ${fmt(i.amount, r.currency)}`).join("\n") + `\nPaid so far: ${fmt(r.paid, r.currency)}`;
}

export function renderPlanSchedule() {
  const r = plan.row;
  $("#planSchedule").innerHTML = plan.installments.length
    ? `<div class="plan-row plan-head"><span>#</span><span>Due date</span><span>Amount (${esc(r.currency)})</span><span></span></div>` +
      plan.installments
        .map(
          (i, k) => `<div class="plan-row">
            <span class="plan-rank">${k + 1}</span>
            <input type="date" data-k="${k}" data-f="due_date" value="${esc(i.due_date)}" aria-label="Installment ${k + 1} date">
            <input type="number" min="0" step="0.01" class="num" data-k="${k}" data-f="amount" value="${esc(i.amount)}" aria-label="Installment ${k + 1} amount">
            <button type="button" class="remove" data-remove-inst="${k}" aria-label="Remove installment" ${plan.installments.length <= 2 ? "disabled" : ""}>${icon.trash}</button>
          </div>`,
        )
        .join("") +
      (plan.installments.length < 4 ? '<button type="button" class="add-line" id="planAdd">+ Add installment</button>' : "")
    : '<div class="skeleton tall"></div>';
  checkPlan();
}

// Live check mirrors the server rule: 2–4 parts, dates in order, sum equals the balance.
export function checkPlan() {
  const r = plan.row;
  const list = plan.installments;
  const sum = list.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const diff = Math.round((r.due - sum) * 100) / 100;
  const ordered = list.every((i, k) => i.due_date && (k === 0 || i.due_date > list[k - 1].due_date));
  const today = new Date().toISOString().slice(0, 10);
  const decimals = ["JPY", "HUF", "TWD"].includes(r.currency) ? 0 : 2;
  $("#planMessagePreview").textContent = list.map((i) => `${i.due_date || "—"}: ${Number(i.amount || 0).toFixed(decimals)} ${r.currency}`).join("\n");
  let msg = "";
  if (list.length < 2) msg = "Add at least 2 installments.";
  else if (!ordered) msg = "Dates must be in order, one installment per date.";
  else if (list[0].due_date < today) msg = "The first installment cannot be in the past.";
  else if (list.some((i) => !Number.isFinite(Number(i.amount)) || Number(i.amount) <= 0)) msg = "Each installment must have a positive amount.";
  else if (Math.abs(diff) > 0.009) msg = `Installments add up to ${fmt(sum, r.currency)}; the balance is ${fmt(r.due, r.currency)} (${diff > 0 ? "missing" : "over by"} ${fmt(Math.abs(diff), r.currency)}).`;
  else if (/\p{N}/u.test($("#planNote").value)) msg = "Remove numbers from the introduction; the exact schedule is added automatically.";
  const ok = !msg && list.length;
  $("#planCheck").className = `plan-check ${ok ? "ok" : "bad"}`;
  $("#planCheck").textContent = ok ? `✓ ${list.length} installments add up exactly to ${fmt(r.due, r.currency)}.` : msg;
  $("#planSend").disabled = !ok || !$("#planSubject").value.trim() || !$("#planNote").value.trim();
}

export async function draftPlan() {
  const id = ++plan.request;
  plan.installments = [];
  renderPlanSchedule();
  $("#planWhy").textContent = "The AI is drafting a plan…";
  $("#planSubject").value = "";
  $("#planNote").value = "";
  $("#planNote").placeholder = "The AI is writing the message…";
  try {
    const p = await api(`/api/invoices/${encodeURIComponent(plan.row.id)}/plan-draft`, { method: "POST", body: {} });
    if (id !== plan.request) return;
    plan.installments = p.installments;
    $("#planWhy").textContent = [p.rationale, p.adjusted].filter(Boolean).join(" ");
    $("#planSubject").value = p.subject;
    $("#planNote").value = p.note;
    renderPlanSchedule();
  } catch (err) {
    if (id !== plan.request) return;
    $("#planWhy").textContent = err.message;
    plan.installments = [];
    renderPlanSchedule();
  } finally {
    if (id === plan.request) $("#planNote").placeholder = "";
  }
}

export function openPlan(row) {
  plan.row = row;
  $("#planDialogTitle").textContent = `Payment plan for ${row.client}`;
  $("#planMeta").textContent = `Invoice #${row.number} · ${fmt(row.due, row.currency)} due · ${row.daysOverdue} days late · message in ${row.language}`;
  if ($("#nudgeDialog").open) $("#nudgeDialog").close();
  $("#planDialog").showModal();
  draftPlan();
}

export async function sendPlan() {
  const r = plan.row;
  const btn = $("#planSend");
  btn.disabled = true;
  btn.textContent = "Updating PayPal…";
  const body = { installments: plan.installments.map((i) => ({ due_date: i.due_date, amount: Number(i.amount) })), subject: $("#planSubject").value, note: $("#planNote").value };
  const path = `/api/invoices/${encodeURIComponent(r.id)}/plan`;
  try {
    try {
      await api(path, { method: "POST", body });
    } catch (err) {
      if (!err.repeatConfirmationRequired || !confirm(`${err.message}\n\nSend the payment plan to ${r.client} anyway?`)) throw err;
      await api(path, { method: "POST", body: { ...body, confirmRepeat: true } });
    }
    $("#planDialog").close();
    toast(`Payment plan sent via PayPal. ${r.client} can now pay in ${body.installments.length} parts.`);
    confetti();
    loadInvoices();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.textContent = "Approve & send via PayPal";
    checkPlan();
  }
}

export function setupPlan() {
  $("#planClose").addEventListener("click", () => $("#planDialog").close());
  $("#planRegen").addEventListener("click", draftPlan);
  $("#planSend").addEventListener("click", sendPlan);
  $("#planSchedule").addEventListener("input", (e) => {
    const { k, f } = e.target.dataset;
    if (k === undefined) return;
    plan.installments[k][f] = f === "amount" ? Number(e.target.value) : e.target.value;
    checkPlan();
  });
  $("#planSchedule").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove-inst]");
    if (rm) {
      plan.installments.splice(Number(rm.dataset.removeInst), 1);
      renderPlanSchedule();
    } else if (e.target.closest("#planAdd")) {
      const last = plan.installments.at(-1);
      const d = new Date(`${last?.due_date || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 14);
      plan.installments.push({ due_date: d.toISOString().slice(0, 10), amount: 0 });
      renderPlanSchedule();
    }
  });
  for (const id of ["#planSubject", "#planNote"]) $(id).addEventListener("input", checkPlan);
  $("#nudgePlanBtn")?.addEventListener("click", () => state.nudge?.row && openPlan(state.nudge.row));
}
