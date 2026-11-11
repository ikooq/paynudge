import test from "node:test";
import assert from "node:assert/strict";
import { attachEvidence } from "../src/evidence.js";

test("only excerpts present in the supplied source are shown", () => {
  const result = attachEvidence({ items: [
    { name: "Logo", evidence: "Logo for $500" },
    { name: "Poster", evidence: "Poster for $999" },
    { name: "Website", evidence: "Website for €800" },
  ] }, { text: "Client: LOGO   for $500", transcript: "Client: Website for €800, confirmed." });
  assert.equal(result.items[0].evidence_source, "chat");
  assert.equal(result.items[1].evidence, "");
  assert.equal(result.items[2].evidence_source, "screenshot transcript");
});

test("missing or too-short excerpts are not presented as verified", () => {
  const result = attachEvidence({ items: [{ evidence: "yes" }, { evidence: "made up quote" }, {}] }, { text: "yes" });
  assert.deepEqual(result.items.map((item) => item.evidence_source), ["", "", ""]);
});
