import { $, $$ } from "./helpers.js";
import { renderAccount } from "./account.js";
import { renderCatalog } from "./catalog.js";
import { renderRecurring } from "./recurring.js";
import { renderTelegram } from "./telegram.js";

// ---------------------------------------------------------------------------------------------
// Seller workspace dialog: PayPal account, price list, recurring invoices, Telegram link
// ---------------------------------------------------------------------------------------------
const PANELS = { account: renderAccount, catalog: renderCatalog, recurring: renderRecurring, telegram: renderTelegram };

export function selectSellerTab(name) {
  for (const key of Object.keys(PANELS)) {
    const tab = $(`#stab-${key}`);
    const on = key === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#spanel-${key}`).hidden = !on;
  }
  PANELS[name]($(`#spanel-${name}`));
}

export function openSeller(tab = "account") {
  const dialog = $("#sellerDialog");
  if (!dialog.open) dialog.showModal();
  selectSellerTab(tab);
}

export function setupSeller() {
  $("#sellerClose").addEventListener("click", () => $("#sellerDialog").close());
  for (const key of Object.keys(PANELS)) $(`#stab-${key}`).addEventListener("click", () => selectSellerTab(key));
  $("#sellerDialog [role=tablist]").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const tabs = $$("#sellerDialog [role=tab]");
    const i = tabs.indexOf(document.activeElement);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-open-seller]");
    if (opener) openSeller(opener.dataset.openSeller || "account");
  });
}
