import { $, $$, api, esc, toast } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Price list: the seller's standard services. AI drafts use it to fill a missing price and to
// flag a chat price that differs from the list; the model itself never sets a price from it.
// ---------------------------------------------------------------------------------------------
let items = [];

function rowHtml(it, i) {
  return `<div class="cat-row" data-i="${i}">
    <input aria-label="Service name" data-k="name" value="${esc(it.name)}" maxlength="120" placeholder="Logo package" />
    <input aria-label="Price" data-k="price" type="number" min="0" step="0.01" value="${esc(it.price)}" />
    <input aria-label="Currency" data-k="currency" value="${esc(it.currency)}" maxlength="3" />
    <button class="btn ghost icon" type="button" data-remove aria-label="Remove ${esc(it.name || "service")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
  </div>`;
}

function draw(panel) {
  panel.innerHTML = `
    <p class="muted">Your standard prices. When a chat names one of these services without a price, the draft uses your price and says so. When the chat price differs, the chat price is kept and you get a warning to check which one was agreed.</p>
    <div class="cat-list">
      <div class="cat-row cat-head"><span>Service</span><span>Price</span><span>Currency</span><span></span></div>
      ${items.map(rowHtml).join("") || `<p class="muted cat-empty">No services yet.</p>`}
    </div>
    <div class="cat-actions">
      <button class="btn ghost" type="button" id="catAdd">+ Add service</button>
      <span class="spacer"></span>
      <button class="btn primary" type="button" id="catSave">Save price list</button>
    </div>`;
  $("#catAdd", panel).addEventListener("click", () => {
    collect(panel);
    items.push({ name: "", price: 0, currency: items.at(-1)?.currency || "USD" });
    draw(panel);
    $$(".cat-row:not(.cat-head) input[data-k=name]", panel).at(-1)?.focus();
  });
  panel.querySelector(".cat-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    collect(panel);
    items.splice(Number(btn.closest(".cat-row").dataset.i), 1);
    draw(panel);
  });
  $("#catSave", panel).addEventListener("click", async (e) => {
    collect(panel);
    const button = e.currentTarget;
    button.disabled = true;
    try {
      items = (await api("/api/catalog", { method: "PUT", body: { items: items.filter((it) => it.name.trim()) } })).items;
      draw(panel);
      toast(`Price list saved: ${items.length} service${items.length === 1 ? "" : "s"}.`, "ok");
    } catch (err) {
      toast(err.message, "error");
      button.disabled = false;
    }
  });
}

function collect(panel) {
  items = $$(".cat-row:not(.cat-head)", panel).map((row) => ({
    name: $("[data-k=name]", row).value.trim(),
    price: Number($("[data-k=price]", row).value),
    currency: $("[data-k=currency]", row).value.trim().toUpperCase() || "USD",
  }));
}

export async function renderCatalog(panel) {
  panel.innerHTML = `<p class="muted">Loading your price list…</p>`;
  try {
    items = (await api("/api/catalog")).items;
  } catch (err) {
    panel.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  draw(panel);
}
