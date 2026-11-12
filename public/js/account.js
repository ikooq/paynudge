import { $, api, esc, state, toast } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// PayPal account: connect the seller's own PayPal business account (partner onboarding), or keep
// using the shared demo seller. Invoices, reminders and plans then run on the seller's account.
// ---------------------------------------------------------------------------------------------
export async function renderAccount(panel) {
  const s = state.status?.seller || {};
  if (s.connected) {
    panel.innerHTML = `
      <div class="settings-card">
        <h4>Connected PayPal account</h4>
        <p class="muted">${esc(s.email || "PayPal business account")} · merchant ID <span class="code-pill">${esc(s.merchantId)}</span></p>
        <p class="muted">Invoices, reminders and payment plans from this browser use this account. PayPal can revoke the permission at any time from the account's settings.</p>
        <label class="field"><span>Business name on invoices</span><input id="acctName" value="${esc(s.name)}" maxlength="100"></label>
        <div class="row"><button class="btn primary" type="button" id="acctSave">Save name</button><span class="spacer"></span><button class="btn ghost" type="button" id="acctOut">Disconnect this browser</button></div>
      </div>`;
    $("#acctSave", panel).addEventListener("click", async () => {
      try {
        await api("/api/account/name", { method: "POST", body: { name: $("#acctName", panel).value } });
        toast("Business name saved.", "ok");
        setTimeout(() => location.reload(), 600);
      } catch (err) { toast(err.message, "error"); }
    });
    $("#acctOut", panel).addEventListener("click", async () => {
      await api("/api/account/disconnect", { method: "POST" });
      location.reload();
    });
    return;
  }
  panel.innerHTML = `
    <div class="settings-card">
      <h4>You're using the shared demo seller</h4>
      <p class="muted">Everyone trying this demo shares one PayPal sandbox seller, <b>${esc(s.name || state.status?.business || "")}</b>. Connect your own PayPal business account to send invoices, reminders and plans from it, with your own price list, recurring invoices and Telegram chat.</p>
      ${s.canConnect
        ? `<div class="row"><button class="btn primary" type="button" id="acctConnect">Connect PayPal</button><span class="muted">You sign in on PayPal and grant invoice permission. PayNudge never sees your password.</span></div>`
        : `<p class="muted">Connecting accounts isn't switched on for this server: it needs the live PayPal sandbox API and the partner merchant ID (<code>PAYPAL_PARTNER_MERCHANT_ID</code>).</p>`}
    </div>`;
  $("#acctConnect", panel)?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      location.href = (await api("/api/account/connect", { method: "POST" })).url;
    } catch (err) {
      toast(err.message, "error");
      e.currentTarget.disabled = false;
    }
  });
}
