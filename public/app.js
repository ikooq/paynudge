// PayNudge front end: composer -> AI draft -> PayPal invoice -> receivables grid -> AI nudges.
// Entry point: wires the modules in public/js/ together and starts polling PayPal.
import { $, $$, state, toast } from "./js/helpers.js";
import { loadStatus } from "./js/status.js";
import { loadSamples, setupVoice } from "./js/voice.js";
import { renderThumbs, setupComposer } from "./js/composer.js";
import { extract, renderDraft, renderEmpty, setupDraftEvents, showPendingInvoice } from "./js/draft.js";
import { setupGrid } from "./js/grid.js";
import { loadInvoices, selectTab, setupTabs } from "./js/tabs.js";
import { renderAging, timeAgo } from "./js/insights.js";
import { setupAutopilot, toneFor } from "./js/autopilot.js";
import { plan, setupPlan } from "./js/plan.js";
import { setupCopilot } from "./js/copilot.js";
import { openNudge, setupNudge } from "./js/nudge.js";
import { setupSeller } from "./js/seller.js";
import { setupQueue } from "./js/queue.js";

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
renderEmpty();
setupComposer();
setupDraftEvents();
setupCopilot();
setupNudge();
setupAutopilot();
setupGrid();
setupTabs();
setupVoice();
setupPlan();
setupSeller();
setupQueue();
// The hero frame's evidence loop runs forever, so it has a pause control.
$("#heroPause")?.addEventListener("click", (e) => {
  const paused = $("#heroFrame").classList.toggle("is-paused");
  e.currentTarget.setAttribute("aria-pressed", String(paused));
  e.currentTarget.setAttribute("aria-label", paused ? "Play the animation" : "Pause the animation");
});
$("#planBody").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-plan-id]");
  const row = button && state.rows.find((r) => r.id === button.dataset.planId);
  if (row) openNudge(row, toneFor(row));
});
$("#planSelect").addEventListener("click", () => {
  if (!state.grid || !state.planIds.length) return;
  state.agingBucket = null;
  state.grid.onFilterChanged();
  $("#gridSearch").value = "";
  state.grid.setGridOption("quickFilterText", "");
  state.grid.deselectAll();
  for (const id of state.planIds) state.grid.getRowNode(id)?.setSelected(true);
  renderAging(state.rows);
  selectTab("invoices");
  $("#gridGuidance").textContent = `${state.planIds.length} plan invoices selected. Choose Prepare reminders to review their messages.`;
  $("#grid").scrollIntoView({ behavior: "smooth", block: "center" });
});
try {
  const pending = JSON.parse(sessionStorage.getItem("paynudge.pendingInvoice") || "null");
  if (pending?.operationId && pending?.draft) {
    state.pendingInvoice = pending;
    state.draft = structuredClone(pending.draft);
    renderDraft();
    showPendingInvoice();
  }
} catch { sessionStorage.removeItem("paynudge.pendingInvoice"); }
$("#heroTry").addEventListener("click", () => {
  const sample = state.samples[0];
  if (sample) {
    $("#chatInput").value = sample.text;
    state.images = [];
    renderThumbs();
  }
  $(".create").scrollIntoView({ behavior: "smooth", block: "start" });
  if (sample) setTimeout(extract, 450);
});
await loadStatus().catch((e) => toast(e.message, "error"));
// Back from PayPal partner onboarding.
{
  const params = new URLSearchParams(location.search);
  if (params.has("connected")) toast("PayPal account connected. Invoices from this browser now use it.", "ok");
  if (params.has("connect_error")) toast(params.get("connect_error"), "error");
  if (params.has("connected") || params.has("connect_error")) history.replaceState(null, "", location.pathname);
}
loadSamples();
loadInvoices();
// Verified PayPal webhooks, when PayPal sends them, reach the page through this stream; polling stays on.
if (state.status?.paypal?.webhooks && "EventSource" in window) {
  const stream = new EventSource("/api/events");
  stream.onmessage = () => loadInvoices();
}
// Poll PayPal every 15 s, or every 4 s while waiting for a payment after sending an invoice.
let lastPoll = Date.now();
setInterval(() => {
  const busy = $("#nudgeDialog").open || $("#autopilotDialog").open;
  const every = Date.now() < state.watchUntil ? 4000 : 15000;
  if (document.visibilityState === "visible" && !busy && Date.now() - lastPoll >= every) {
    lastPoll = Date.now();
    loadInvoices();
  }
}, 1000);
setInterval(() => $$("#activityFeed time").forEach((t) => (t.textContent = timeAgo(t.getAttribute("datetime")))), 30000);
