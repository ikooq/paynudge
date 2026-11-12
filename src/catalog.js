// Seller price list. The AI never sets prices from it: after extraction PayNudge matches each line
// item to a catalog entry by name, fills in a missing price from the catalog, and warns when the
// price agreed in the chat differs from the catalog price. The seller decides which one applies.
import { store } from "./store.js";

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const words = (s) => String(s || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter((w) => w.length > 2);

export function getCatalog(seller = "default") {
  return store.get("catalog", seller) || [];
}

export function cleanCatalog(items) {
  if (!Array.isArray(items)) throw Object.assign(new Error("The price list must be a list of services."), { status: 400 });
  if (items.length > 100) throw Object.assign(new Error("The price list can hold up to 100 services."), { status: 400 });
  return items.map((it, i) => {
    const name = String(it?.name || "").trim().slice(0, 120);
    const price = round2(it?.price);
    const currency = String(it?.currency || "USD").toUpperCase();
    if (!name) throw Object.assign(new Error(`Service ${i + 1} needs a name.`), { status: 400 });
    if (!Number.isFinite(price) || price < 0) throw Object.assign(new Error(`${name}: enter a price of 0 or more.`), { status: 400 });
    if (!/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error(`${name}: use a three-letter currency code such as USD.`), { status: 400 });
    return { name, price, currency, unit: String(it?.unit || "").trim().slice(0, 30) };
  });
}

export async function saveCatalog(seller, items) {
  return store.set("catalog", seller, cleanCatalog(items));
}

// Best catalog entry for an item name: share of the catalog name's words found in the item name.
export function findEntry(itemName, catalog, currency) {
  const itemWords = new Set(words(itemName));
  let best = null;
  for (const entry of catalog) {
    if (currency && entry.currency !== currency) continue;
    const entryWords = words(entry.name);
    if (!entryWords.length) continue;
    const score = entryWords.filter((w) => itemWords.has(w)).length / entryWords.length;
    if (score >= 0.5 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry || null;
}

export function applyCatalog(draft, catalog) {
  if (!catalog?.length || !draft?.items?.length) return draft;
  const warnings = [...(draft.warnings || [])];
  const items = draft.items.map((item) => {
    const entry = findEntry(item.name, catalog, draft.currency);
    if (!entry) return item;
    const catalogInfo = { name: entry.name, price: entry.price };
    if (!item.unit_price && !item.evidence) {
      warnings.push(`${item.name}: no price in the chat, so the catalog price ${entry.price.toFixed(2)} ${entry.currency} for "${entry.name}" was used. Confirm the client agreed to it.`);
      return { ...item, unit_price: entry.price, price_source: "catalog", catalog: catalogInfo };
    }
    if (round2(item.unit_price) !== entry.price) {
      warnings.push(`${item.name}: the chat says ${round2(item.unit_price).toFixed(2)} ${draft.currency}, your catalog price for "${entry.name}" is ${entry.price.toFixed(2)}. The chat price is kept; check which one was agreed.`);
    }
    return { ...item, price_source: "chat", catalog: catalogInfo };
  });
  const total = round2(items.reduce((sum, it) => sum + it.quantity * it.unit_price, 0));
  return { ...draft, items, warnings, total };
}

// Short text for the extraction prompt so the model recognises catalog services the chat names
// without a price. Prices are deliberately not included: the model must not set them.
export function catalogPromptHint(catalog) {
  if (!catalog?.length) return "";
  const names = catalog.slice(0, 40).map((e) => `- ${e.name}`).join("\n");
  return `\n\nThe seller's standard services (names only):\n${names}\nIf the client agreed to one of these without a price in the conversation, still list it, with unit_price 0 and empty evidence, and add a warning; PayNudge fills in the seller's catalog price for review.`;
}
