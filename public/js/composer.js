import { $, state, toast } from "./helpers.js";
import { extract } from "./draft.js";

// ---------------------------------------------------------------------------------------------
// Composer: text + screenshots
// ---------------------------------------------------------------------------------------------
export async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    return { media_type: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  for (const f of images) {
    if (state.images.length >= 3) {
      toast("Up to 3 screenshots per invoice.", "error");
      break;
    }
    try {
      state.images.push(await fileToImage(f));
    } catch {
      toast(`Couldn't read ${f.name}`, "error");
    }
  }
  renderThumbs();
}

export function renderThumbs() {
  const wrap = $("#thumbs");
  wrap.innerHTML = "";
  state.images.forEach((img, i) => {
    const el = document.createElement("div");
    el.className = "thumb";
    el.innerHTML = `<img src="${img.preview}" alt="Screenshot ${i + 1}"><button type="button" aria-label="Remove screenshot">✕</button>`;
    el.querySelector("button").addEventListener("click", () => {
      state.images.splice(i, 1);
      renderThumbs();
    });
    wrap.append(el);
  });
  $("#ocrBtn").hidden = state.images.length === 0;
}

export async function readScreenshotsLocally() {
  const images = [...state.images];
  if (!images.length) return;
  const btn = $("#ocrBtn");
  const status = $("#ocrStatus");
  btn.disabled = true;
  $("#extractBtn").disabled = true;
  status.hidden = false;
  status.textContent = "Loading local OCR (English, Russian and Spanish). First use downloads language data and may take a while.";
  let worker;
  let timeoutId;
  let timedOut = false;
  try {
    if (!window.Tesseract) await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/tesseract/tesseract.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load OCR files."));
      document.head.append(script);
    });
    const loading = window.Tesseract.createWorker(["eng", "rus", "spa"], 1, {
      workerPath: "/vendor/tesseract/worker.min.js",
      corePath: "/vendor/tesseract-core",
      langPath: "/vendor/ocr-data",
      logger: (progress) => {
        if (!timedOut && progress.status) status.textContent = `Preparing OCR: ${progress.status} (${Math.round((progress.progress || 0) * 100)}%)`;
      },
    });
    loading.then((lateWorker) => { if (timedOut) lateWorker.terminate(); }).catch(() => {});
    worker = await Promise.race([
      loading,
      new Promise((_, reject) => { timeoutId = setTimeout(() => { timedOut = true; reject(new Error("Loading took too long; refresh the page")); }, 45000); }),
    ]);
    clearTimeout(timeoutId);
    const parts = [];
    for (const [index, img] of images.entries()) {
      status.textContent = `Reading screenshot ${index + 1} of ${images.length} on your device…`;
      const result = await worker.recognize(img.preview);
      const text = result.data.text.trim();
      if (!text) throw new Error(`No text was found in screenshot ${index + 1}.`);
      parts.push(text);
    }
    const field = $("#chatInput");
    field.value = [field.value.trim(), ...parts].filter(Boolean).join("\n\n");
    state.images = state.images.filter((img) => !images.includes(img));
    renderThumbs();
    status.textContent = state.status?.ai.live
      ? "OCR text is ready for review. Correct any mistakes before drafting; the recognized text will be sent to the AI provider."
      : "OCR text is ready for review. Correct any mistakes before drafting; this is demo mode with no live AI.";
    field.focus();
  } catch (err) {
    status.textContent = `Local OCR could not finish: ${err.message}. You can paste the conversation as text.`;
  } finally {
    clearTimeout(timeoutId);
    if (worker) await worker.terminate();
    btn.disabled = timedOut;
    $("#extractBtn").disabled = false;
  }
}

export function setupComposer() {
  const zone = $("#dropzone");
  $("#fileInput").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });
  $("#chatInput").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      if (!e.clipboardData.getData("text")) e.preventDefault();
      addFiles(files);
    }
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    addFiles(e.dataTransfer.files);
  });
  $("#extractBtn").addEventListener("click", extract);
  $("#ocrBtn").addEventListener("click", readScreenshotsLocally);
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) extract();
  });
}
