import { $, api, fmt, fmtDate, sendReviewedReminder, state, toast } from "./helpers.js";
import { loadInvoices } from "./tabs.js";

// ---------------------------------------------------------------------------------------------
// Nudge dialog: the AI writes the reminder, the user approves, PayPal sends it
// ---------------------------------------------------------------------------------------------
export let nudgeRequest = 0;

export function openNudge(row, tone = "friendly") {
  state.nudge = { row };
  $("#nudgeTitle").textContent = `Nudge ${row.client}`;
  const when = row.daysOverdue > 0 ? `${row.daysOverdue} days overdue` : row.dueDate ? `due ${fmtDate(row.dueDate)}` : "open";
  const history = row.reminderHistory ? ` · last reminder ${row.reminderHistory.status === "sent" ? "sent" : "unconfirmed"} ${fmtDate(row.reminderHistory.at.slice(0, 10))}` : "";
  $("#nudgeMeta").textContent = `Invoice #${row.number} · ${fmt(row.due, row.currency)} · ${when} · written in ${row.language}${history}`;
  $(`#nudgeForm input[name=tone][value=${tone}]`).checked = true;
  $("#nudgeDialog").showModal();
  writeNudge();
}

export async function writeNudge() {
  const id = ++nudgeRequest;
  const tone = $("#nudgeForm input[name=tone]:checked").value;
  const subject = $("#nudgeSubject");
  const note = $("#nudgeNote");
  for (const el of [subject, note]) {
    el.value = "";
    el.disabled = true;
    el.classList.add("loading");
  }
  note.placeholder = "The AI is writing the reminder…";
  $("#sendNudgeBtn").disabled = true;
  try {
    const r = await api(`/api/invoices/${encodeURIComponent(state.nudge.row.id)}/reminder-draft`, { method: "POST", body: { tone } });
    if (id !== nudgeRequest) return;
    subject.value = r.subject;
    note.value = r.note;
  } catch (err) {
    if (id !== nudgeRequest) return;
    toast(err.message, "error");
  } finally {
    if (id === nudgeRequest) {
      for (const el of [subject, note]) {
        el.disabled = false;
        el.classList.remove("loading");
      }
      note.placeholder = "";
      $("#sendNudgeBtn").disabled = false;
    }
  }
}

export function setupNudge() {
  $("#nudgeForm").addEventListener("change", (e) => {
    if (e.target.name === "tone") writeNudge();
  });
  $("#regenBtn").addEventListener("click", writeNudge);
  $("#sendNudgeBtn").addEventListener("click", async () => {
    const btn = $("#sendNudgeBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const row = state.nudge.row;
      await sendReviewedReminder(row, $("#nudgeSubject").value, $("#nudgeNote").value);
      $("#nudgeDialog").close();
      toast(`Reminder sent via PayPal${row.email ? ` to ${row.email}` : ""}`);
      loadInvoices();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send reminder via PayPal";
    }
  });
}
