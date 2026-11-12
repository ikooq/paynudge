import { $, api, esc, fmt, icon, recentReminder, state } from "./helpers.js";
import { toneFor } from "./autopilot.js";
import { plan } from "./plan.js";

// ---------------------------------------------------------------------------------------------
// Insights: receivables aging (one series, ordered by age) + agent activity feed
// ---------------------------------------------------------------------------------------------
export const BUCKETS = [
  { label: "Not due yet", test: (r) => r.daysOverdue === 0 },
  { label: "1–7 days", test: (r) => r.daysOverdue >= 1 && r.daysOverdue <= 7 },
  { label: "8–21 days", test: (r) => r.daysOverdue >= 8 && r.daysOverdue <= 21 },
  { label: "21+ days", test: (r) => r.daysOverdue > 21 },
];

export function recentPayPalContact(row) {
  return Boolean(row.lastSent && Date.now() - Date.parse(row.lastSent) < 48 * 3600_000);
}

export function renderPlan(rows) {
  const overdue = rows.filter((r) => r.due > 0 && r.daysOverdue > 0);
  const held = overdue.filter((r) => recentReminder(r) || recentPayPalContact(r));
  const candidates = overdue.filter((r) => !recentReminder(r) && !recentPayPalContact(r)).sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number)).slice(0, 3);
  state.planIds = candidates.map((r) => r.id);
  $("#planSelect").disabled = !candidates.length;
  const body = $("#planBody");
  body.innerHTML = candidates.length ? `<div class="plan-list">${candidates.map((r, i) => `<div class="plan-item"><span class="plan-rank">0${i + 1}</span><div class="plan-details"><b>${esc(r.client)} · #${esc(r.number)}</b><small>${r.daysOverdue} days overdue · ${esc(toneFor(r))} reminder · ${esc(r.language)}</small></div><span class="plan-amount">${fmt(r.due, r.currency)}</span><button type="button" class="btn ghost small" data-plan-id="${esc(r.id)}">Review reminder</button></div>`).join("")}</div>` : '<p class="muted plan-note">No invoices are ready for this plan. Check recent or unconfirmed contacts below before sending another reminder.</p>';
  body.insertAdjacentHTML("beforeend", `<p class="muted plan-note">${held.length} overdue invoice${held.length === 1 ? "" : "s"} set aside because of recent or unconfirmed contact. Ranking uses days overdue, not a prediction or currency conversion. Review every message before sending.</p>`);
}

export function renderAging(rows) {
  $("#clearAging").hidden = state.agingBucket === null;
  const open = rows.filter((r) => r.due > 0);
  const data = BUCKETS.map((b) => {
    const list = open.filter(b.test);
    const totals = {};
    for (const r of list) totals[r.currency] = (totals[r.currency] || 0) + r.due;
    return { ...b, count: list.length, totals, clients: list.map((r) => r.client) };
  });
  const max = Math.max(1, ...data.map((d) => d.count));
  $("#agingChart").innerHTML = open.length
    ? data
        .map((d, i) => {
          const money = Object.entries(d.totals).map(([c, v]) => fmt(v, c)).join(" + ") || "—";
          const tip = d.count ? `${d.label}: ${d.count} invoice${d.count === 1 ? "" : "s"} (${d.clients.join(", ")}), ${money}` : `${d.label}: none`;
          return `<button type="button" class="aging-row" data-bucket="${i}" aria-pressed="${state.agingBucket === i}" aria-label="${esc(tip)}" title="${esc(tip)}">
            <span class="label">${d.label}</span>
            <div class="aging-track">
              <div class="aging-bar" style="width:${d.count ? Math.max(6, (d.count / max) * 62) : 0.6}%"></div>
              <span class="aging-value">${d.count ? esc(money) : "—"}<small>${d.count ? `${d.count} inv.` : ""}</small></span>
            </div>
          </button>`;
        })
        .join("")
    : '<p class="muted">No open invoices. Everything is collected.</p>';
}

export const FEED_ICONS = {
  ai: icon.sparkle,
  agent: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  paypal: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg>',
  payment: icon.check,
};

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export let activityBusy = false;
export async function loadActivity() {
  if (activityBusy) return;
  activityBusy = true;
  try {
    const items = await api("/api/activity");
    const firstLoad = state.seenActivity === null;
    const seen = state.seenActivity || new Set();
    $("#activityFeed").innerHTML = items.length
      ? items
          .map(
            (e) => `<li class="${!firstLoad && !seen.has(e.id) ? "new" : ""}">
              <span class="ico ${e.kind}">${FEED_ICONS[e.kind] || icon.sparkle}</span>
              <span>${esc(e.text)}</span>
              <time datetime="${esc(e.at)}">${timeAgo(e.at)}</time>
            </li>`,
          )
          .join("")
      : '<li class="empty-feed">Nothing yet. Draft an invoice to see the agent at work.</li>';
    state.seenActivity = new Set(items.map((e) => e.id));
  } catch {
    /* the feed is decorative; the grid shows the error */
  } finally {
    activityBusy = false;
  }
}
