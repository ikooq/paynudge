import { $, $$, api, esc, fmt, fmtDate, sendReviewedReminder, state, toast } from "./helpers.js";
import { loadInvoices } from "./tabs.js";

// ---------------------------------------------------------------------------------------------
// Today's approvals: the agent prepares reminders, payment-plan offers and recurring invoices each
// morning; the seller approves (PayPal sends it through the usual checked endpoint) or skips each.
// ---------------------------------------------------------------------------------------------
let queue = null;
let busy = false;

const KIND = {
  reminder: (i) => `${i.tone === "final" ? "Final notice" : i.tone === "firm" ? "Firm reminder" : "Friendly reminder"} · ${i.daysOverdue} days overdue`,
  plan: (i) => `Payment plan offer · ${i.daysOverdue} days overdue`,
  recurring: (i) => `Recurring ${i.interval} invoice · for ${fmtDate(i.nextDate)}`,
};

function card(i) {
  const done = i.status !== "pending";
  const amount = fmt(i.due, i.currency);
  const body =
    i.kind === "recurring"
      ? `<ul class="q-items">${i.items.map((it) => `<li>${esc(it.quantity)} × ${esc(it.name)} <span>${fmt(it.quantity * it.unit_price, i.currency)}</span></li>`).join("")}</ul>
         <p class="muted">PayPal emails the invoice to ${esc(i.email)}.</p>`
      : `<label class="field"><span>Subject</span><input data-q="subject" value="${esc(i.subject)}" maxlength="200" ${done ? "disabled" : ""}></label>
         <label class="field"><span>Message <em class="muted">in ${esc(i.language)}</em></span><textarea data-q="note" rows="4" maxlength="1000" ${done ? "disabled" : ""}>${esc(i.note)}</textarea></label>
         ${i.kind === "plan" ? `<p class="q-plan">${i.installments.map((p) => `${fmtDate(p.due_date)}: ${fmt(p.amount, i.currency)}`).join(" · ")}</p><p class="muted">On approval PayPal accepts partial payments on this invoice and emails the offer; the schedule is appended to the message.</p>` : ""}`;
  const status = done
    ? `<span class="q-status ${i.status}">${i.status === "approved" ? "Sent via PayPal" : i.status === "skipped" ? "Skipped" : "Failed"}${i.result ? ` · ${esc(i.result)}` : ""}</span>`
    : `<button class="btn ghost" type="button" data-skip>Skip</button><button class="btn primary" type="button" data-approve>${i.kind === "recurring" ? "Approve &amp; send invoice" : "Approve &amp; send via PayPal"}</button>`;
  return `<article class="q-card${done ? " is-done" : ""}" data-id="${esc(i.id)}">
    <header><div><b>${esc(i.client)}</b>${i.number ? ` <span class="muted">#${esc(i.number)}</span>` : ""}<p class="muted">${esc(KIND[i.kind](i))}</p></div><strong>${amount}</strong></header>
    ${body}
    <footer>${status}</footer>
  </article>`;
}

function render() {
  const list = $("#approvalsList");
  const pending = queue?.items.filter((i) => i.status === "pending").length || 0;
  const count = $("#approvalCount");
  count.hidden = !pending;
  count.textContent = pending;
  if (!queue) {
    list.innerHTML = `<p class="muted">No queue for today yet. Choose “Prepare today's queue” and the agent drafts what needs doing.</p>`;
    $("#approvalsBuild").textContent = "Prepare today's queue";
    return;
  }
  $("#approvalsBuild").textContent = "Prepare again";
  $("#approvalsMeta").textContent = `Prepared ${new Date(queue.builtAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${pending} waiting for you · nothing is sent until you approve it.`;
  list.innerHTML = queue.items.length
    ? queue.items.map(card).join("") + (queue.skipped?.length ? `<p class="muted">Could not draft: ${queue.skipped.map(esc).join("; ")}</p>` : "")
    : `<p class="muted">Nothing needs you today: no overdue invoice without recent contact, and no recurring invoice due.</p>`;
}

export async function loadQueue() {
  try {
    queue = (await api("/api/queue")).queue;
    render();
  } catch (err) {
    $("#approvalsList").innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function build(rebuild) {
  if (busy) return;
  busy = true;
  const button = $("#approvalsBuild");
  button.disabled = true;
  $("#approvalsList").innerHTML = `<p class="muted">The agent is checking PayPal and drafting today's messages…</p>`;
  try {
    queue = (await api("/api/queue/build", { method: "POST", body: { rebuild } })).queue;
    render();
  } catch (err) {
    toast(err.message, "error");
    render();
  } finally {
    busy = false;
    button.disabled = false;
  }
}

async function mark(item, status, result = "") {
  const { item: saved } = await api(`/api/queue/${encodeURIComponent(item.id)}`, { method: "POST", body: { status, result } });
  Object.assign(item, saved);
}

async function approve(item, el) {
  const subject = $("[data-q=subject]", el)?.value.trim();
  const note = $("[data-q=note]", el)?.value.trim();
  if (item.kind === "reminder") {
    await sendReviewedReminder({ id: item.invoiceId, client: item.client, number: item.number }, subject, note);
    await mark(item, "approved", `${item.tone} reminder emailed`);
  } else if (item.kind === "plan") {
    const path = `/api/invoices/${encodeURIComponent(item.invoiceId)}/plan`;
    const body = { subject, note, installments: item.installments };
    try {
      await api(path, { method: "POST", body });
    } catch (err) {
      if (!err.repeatConfirmationRequired || !confirm(`${err.message}\n\nSend the plan to ${item.client} anyway?`)) throw err;
      await api(path, { method: "POST", body: { ...body, confirmRepeat: true } });
    }
    await mark(item, "approved", `${item.installments.length}-part plan offered`);
  } else {
    const { draft, forDate } = await api(`/api/recurring/${encodeURIComponent(item.recurringId)}/draft`);
    if (forDate !== item.nextDate) throw new Error("This recurring invoice was already issued. Prepare the queue again.");
    // The queue item's ID is the PayPal request ID, so a retry can't create a second invoice.
    const { row } = await api("/api/invoices", { method: "POST", body: { operationId: item.id, draft } });
    await api(`/api/recurring/${encodeURIComponent(item.recurringId)}/issued`, { method: "POST", body: { forDate, invoiceId: row.id } });
    await mark(item, "approved", `invoice #${row.number} sent`);
  }
  state.watchUntil = Date.now() + 120_000;
  loadInvoices();
}

export function setupQueue() {
  $("#approvalsBuild").addEventListener("click", () => build(Boolean(queue)));
  $("#approvalsList").addEventListener("input", (e) => {
    const el = e.target.closest(".q-card");
    const item = el && queue?.items.find((i) => i.id === el.dataset.id);
    if (item && e.target.dataset.q) item[e.target.dataset.q] = e.target.value;
  });
  $("#approvalsList").addEventListener("click", async (e) => {
    const button = e.target.closest("[data-approve], [data-skip]");
    const el = button?.closest(".q-card");
    const item = el && queue?.items.find((i) => i.id === el.dataset.id);
    if (!item) return;
    $$("button", el).forEach((b) => (b.disabled = true));
    try {
      if (button.matches("[data-skip]")) await mark(item, "skipped");
      else {
        await approve(item, el);
        toast(`Done: ${item.result}.`, "ok");
      }
    } catch (err) {
      toast(err.message, "error");
    }
    render();
  });
  loadQueue();
}
