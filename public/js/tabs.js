import { $, api, esc, fmtTotals, state, toast } from "./helpers.js";
import { celebratePayment } from "./celebrate.js";
import { statusLabel } from "./grid.js";
import { loadActivity, renderAging, renderPlan } from "./insights.js";
import { plan } from "./plan.js";

// ---------------------------------------------------------------------------------------------
// Tabs under the KPIs: Invoices (default) · Insights & activity · Ask AI
// ---------------------------------------------------------------------------------------------
export const TABS = ["invoices", "insights", "ask"];
export function selectTab(name, focus = false) {
  for (const t of TABS) {
    const on = t === name;
    const tab = $(`#tab-${t}`);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#panel-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
}
export function setupTabs() {
  for (const t of TABS) $(`#tab-${t}`).addEventListener("click", () => selectTab(t));
  $(".tabs").addEventListener("keydown", (e) => {
    const i = TABS.findIndex((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true");
    if (e.key === "ArrowRight") selectTab(TABS[(i + 1) % TABS.length], true);
    else if (e.key === "ArrowLeft") selectTab(TABS[(i + TABS.length - 1) % TABS.length], true);
  });
}

// Quick status views over the same PayPal data.
export const STATUS_FILTERS = {
  all: () => true,
  open: (r) => r.due > 0,
  overdue: (r) => r.due > 0 && r.daysOverdue > 0,
  plan: (r) => Boolean(r.plan),
  paid: (r) => ["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"].includes(r.status),
};

// One pinned total row per currency for the rows that pass the current filters (never mixes currencies).
export function updateTotals() {
  if (!state.grid) return;
  const totals = {};
  state.grid.forEachNodeAfterFilter((n) => {
    if (!n.data || n.rowPinned) return;
    const t = (totals[n.data.currency] ||= { amount: 0, due: 0, paid: 0, count: 0 });
    t.amount += n.data.amount;
    t.due += n.data.due;
    t.paid += n.data.paid;
    t.count += 1;
  });
  const rows = Object.entries(totals).map(([currency, t]) => ({
    id: `total-${currency}`,
    client: `Total · ${currency}`,
    items: `${t.count} invoice${t.count === 1 ? "" : "s"} in view`,
    currency,
    amount: Math.round(t.amount * 100) / 100,
    due: Math.round(t.due * 100) / 100,
    paid: Math.round(t.paid * 100) / 100,
  }));
  state.grid.setGridOption("pinnedBottomRowData", rows);
}

export function exportCsv() {
  state.grid.exportDataAsCsv({
    fileName: `paynudge-receivables-${new Date().toISOString().slice(0, 10)}.csv`,
    columnKeys: ["client", "number", "amount", "due", "progress", "status", "dueDate"],
    skipPinnedBottom: true,
    processCellCallback: (p) => {
      const id = p.column.getColId();
      if (id === "progress") return `${Math.round((p.value || 0) * 100)}%`;
      if (id === "status") return statusLabel(p.node.data)[1];
      if (id === "amount" || id === "due") return `${p.value} ${p.node.data.currency}`;
      return p.value;
    },
  });
  toast("Exported the invoices in view to CSV");
}

export function renderKpis(k) {
  const out = fmtTotals(k.outstanding);
  const over = fmtTotals(k.overdue);
  const coll = fmtTotals(k.collected);
  const viaPayPal = fmtTotals(k.collectedViaPayPal || {});
  const recorded = fmtTotals(k.collectedRecorded || {});
  const hasRecorded = Object.values(k.collectedRecorded || {}).some((v) => v > 0);
  const collectedNote = hasRecorded
    ? `${viaPayPal.main} paid via PayPal · ${recorded.main} recorded manually`
    : coll.extra || "Paid via PayPal";
  $("#kpis").innerHTML = `
    <div class="kpi"><span>Outstanding</span><strong>${out.main}</strong><small>${out.extra || `${k.openCount} open invoice${k.openCount === 1 ? "" : "s"}`}</small></div>
    <div class="kpi ${k.overdueCount ? "bad" : ""}"><span>Overdue</span><strong>${over.main}</strong><small>${over.extra || `${k.overdueCount} invoice${k.overdueCount === 1 ? "" : "s"} late`}</small></div>
    <div class="kpi ok"><span>Collected</span><strong>${coll.main}</strong><small title="PayPal status PAID counts as paid via PayPal; MARKED_AS_PAID is a payment the seller recorded">${esc(collectedNote)}</small></div>
    <div class="kpi"><span>Invoices</span><strong>${k.total}</strong><small>Tracked in PayPal</small></div>`;
}

export const PAID = new Set(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"]);

export async function loadInvoices({ flashId, announce } = {}) {
  try {
    const data = await api("/api/invoices");
    const before = new Map(state.rows.map((r) => [r.id, r]));
    const planChanges = data.rows.filter((r) => before.has(r.id) && JSON.stringify(before.get(r.id).plan) !== JSON.stringify(r.plan));
    const newlyPaid = state.rows.length
      ? data.rows.filter((r) => {
          const old = before.get(r.id);
          return old && ((PAID.has(r.status) && !PAID.has(old.status)) || r.paid > old.paid);
        })
      : [];
    state.rows = data.rows;
    renderKpis(data.kpis);
    renderAging(data.rows);
    renderPlan(data.rows);
    newlyPaid.forEach(celebratePayment);
    loadActivity();
    if (state.grid) {
      state.grid.setGridOption("loading", false);
      state.grid.setGridOption("rowData", data.rows);
      // Several renderers depend on the plan even when their own field value is unchanged.
      const planNodes = planChanges.map((row) => state.grid.getRowNode(row.id)).filter(Boolean);
      if (planNodes.length) state.grid.refreshCells({ rowNodes: planNodes, force: true });
      if (newlyPaid.length) state.grid.redrawRows();
      if (flashId) {
        const node = state.grid.getRowNode(flashId);
        if (node) {
          state.grid.ensureNodeVisible(node);
          state.grid.flashCells({ rowNodes: [node] });
        }
      }
    }
    const source = state.status?.paypal.live ? `Live from PayPal ${state.status.paypal.env}` : "Demo data";
    $("#updatedAt").textContent = `${source} · updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
    if (announce) toast("Refreshed from PayPal");
  } catch (err) {
    $("#updatedAt").textContent = err.message;
    state.grid?.setGridOption("loading", false);
    if (announce) toast(err.message, "error");
  }
}
