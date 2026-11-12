import { $, $$, api, esc, fmt, fmtDate, icon, state, toast } from "./helpers.js";
import { PAID, STATUS_FILTERS, exportCsv, loadInvoices, selectTab, updateTotals } from "./tabs.js";
import { BUCKETS, renderAging } from "./insights.js";
import { openPlan, plan, planTitle } from "./plan.js";
import { openNudge } from "./nudge.js";

// ---------------------------------------------------------------------------------------------
// Receivables: KPIs + AG Grid
// ---------------------------------------------------------------------------------------------
export const STATUS = {
  PAID: ["ok", "Paid via PayPal"], MARKED_AS_PAID: ["neutral", "Recorded paid"], PAID_EXTERNAL: ["neutral", "Paid outside"],
  SENT: ["info", "Sent"], UNPAID: ["info", "Unpaid"], SHARED: ["info", "Shared"],
  PARTIALLY_PAID: ["warn", "Part paid"], PAYMENT_PENDING: ["warn", "Pending"],
  SCHEDULED: ["neutral", "Scheduled"], DRAFT: ["neutral", "Draft"], CANCELLED: ["neutral", "Cancelled"],
};

export function cell(html) {
  const el = document.createElement("div");
  el.style.height = "100%";
  el.innerHTML = html;
  return el.firstElementChild;
}

// Pinned bottom rows carry per-currency totals; cell renderers skip them.
export const isTotal = (p) => Boolean(p.node?.rowPinned);
export const statusLabel = (r) =>
  r.plan && r.plan.status !== "accepted" ? [r.daysOverdue > 0 ? "bad" : "warn", r.daysOverdue > 0 ? "Overdue · offer" : r.plan.status === "offered" ? "Plan offered" : "Plan unverified"]
  : r.daysOverdue > 0 ? ["bad", r.plan ? "Plan late" : "Overdue"]
  : r.plan && r.due > 0 ? ["info", "On plan"]
  : STATUS[r.status] || ["neutral", r.status];
export const isoDateFilter = {
  comparator: (filterDate, value) => {
    if (!value) return -1;
    const d = Date.parse(`${value}T00:00:00Z`);
    const f = Date.UTC(filterDate.getFullYear(), filterDate.getMonth(), filterDate.getDate());
    return d === f ? 0 : d < f ? -1 : 1;
  },
};

export const columnDefs = [
  {
    headerName: "Client",
    field: "client",
    flex: 2,
    minWidth: 180,
    filter: "agTextColumnFilter",
    tooltipValueGetter: (p) => (isTotal(p) ? "" : [p.data.client, p.data.contact, p.data.email, p.data.items].filter(Boolean).join(" · ")),
    getQuickFilterText: (p) => `${p.data.client} ${p.data.items} ${p.data.email} ${p.data.number}`,
    cellRenderer: (p) =>
      isTotal(p)
        ? cell(`<div class="cell-client"><b>${esc(p.data.client)}</b><small>${esc(p.data.items)}</small></div>`)
        : cell(`<div class="cell-client"><b>${esc(p.data.client)}</b><small>${esc(p.data.items || p.data.email || p.data.contact)}</small></div>`),
  },
  { headerName: "Invoice", field: "number", width: 92, valueFormatter: (p) => (isTotal(p) ? "" : p.value ? `#${p.value}` : "—") },
  { headerName: "Amount", field: "amount", width: 115, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => fmt(p.value, p.data.currency) },
  { headerName: "Balance", field: "due", width: 115, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => fmt(p.value, p.data.currency) },
  {
    headerName: "Paid",
    colId: "progress",
    width: 128,
    valueGetter: (p) => (p.data.amount ? p.data.paid / p.data.amount : 0),
    comparator: (a, b) => a - b,
    tooltipValueGetter: (p) => (isTotal(p) ? "" : `${fmt(p.data.paid, p.data.currency)} of ${fmt(p.data.amount, p.data.currency)} paid${p.data.plan ? `\n${planTitle(p.data)}` : ""}`),
    cellRenderer: (p) => {
      const r = p.data;
      const pct = Math.round(Math.min(1, r.amount ? r.paid / r.amount : 0) * 100);
      // Plan installments appear as ticks on the bar, so progress through the plan is visible at a glance.
      let ticks = "";
      if (!isTotal(p) && r.plan && r.amount) {
        // The plan covers the balance at the time it was made; anything paid before sits to its left.
        const planTotal = r.plan.installments.reduce((s, i) => s + i.amount, 0);
        let cum = r.amount - planTotal;
        ticks = r.plan.installments.slice(0, -1).map((i) => {
          cum += i.amount;
          return `<i style="left:${Math.min(100, (cum / r.amount) * 100).toFixed(1)}%"></i>`;
        }).join("");
      }
      return cell(`<div class="cell-progress" aria-label="${pct}% paid"><div class="bar ${pct >= 100 ? "full" : ""}"><span style="width:${pct}%"></span>${ticks}</div><small>${pct}%</small></div>`);
    },
  },
  {
    headerName: "Status",
    field: "status",
    width: 122,
    filter: "agTextColumnFilter",
    filterValueGetter: (p) => statusLabel(p.data)[1],
    cellRenderer: (p) => {
      if (isTotal(p)) return "";
      const [kind, label] = statusLabel(p.data);
      return cell(`<div style="display:flex;align-items:center;height:100%"><span class="pill ${kind}">${esc(label)}</span></div>`);
    },
  },
  {
    headerName: "Due",
    field: "dueDate",
    width: 122,
    filter: "agDateColumnFilter",
    filterParams: isoDateFilter,
    cellRenderer: (p) => {
      if (isTotal(p)) return "";
      const r = p.data;
      // On a payment plan, the date that matters is the next installment, not the original due date.
      const date = (r.plan?.status === "accepted" ? r.plan?.progress?.next?.due_date : "") || r.dueDate;
      let sub = "";
      if (r.daysOverdue > 0) sub = `<small class="bad">${r.daysOverdue} day${r.daysOverdue === 1 ? "" : "s"} late</small>`;
      else if (r.due > 0 && date) {
        const days = Math.round((Date.parse(date) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5);
        sub = `<small class="muted">${r.plan?.status === "accepted" ? "next part " : ""}${days === 0 ? "due today" : `in ${days} day${days === 1 ? "" : "s"}`}</small>`;
      }
      return cell(`<div class="cell-due"><span>${esc(fmtDate(date)) || "—"}</span>${sub}</div>`);
    },
  },
  {
    headerName: "Next step",
    field: "nextAction.label",
    flex: 1,
    minWidth: 250,
    sortable: false,
    cellRenderer: (p) => {
      if (isTotal(p)) return "";
      const r = p.data;
      const key = r.nextAction.key;
      const open = r.payerUrl
        ? `<a class="open-link" href="${esc(new URL(r.payerUrl, location.origin).href)}" target="_blank" rel="noopener" title="Open payment page">${icon.external}</a>`
        : "";
      // A late invoice without a plan can get one; an invoice on a plan shows where it stands.
      const canPlan = r.due > 0 && r.daysOverdue > 0 && (!r.plan || r.plan.status === "unknown") && ["SENT", "UNPAID", "PARTIALLY_PAID"].includes(r.status);
      const planBtn = canPlan ? `<button class="nudge-btn plan" data-plan title="AI proposes installments; PayPal accepts partial payments">${icon.calendar} Plan</button>` : "";
      const acceptBtn = r.plan?.status === "offered" && r.plan.paidBefore != null ? '<button class="nudge-btn plan" data-accept-plan title="Record that the client explicitly agreed">Confirm agreement</button>' : "";
      let main = "";
      if (["friendly", "firm", "final"].includes(key)) {
        main = `<button class="nudge-btn ${key}" data-tone="${key}">${icon.bell} ${esc(r.nextAction.label)}</button>`;
      } else if (key === "plan") {
        main = `<span class="pill info" title="${esc(planTitle(r))}">${icon.calendar} ${esc(r.nextAction.label)}</span>`;
      } else if (key === "wait") {
        main = `<button class="nudge-btn" data-tone="friendly">${icon.bell} Nudge</button><span class="muted" style="font-size:12.5px">${esc(r.nextAction.label)}</span>`;
      } else if (key === "done") {
        main = `<span class="pill ok">${icon.check} Collected</span>`;
      } else {
        main = `<span class="muted">${esc(r.nextAction.label)}</span>`;
      }
      const el = cell(`<div class="cell-actions">${main}${planBtn}${acceptBtn}${open}</div>`);
      el.querySelector("[data-tone]")?.addEventListener("click", () => openNudge(r, el.querySelector("[data-tone]").dataset.tone));
      el.querySelector("[data-plan]")?.addEventListener("click", () => openPlan(r));
      el.querySelector("[data-accept-plan]")?.addEventListener("click", async () => {
        if (!confirm(`Has ${r.client} explicitly agreed to this payment plan? Only confirm after the client accepts.`)) return;
        try {
          await api(`/api/invoices/${encodeURIComponent(r.id)}/plan/accept`, { method: "POST", body: { clientAgreed: true } });
          toast("Client agreement recorded.");
          await loadInvoices();
        } catch (err) { toast(err.message, "error"); }
      });
      return el;
    },
  },
];

export function gridTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const dark = cs.colorScheme === "dark";
  return agGrid.themeQuartz.withParams({
    accentColor: v("--accent"),
    backgroundColor: v("--surface"),
    foregroundColor: v("--ink"),
    borderColor: v("--border"),
    headerBackgroundColor: v("--surface"),
    headerTextColor: v("--muted"),
    headerFontWeight: 600,
    rowHoverColor: v("--surface-2"),
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 14,
    wrapperBorder: false,
    wrapperBorderRadius: 0,
    browserColorScheme: dark ? "dark" : "light",
  });
}

export function setupGrid() {
  if (!window.agGrid) {
    $("#grid").innerHTML = '<p class="muted" style="padding:20px">The table library failed to load.</p>';
    return;
  }
  state.grid = agGrid.createGrid($("#grid"), {
    columnDefs,
    rowData: [],
    rowSelection: { mode: "multiRow", enableClickSelection: false },
    isExternalFilterPresent: () => state.agingBucket !== null || state.statusFilter !== "all",
    doesExternalFilterPass: (node) =>
      (state.agingBucket === null || (node.data.due > 0 && BUCKETS[state.agingBucket].test(node.data))) &&
      STATUS_FILTERS[state.statusFilter](node.data),
    onFilterChanged: () => updateTotals(),
    onRowDataUpdated: () => updateTotals(),
    tooltipShowDelay: 400,
    theme: gridTheme(),
    rowHeight: 60,
    headerHeight: 44,
    domLayout: "autoHeight",
    pagination: true,
    paginationPageSize: 10,
    paginationPageSizeSelector: [10, 25, 50],
    animateRows: true,
    getRowId: (p) => p.data.id,
    getRowClass: (p) => (state.justPaid.has(p.data.id) ? "just-paid" : ""),
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    overlayNoRowsTemplate: '<span class="muted">No invoices yet. Draft your first one above.</span>',
    loading: true,
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
    state.grid.setGridOption("theme", gridTheme()),
  );
  $("#gridSearch").addEventListener("input", (e) => state.grid.setGridOption("quickFilterText", e.target.value));
  $("#refreshBtn").addEventListener("click", () => loadInvoices({ announce: true }));
  $("#statusFilters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-status]");
    if (!b) return;
    state.statusFilter = b.dataset.status;
    $$("#statusFilters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    state.grid.onFilterChanged();
  });
  $("#exportCsv").addEventListener("click", exportCsv);
  $("#agingChart").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-bucket]");
    if (!button) return;
    state.agingBucket = Number(button.dataset.bucket);
    state.grid.deselectAll();
    state.grid.onFilterChanged();
    renderAging(state.rows);
    $("#gridGuidance").innerHTML = `Showing ${esc(BUCKETS[state.agingBucket].label)} open invoices. Select rows to prepare reminders. <button type="button" class="link-btn" data-clear-aging>Show all invoices</button>`;
    selectTab("invoices");
  });
  const clearAging = () => {
    state.agingBucket = null;
    state.grid.onFilterChanged();
    renderAging(state.rows);
    $("#gridGuidance").textContent = "Select invoices in the table, then prepare reminders. If none are selected, the oldest overdue invoices are used.";
  };
  $("#clearAging").addEventListener("click", clearAging);
  $("#gridGuidance").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-aging]")) clearAging();
  });
}
