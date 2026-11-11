// Synthetic conversations only. This exercises the configured live AI provider via /api/extract.
// Usage: start PayNudge with AI credentials, then npm run evaluate-ai.
// To use a hosted deployment, set AI_EVAL_BASE_URL. This consumes AI quota.
const base = (process.env.AI_EVAL_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const status = await (await fetch(`${base}/api/status`)).json();
if (!status.ai?.live) throw new Error("Live AI is not configured. Demo-mode canned responses cannot be evaluated.");

const cases = [
  { name: "cancelled items", text: "Client: A logo for $500 and three posts at $50 each. Freelancer: Okay. Client: Cancel the posts; I only approve the logo for $500. Invoice ana@example.com.", check: (d) => d.items.length === 1 && d.total === 500 },
  { name: "unapproved quote", text: "Client: Could you quote me $900 for a website? I have not approved it; do not start. Freelancer: Understood, waiting for your decision.", check: (d) => d.items.length === 0 && d.warnings.length > 0 },
  { name: "unknown delivery date", text: "Client: $800 for the website, approved. Payment is due 10 days after delivery. Delivery date is not yet known. Email ada@example.com.", check: (d) => d.total === 800 && !d.due_date && d.warnings.length > 0 },
  { name: "missing contact", text: "Client: I approve 2 posters for EUR 100 each. Please send an invoice. Freelancer: Confirmed.", check: (d) => d.total === 200 && d.currency === "EUR" && !d.client.email },
];
let failures = 0;
console.log(`Testing ${status.ai.provider} / ${status.ai.model} at ${base} with synthetic data.`);
for (const c of cases) {
  try {
    const response = await fetch(`${base}/api/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: c.text }) });
    const data = await response.json();
    const passed = response.ok && c.check(data);
    console.log(`${passed ? "PASS" : "FAIL"}: ${c.name}`, JSON.stringify({ total: data.total, currency: data.currency, due_date: data.due_date, items: data.items, warnings: data.warnings, error: data.error }));
    if (!passed) failures++;
  } catch (error) { failures++; console.log(`FAIL: ${c.name}: ${error.message}`); }
}
console.log(`${cases.length - failures}/${cases.length} checks passed. These are examples, not a measure of general model accuracy.`);
if (failures) process.exitCode = 1;
