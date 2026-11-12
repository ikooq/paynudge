import { $, api, state, toast } from "./helpers.js";
import { renderThumbs } from "./composer.js";
import { extract } from "./draft.js";

// ---------------------------------------------------------------------------------------------
// Voice note -> transcript -> invoice draft. The transcript goes into the chat box so the seller
// can read and fix it, and line-item quotes are checked against it like any pasted chat.
// ---------------------------------------------------------------------------------------------
export const voice = { recorder: null, chunks: [], started: 0, timer: null };

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function transcribeBlob(blob, label) {
  if (blob.size > 10 * 1024 * 1024) return toast("Voice notes can be up to 10 MB.", "error");
  const btn = $("#extractBtn");
  btn.disabled = true;
  $("#voiceLabel").textContent = "Transcribing…";
  try {
    const r = await api("/api/transcribe", { method: "POST", body: { media_type: blob.type || "audio/webm", data: await blobToBase64(blob) } });
    const box = $("#chatInput");
    const lang = r.language ? ` (${r.language.charAt(0).toUpperCase() + r.language.slice(1)})` : "";
    box.value = `${box.value.trim() ? box.value.trim() + "\n\n" : ""}${label}${lang}: ${r.text}`;
    toast(`Voice note transcribed${r.seconds ? ` (${r.seconds} s)` : ""}. Drafting the invoice…`);
    btn.disabled = false;
    extract();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    $("#voiceLabel").textContent = "Voice note";
  }
}

export async function toggleRecording() {
  const btn = $("#voiceBtn");
  if (voice.recorder?.state === "recording") {
    voice.recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast("Microphone access was blocked. You can upload an audio file instead.", "error");
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  voice.recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  voice.chunks = [];
  voice.recorder.ondataavailable = (e) => e.data.size && voice.chunks.push(e.data);
  voice.recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(voice.timer);
    btn.classList.remove("recording");
    btn.setAttribute("aria-pressed", "false");
    const blob = new Blob(voice.chunks, { type: (voice.recorder.mimeType || "audio/webm").split(";")[0] });
    if (blob.size < 2000) {
      $("#voiceLabel").textContent = "Voice note";
      return toast("The recording is too short.", "error");
    }
    transcribeBlob(blob, "Voice note");
  };
  voice.recorder.start();
  voice.started = Date.now();
  btn.classList.add("recording");
  btn.setAttribute("aria-pressed", "true");
  const tick = () => {
    const s = Math.floor((Date.now() - voice.started) / 1000);
    $("#voiceLabel").textContent = `Stop · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (s >= 300) voice.recorder.stop(); // 5 minutes is plenty for an invoice
  };
  tick();
  voice.timer = setInterval(tick, 500);
}

export function setupVoice() {
  $("#voiceBtn").addEventListener("click", toggleRecording);
  $("#audioInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) transcribeBlob(file, "Voice message");
  });
}

export async function loadSamples() {
  const samples = await api("/api/samples");
  state.samples = samples;
  const wrap = $("#sampleChips");
  for (const s of samples) {
    const b = document.createElement("button");
    b.className = "sample-chip";
    b.type = "button";
    b.textContent = s.label;
    b.addEventListener("click", () => {
      $("#chatInput").value = s.text;
      state.images = [];
      renderThumbs();
      $("#chatInput").focus();
    });
    wrap.append(b);
  }
}
