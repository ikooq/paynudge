
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const icon = {
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
};

export const state = {
  images: [],
  draft: null,
  rows: [],
  status: null,
  nudge: null,
  grid: null,
  samples: [],
  justPaid: new Set(),
  watchUntil: 0, // poll PayPal faster until this time (after an invoice is sent)
  seenActivity: null,
  agingBucket: null,
  statusFilter: "all",
  planIds: [],
  pendingInvoice: null,
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.repeatConfirmationRequired = data.repeatConfirmationRequired === true;
    throw err;
  }
  return data;
}

export async function sendReviewedReminder(row, subject, note) {
  const path = `/api/invoices/${encodeURIComponent(row.id)}/remind`;
  const body = { subject, note, client: row.client, number: row.number };
  try {
    return await api(path, { method: "POST", body });
  } catch (err) {
    if (!err.repeatConfirmationRequired || !confirm(`${err.message}\n\nHave you checked PayPal and confirmed you want to send another reminder to ${row.client}?`)) throw err;
    return api(path, { method: "POST", body: { ...body, confirmRepeat: true } });
  }
}

export function recentReminder(row) {
  const h = row.reminderHistory;
  return Boolean(h && (h.status !== "sent" || Date.now() - Date.parse(h.at) < 48 * 3600_000));
}

export function fmt(amount, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount || 0);
  } catch {
    return `${Number(amount || 0).toFixed(2)} ${currency}`;
  }
}

export function fmtTotals(map) {
  const entries = Object.entries(map || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { main: fmt(0, "USD"), extra: "" };
  const [first, ...rest] = entries;
  return { main: fmt(first[1], first[0]), extra: rest.map(([c, v]) => `+ ${fmt(v, c)}`).join(" ") };
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export let toastTimer;
export function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "error" ? 6000 : 3500);
}

// "gemini-2.5-flash" -> "Gemini 2.5 Flash", "openai/gpt-oss-120b" -> "GPT OSS 120B"
export function modelName(id) {
  return id
    .split("/")
    .pop()
    .split("-")
    .map((w) =>
      /^(gpt|oss)$/i.test(w) || /^\d+b$/i.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

// The chip names the provider only; the exact models are in the tooltip (aiTitle).
export function aiLabel({ provider }) {
  return `AI · ${provider}`;
}

export function aiTitle({ model, visionModel, provider }) {
  return `AI by ${provider}: ${model}${visionModel ? ` (screenshots read by ${visionModel})` : ""}`;
}
