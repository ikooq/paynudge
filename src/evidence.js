// A matching quote is an aid for human review, not proof that the invoice is correct.
const comparable = (text) => String(text || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();

export function attachEvidence(draft, { text = "", transcript = "" } = {}) {
  const sources = [["chat", comparable(text)], ["screenshot transcript", comparable(transcript)]];
  return {
    ...draft,
    items: (draft.items || []).map((item) => {
      const quote = String(item.evidence || "").trim().slice(0, 300);
      const match = quote.length >= 5 && sources.find(([, source]) => source && source.includes(comparable(quote)));
      return { ...item, evidence: match ? quote : "", evidence_source: match ? match[0] : "" };
    }),
  };
}
