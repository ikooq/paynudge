import { $, api, esc, toast } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Telegram: link a chat with a one-time code, then forward client conversations to the bot.
// ---------------------------------------------------------------------------------------------
function draw(panel, info, link) {
  if (!info.enabled) {
    panel.innerHTML = `<p class="muted">The Telegram bot isn't switched on for this server. The owner creates a bot with @BotFather and sets <code>TELEGRAM_BOT_TOKEN</code>; PayNudge then connects it automatically.</p>`;
    return;
  }
  const bot = info.username ? `@${esc(info.username)}` : "the bot";
  panel.innerHTML = `
    <p class="muted">Forward a client conversation to ${bot} in Telegram: text, screenshots or a voice note. It replies with the invoice draft and the client's words behind each line. Tap <b>Create &amp; send via PayPal</b> and it returns the payment link. Nothing is sent before you tap.</p>
    <div class="settings-card">
      <h4>Connect a Telegram chat</h4>
      ${link
        ? `<p>Send this code to ${bot} within ${link.expiresInMinutes} minutes:</p>
           <div class="row"><span class="code-pill">/link ${esc(link.code)}</span>${link.url ? `<a class="btn primary" href="${esc(link.url)}" target="_blank" rel="noopener">Open ${bot}</a>` : ""}</div>`
        : `<div class="row"><button class="btn primary" type="button" id="tgLink">Get a link code</button></div>`}
    </div>
    <div class="settings-card">
      <h4>Linked chats</h4>
      ${info.chats.length
        ? info.chats.map((c) => `<div class="row" data-chat="${esc(c.chatId)}"><span>${esc(c.name)}</span><span class="muted">since ${esc(new Date(c.linkedAt).toLocaleDateString())}</span><span class="spacer"></span><button class="btn ghost small" type="button" data-unlink>Disconnect</button></div>`).join("")
        : `<p class="muted">No chat linked yet.</p>`}
    </div>`;
  $("#tgLink", panel)?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      draw(panel, info, await api("/api/telegram/link", { method: "POST" }));
    } catch (err) {
      toast(err.message, "error");
      e.currentTarget.disabled = false;
    }
  });
  panel.querySelectorAll("[data-unlink]").forEach((b) =>
    b.addEventListener("click", async () => {
      const chatId = b.closest("[data-chat]").dataset.chat;
      try {
        await api(`/api/telegram/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
        info.chats = info.chats.filter((c) => c.chatId !== chatId);
        draw(panel, info, link);
      } catch (err) {
        toast(err.message, "error");
      }
    }),
  );
}

export async function renderTelegram(panel) {
  panel.innerHTML = `<p class="muted">Checking the Telegram bot…</p>`;
  try {
    draw(panel, await api("/api/telegram"));
  } catch (err) {
    panel.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}
