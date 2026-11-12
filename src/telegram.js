// Telegram bot: forward a client conversation (text, screenshots or a voice note) to the bot, and it
// replies with the AI invoice draft. One tap on "Create & send via PayPal" creates and sends the
// invoice and returns the client's payment link. Only chats linked to a seller (with a one-time code
// from the Seller workspace) can draft or send anything.
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { store } from "./store.js";

const env = process.env;
const API = "https://api.telegram.org";
const BUFFER_MS = 30 * 60_000;
const LINK_MS = 15 * 60_000;

export const telegram = {
  token: env.TELEGRAM_BOT_TOKEN || "",
  get enabled() { return Boolean(this.token); },
  // Secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token on every webhook call.
  get secret() { return env.TELEGRAM_WEBHOOK_SECRET || (this.token ? createHash("sha256").update(`paynudge-webhook:${this.token}`).digest("hex").slice(0, 48) : ""); },
  username: "",
  mode: "off",
};

async function call(method, body) {
  const res = await fetch(`${API}/bot${telegram.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

async function download(fileId, maxBytes) {
  const file = await call("getFile", { file_id: fileId });
  if (file.file_size && file.file_size > maxBytes) throw new Error("That file is too large for the bot.");
  const res = await fetch(`${API}/file/bot${telegram.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error("Could not download the file from Telegram.");
  return Buffer.from(await res.arrayBuffer());
}

export function verifySecret(header) {
  const a = Buffer.from(String(header || ""));
  const b = Buffer.from(telegram.secret);
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

// --- Linking a chat to a seller ------------------------------------------------------------------
export async function createLinkCode(seller) {
  const code = randomBytes(4).toString("hex").toUpperCase();
  await store.set("tglink", code, { seller, expires: Date.now() + LINK_MS });
  return { code, expiresInMinutes: LINK_MS / 60_000, url: telegram.username ? `https://t.me/${telegram.username}?start=${code}` : "" };
}

export function linkedChats(seller) {
  return store.list("telegram").filter(({ value }) => value.seller === seller).map(({ key, value }) => ({ chatId: key, name: value.name, linkedAt: value.linkedAt }));
}

export async function unlinkChat(seller, chatId) {
  const link = store.get("telegram", String(chatId));
  if (!link || link.seller !== seller) throw Object.assign(new Error("That Telegram chat is not linked to this seller."), { status: 404 });
  await store.delete("telegram", String(chatId));
  await send(chatId, "This chat was disconnected from PayNudge.").catch(() => {});
}

// --- Messages ---------------------------------------------------------------------------------
const send = (chatId, text, extra = {}) => call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const escHtml = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const money = (n, c) => `${Number(n).toFixed(2)} ${c}`;

function senderOf(msg) {
  const o = msg.forward_origin;
  const name = o?.sender_user ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ")
    : o?.sender_user_name || o?.chat?.title || (msg.forward_from ? [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(" ") : "");
  return name || (o ? "Client" : "Me");
}

export function draftSummary(d) {
  const lines = [
    `<b>Invoice draft</b> for ${escHtml(d.client.business_name || d.client.name || "an unnamed client")}${d.client.email ? ` (${escHtml(d.client.email)})` : " (no email: you'll get a payment link to forward)"}`,
    "",
    ...d.items.map((it) => `• ${escHtml(it.quantity)} × ${escHtml(it.name)}: <b>${money(it.quantity * it.unit_price, d.currency)}</b>${it.evidence ? `\n   <i>“${escHtml(it.evidence)}”</i>` : "\n   <i>no matching quote in the chat</i>"}`),
    "",
    `Total: <b>${money(d.total, d.currency)}</b>${d.due_date ? ` · due ${d.due_date}` : d.due_on_receipt ? " · due on receipt" : ""}`,
  ];
  if (d.warnings?.length) lines.push("", "<b>Check before sending:</b>", ...d.warnings.slice(0, 6).map((w) => `⚠️ ${escHtml(w)}`));
  return lines.join("\n");
}

// deps: { extract({text, images, seller}), transcribe({media_type, data}), createInvoice(draft, operationId, seller), sellerName(seller), voice }
export function createBot(deps) {
  const buffers = new Map(); // chatId -> { parts: [], images: [], at }
  const busy = new Set();

  function buffer(chatId) {
    const b = buffers.get(chatId);
    if (b && Date.now() - b.at < BUFFER_MS) return b;
    const fresh = { parts: [], images: [], at: Date.now(), started: Date.now() };
    buffers.set(chatId, fresh);
    return fresh;
  }

  async function link(chatId, from, code) {
    const entry = store.get("tglink", code);
    if (!entry || entry.expires < Date.now()) return send(chatId, "That code is invalid or expired. Open PayNudge → Seller → Telegram for a new one.");
    await store.delete("tglink", code);
    await store.set("telegram", String(chatId), { seller: entry.seller, name: [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "Telegram user", linkedAt: new Date().toISOString() });
    return send(chatId, `✅ Linked to <b>${escHtml(deps.sellerName(entry.seller))}</b>.\n\nForward a client conversation here (text, screenshots or a voice note), then tap <b>Draft invoice</b>. Nothing is sent to PayPal until you approve it.`);
  }

  async function draftFrom(chatId, seller) {
    const b = buffer(chatId);
    if (!b.parts.length && !b.images.length) return send(chatId, "Forward the client's messages first, then tap Draft invoice.");
    if (busy.has(chatId)) return;
    busy.add(chatId);
    try {
      await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      const draft = await deps.extract({ text: b.parts.join("\n"), images: b.images, seller });
      buffers.delete(chatId);
      if (!draft.items.length) return send(chatId, `I couldn't find anything to bill.${draft.warnings?.length ? `\n${draft.warnings.map((w) => `⚠️ ${escHtml(w)}`).join("\n")}` : ""}`);
      const id = randomUUID();
      await store.set("tgdraft", String(chatId), { id, seller, draft, at: Date.now(), started: b.started });
      return send(chatId, draftSummary(draft), {
        reply_markup: { inline_keyboard: [[{ text: "✅ Create & send via PayPal", callback_data: `send:${id}` }], [{ text: "✖ Discard", callback_data: `drop:${id}` }]] },
      });
    } catch (err) {
      return send(chatId, `⚠️ ${escHtml(err.message)}`);
    } finally {
      busy.delete(chatId);
    }
  }

  async function onCallback(q) {
    const chatId = q.message?.chat?.id;
    const [action, id] = String(q.data || "").split(":");
    const pending = store.get("tgdraft", String(chatId));
    const linkInfo = store.get("telegram", String(chatId));
    await call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    if (!linkInfo || !pending || pending.id !== id || pending.seller !== linkInfo.seller) {
      return send(chatId, "This draft is no longer current. Forward the chat again to make a new one.");
    }
    const clearButtons = () => call("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (action === "drop") {
      await store.delete("tgdraft", String(chatId));
      await clearButtons();
      return send(chatId, "Discarded. Nothing was sent.");
    }
    if (action !== "send" || busy.has(chatId)) return;
    busy.add(chatId);
    try {
      await clearButtons();
      // The draft ID is PayPal's request ID: a double tap or retry can't create two invoices.
      const seconds = pending.started ? Math.round((Date.now() - pending.started) / 1000) : null;
      const { row, payerUrl, emailed } = await deps.createInvoice(pending.draft, pending.id, pending.seller, { channel: "telegram", seconds });
      await store.delete("tgdraft", String(chatId));
      return send(chatId, emailed
        ? `✅ PayPal sent invoice <b>#${escHtml(row.number)}</b> (${money(row.amount, row.currency)}) to ${escHtml(row.email)}.\n\nPayment link, if you also want to drop it in the chat:\n${escHtml(payerUrl)}`
        : `✅ Invoice <b>#${escHtml(row.number)}</b> (${money(row.amount, row.currency)}) is ready. Forward this payment link to your client:\n${escHtml(payerUrl)}`);
    } catch (err) {
      return send(chatId, `⚠️ ${escHtml(err.message)}`, { reply_markup: { inline_keyboard: [[{ text: "↻ Try again", callback_data: `send:${id}` }]] } });
    } finally {
      busy.delete(chatId);
    }
  }

  async function onMessage(msg) {
    const chatId = msg.chat?.id;
    if (!chatId || msg.chat.type !== "private") return;
    const text = String(msg.text || msg.caption || "").trim();
    const start = /^\/(?:start|link)(?:@\w+)?\s+([A-F0-9]{8})$/i.exec(text);
    if (start) return link(chatId, msg.from, start[1].toUpperCase());
    const linkInfo = store.get("telegram", String(chatId));
    if (!linkInfo) return send(chatId, "Hi! I turn client chats into PayPal invoices for PayNudge sellers.\n\nTo connect, open PayNudge → <b>Seller</b> → <b>Telegram</b> and send me the code shown there, like:\n<code>/link 1A2B3C4D</code>");
    if (/^\/(help|start)\b/.test(text)) return send(chatId, "Forward a client conversation (text, screenshots or a voice note), then tap <b>Draft invoice</b>. I reply with the draft and the chat quotes behind each line; PayPal sends nothing until you tap <b>Create &amp; send</b>.\n\n/invoice: draft from what you forwarded\n/clear: forget forwarded messages");
    if (/^\/clear\b/.test(text)) { buffers.delete(chatId); return send(chatId, "Cleared."); }
    if (/^\/invoice\b/.test(text)) return draftFrom(chatId, linkInfo.seller);

    const b = buffer(chatId);
    const first = !b.parts.length && !b.images.length;
    try {
      if (msg.photo?.length) {
        if (b.images.length >= 3) return send(chatId, "Up to 3 screenshots per invoice. Tap Draft invoice.");
        const photo = msg.photo.at(-1);
        b.images.push({ media_type: "image/jpeg", data: (await download(photo.file_id, 8_000_000)).toString("base64") });
      }
      const audio = msg.voice || msg.audio;
      if (audio) {
        if (!deps.voice) return send(chatId, "Voice notes need the AI voice model, which isn't configured here. Send the text instead.");
        const data = (await download(audio.file_id, 20_000_000)).toString("base64");
        const result = await deps.transcribe({ media_type: audio.mime_type || "audio/ogg", data });
        b.parts.push(`Voice note: ${result.text}`);
        await send(chatId, `🎙 Transcript:\n<i>${escHtml(result.text)}</i>`);
      }
      if (text) b.parts.push(`${senderOf(msg)}: ${text}`);
      b.at = Date.now();
      if (b.parts.join("\n").length > 20000) b.parts = b.parts.slice(-60);
    } catch (err) {
      return send(chatId, `⚠️ ${escHtml(err.message)}`);
    }
    if (first) {
      return send(chatId, "Got it. Forward more messages if there are any, then:", { reply_markup: { inline_keyboard: [[{ text: "🧾 Draft invoice", callback_data: "draft:now" }]] } });
    }
  }

  async function handleUpdate(update) {
    if (update.callback_query?.data === "draft:now") {
      const q = update.callback_query;
      await call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
      const linkInfo = store.get("telegram", String(q.message.chat.id));
      if (linkInfo) return draftFrom(q.message.chat.id, linkInfo.seller);
      return;
    }
    if (update.callback_query) return onCallback(update.callback_query);
    if (update.message) return onMessage(update.message);
  }

  // Webhook when the app has a public HTTPS URL (Render); long polling otherwise (local dev).
  async function start(publicUrl) {
    if (!telegram.enabled) return;
    const me = await call("getMe");
    telegram.username = me.username;
    await call("setMyCommands", { commands: [{ command: "invoice", description: "Draft an invoice from forwarded messages" }, { command: "clear", description: "Forget forwarded messages" }, { command: "help", description: "How it works" }] }).catch(() => {});
    if (publicUrl) {
      await call("setWebhook", { url: `${publicUrl.replace(/\/$/, "")}/api/telegram/webhook`, secret_token: telegram.secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
      telegram.mode = "webhook";
      return;
    }
    await call("deleteWebhook", {});
    telegram.mode = "polling";
    let offset = 0;
    (async function poll() {
      for (;;) {
        try {
          const updates = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
          for (const u of updates) {
            offset = u.update_id + 1;
            await handleUpdate(u).catch((err) => console.warn("Telegram update failed:", err.message));
          }
        } catch (err) {
          console.warn("Telegram polling:", err.message);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  return { handleUpdate, start };
}
