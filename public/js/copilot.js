import { $, api, esc, icon, state } from "./helpers.js";
import { openNudge } from "./nudge.js";

// ---------------------------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------------------------
export const SUGGESTIONS = ["Who should I chase first?", "How much is overdue, by currency?", "Which invoices are due this week?"];

export function setupCopilot() {
  const wrap = $("#copilotSuggestions");
  for (const q of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sample-chip";
    b.textContent = q;
    b.addEventListener("click", () => {
      $("#copilotInput").value = q;
      ask(q);
    });
    wrap.append(b);
  }
  $("#copilotForm").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("#copilotInput").value);
  });
}

export async function ask(question) {
  if (!question.trim()) return;
  const box = $("#copilotAnswer");
  box.hidden = false;
  box.innerHTML = `<div class="status" style="display:flex;gap:10px;align-items:center"><span class="spinner"></span> Reading your invoices in PayPal…</div>`;
  try {
    const { answer, actions } = await api("/api/copilot", { method: "POST", body: { question } });
    box.innerHTML = `<p>${esc(answer)}</p>${actions.length ? '<div class="actions"></div>' : ""}`;
    const bar = $(".actions", box);
    for (const a of actions) {
      const row = state.rows.find((r) => r.id === a.invoice_id);
      if (!row) continue;
      if (a.type === "remind") {
        const b = document.createElement("button");
        b.className = "btn primary small";
        b.innerHTML = `${icon.bell} ${esc(a.label)}`;
        b.addEventListener("click", () => openNudge(row, a.tone === "none" ? "friendly" : a.tone));
        bar.append(b);
      } else if (row.payerUrl) {
        const l = document.createElement("a");
        l.className = "btn ghost small";
        l.href = new URL(row.payerUrl, location.origin).href;
        l.target = "_blank";
        l.rel = "noopener";
        l.innerHTML = `${icon.external} ${esc(a.label)}`;
        bar.append(l);
      }
    }
  } catch (err) {
    box.innerHTML = `<p>${esc(err.message)}</p>`;
  }
}
