import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";

test("AI extraction shows only excerpts found in the source or screenshot transcript", async (t) => {
  const calls = [];
  let visionLimited = false;
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.push(request);
    if (request.model === "vision-test" && visionLimited) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limit" } }));
      return;
    }
    const output = request.model === "vision-test" ? "Client: Logo for $500" : JSON.stringify({
      client: { name: "", business_name: "", email: "" }, currency: "USD",
      items: [
        { name: "Logo", description: "", quantity: 1, unit_price: 500, evidence: "Logo for $500" },
        { name: "Other", description: "", quantity: 1, unit_price: 20, evidence: "Made up quote" },
      ],
      due_date: "", payment_terms_label: "", note_to_client: "", summary: "", conversation_language: "English", warnings: [],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: "stop" }] }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const reservation = createNetServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["server.js"], { stdio: "ignore", env: {
    ...process.env, PORT: String(port), DEMO_MODE: "false", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "",
    AI_PROVIDER: "openai", AI_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
    AI_API_KEY: "test-only", AI_MODEL: "text-test", AI_VISION_MODEL: "vision-test", AI_FALLBACK_MODEL: "",
  } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exited;
    }
    await new Promise((resolve) => provider.close(resolve));
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  // Up to 20 s: the first run after a clean install starts Node and loads modules cold.
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/status`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready);
  const response = await fetch(`${base}/api/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Client: Logo for $500", images: [{ media_type: "image/png", data: "dGVzdA==" }] }) });
  assert.equal(response.status, 200);
  const draft = await response.json();
  assert.equal(draft.items[0].evidence, "Logo for $500");
  assert.equal(draft.items[0].evidence_source, "chat");
  assert.equal(draft.items[1].evidence, "");
  assert.deepEqual(calls.map((call) => call.model), ["vision-test", "text-test"]);
  assert.ok(calls[1].response_format.json_schema.schema.properties.items.items.required.includes("evidence"));
  visionLimited = true;
  const limited = await fetch(`${base}/api/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ images: [{ media_type: "image/png", data: "dGVzdA==" }] }) });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /Read screenshot locally/);
});
