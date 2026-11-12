import test from "node:test";
import assert from "node:assert/strict";
import { applyCatalog, cleanCatalog, findEntry, catalogPromptHint } from "../src/catalog.js";

const catalog = cleanCatalog([
  { name: "Logo package", price: 500, currency: "USD" },
  { name: "Menu board design", price: 120, currency: "USD" },
  { name: "Website translation", price: 25, currency: "EUR" },
]);

test("catalog matching by name words, within the same currency", () => {
  assert.equal(findEntry("Logo package (option B)", catalog, "USD").name, "Logo package");
  assert.equal(findEntry("Menu board", catalog, "USD").name, "Menu board design");
  assert.equal(findEntry("Website translation", catalog, "USD"), null);
  assert.equal(findEntry("Instagram post template", catalog, "USD"), null);
});

test("a missing price is filled from the catalog and a different chat price is kept with a warning", () => {
  const draft = {
    currency: "USD",
    warnings: [],
    items: [
      { name: "Logo package", quantity: 1, unit_price: 450, evidence: "$450 for the logo" },
      { name: "Menu board design", quantity: 1, unit_price: 0, evidence: "" },
      { name: "Rush delivery", quantity: 1, unit_price: 50, evidence: "+$50 rush" },
    ],
    total: 500,
  };
  const out = applyCatalog(draft, catalog);
  assert.equal(out.items[0].unit_price, 450, "the agreed chat price is never overwritten");
  assert.equal(out.items[0].price_source, "chat");
  assert.equal(out.items[1].unit_price, 120);
  assert.equal(out.items[1].price_source, "catalog");
  assert.equal(out.items[2].catalog, undefined);
  assert.equal(out.total, 620);
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings[0], /catalog price for "Logo package" is 500\.00/);
});

test("the prompt hint lists service names but never prices", () => {
  const hint = catalogPromptHint(catalog);
  assert.match(hint, /Logo package/);
  assert.doesNotMatch(hint, /500|120|25/);
});

test("invalid price lists are rejected with a readable message", () => {
  assert.throws(() => cleanCatalog([{ name: "", price: 1 }]), /needs a name/);
  assert.throws(() => cleanCatalog([{ name: "Logo", price: -5 }]), /price of 0 or more/);
  assert.throws(() => cleanCatalog([{ name: "Logo", price: 5, currency: "dollars" }]), /three-letter/);
});
