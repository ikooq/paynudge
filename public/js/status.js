import { $, aiLabel, api, esc, state } from "./helpers.js";
import { voice } from "./voice.js";

// ---------------------------------------------------------------------------------------------
// Status chips + samples
// ---------------------------------------------------------------------------------------------
export async function loadStatus() {
  const s = (state.status = await api("/api/status"));
  const chips = [
    s.paypal.live
      ? `<span class="chip"><i></i>PayPal ${s.paypal.env === "live" ? "Live" : "Sandbox"}</span>`
      : `<span class="chip demo" title="Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to use the real sandbox"><i></i>PayPal · demo mode</span>`,
    s.ai.live
      ? `<span class="chip" title="${esc(aiTitle(s.ai))}"><i></i>${esc(aiLabel(s.ai))}</span>`
      : `<span class="chip demo" title="Set GROQ_API_KEY to use the AI"><i></i>AI · demo mode</span>`,
    s.paypal.webhooks
      ? `<span class="chip hide-sm" title="Payments are noticed by checking PayPal every few seconds. A verified PayPal webhook, when PayPal sends one, updates the page at once."><i></i>Payments: webhooks + polling</span>`
      : `<span class="chip hide-sm demo" title="No PayPal webhook configured; the dashboard checks PayPal every few seconds"><i></i>Payments: polling</span>`,
    `<span class="chip hide-sm">Seller: ${esc(s.business)}</span>`,
  ];
  $("#statusChips").innerHTML = chips.join("");
  $("#dataNotice").textContent = s.ai.live
    ? `Chats, screenshots and voice notes are sent to ${s.ai.provider} for processing. Use test data in this shared demo.`
    : "Demo mode uses local sample responses; no chat is sent to an AI provider.";
  const voice = Boolean(s.ai.voice);
  $("#voiceBtn").hidden = !voice || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  $("#audioUpload").hidden = !voice;
}
