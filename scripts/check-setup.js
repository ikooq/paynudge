// Verifies your .env without using AI quota: gets a PayPal OAuth token, lists invoices,
// and checks that the AI model exists through the provider's models endpoint.
import { GoogleGenAI } from "@google/genai";
import { config } from "../src/config.js";

let ok = true;
const ai = config.ai;

if (!config.paypal.clientId || !config.paypal.clientSecret) {
  console.log("✗ PayPal: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set (the app will run in demo mode).");
  ok = false;
} else {
  try {
    const paypal = await import("../src/paypal.js");
    const invoices = await paypal.listInvoices();
    console.log(`✓ PayPal ${config.paypal.env}: connected, ${invoices.length} invoice(s) on the account.`);
  } catch (err) {
    console.log(`✗ PayPal ${config.paypal.env}: ${err.message}`);
    ok = false;
  }
}

const models = [ai.model, ai.visionModel, ai.fallbackModel].filter(Boolean);
if (!ai.apiKey) {
  console.log(`✗ AI (${ai.name}): no API key set (the app will use canned demo answers).`);
  ok = false;
} else if (ai.kind === "gemini") {
  const client = new GoogleGenAI({ apiKey: ai.apiKey });
  for (const name of models) {
    try {
      const model = await client.models.get({ model: name });
      console.log(`✓ AI (${ai.name}): ${model.displayName || name} is available.`);
    } catch (err) {
      console.log(`✗ AI (${ai.name}) ${name}: ${err.message}`);
      ok = false;
    }
  }
} else {
  try {
    const res = await fetch(`${ai.baseUrl}/models`, { headers: { Authorization: `Bearer ${ai.apiKey}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    const ids = new Set((body.data || []).map((m) => m.id));
    for (const name of models) {
      if (ids.has(name)) console.log(`✓ AI (${ai.name}): ${name} is available.`);
      else {
        console.log(`✗ AI (${ai.name}): ${name} is not in your model list.`);
        ok = false;
      }
    }
  } catch (err) {
    console.log(`✗ AI (${ai.name}): ${err.message}`);
    ok = false;
  }
}

process.exit(ok ? 0 : 1);
