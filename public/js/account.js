import { $, api, esc, state, toast } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// PayPal account: connect the seller's own PayPal sandbox app (Client ID + Secret), or keep using
// the shared demo seller. Invoices, reminders, plans, the price list, recurring invoices and the
// Telegram link then belong to that seller. Partner onboarding is offered only when PayPal has
// approved this app as a partner.
// ---------------------------------------------------------------------------------------------
export async function renderAccount(panel) {
  const s = state.status?.seller || {};
  if (s.connected) {
    const own = s.kind === "keys";
    panel.innerHTML = `
      <div class="settings-card">
        <h4>Connected: ${esc(s.name)}</h4>
        <p class="muted">${own
          ? "Your own PayPal sandbox app. Invoices, reminders and payment plans from this browser are created in your PayPal account; the shared demo seller is untouched. Your Secret is stored encrypted and never shown again."
          : `${esc(s.email || "PayPal business account")} · merchant ID <span class="code-pill">${esc(s.merchantId)}</span>`}</p>
        <label class="field"><span>Business name on invoices</span><input id="acctName" value="${esc(s.name)}" maxlength="100"></label>
        <div class="row"><button class="btn primary" type="button" id="acctSave">Save name</button><span class="spacer"></span>
          <button class="btn ghost" type="button" id="acctOut">Disconnect this browser</button>
          ${own ? `<button class="btn ghost" type="button" id="acctForget">Disconnect and delete my keys</button>` : ""}
        </div>
      </div>`;
    $("#acctSave", panel).addEventListener("click", async () => {
      try {
        await api("/api/account/name", { method: "POST", body: { name: $("#acctName", panel).value } });
        toast("Business name saved.", "ok");
        setTimeout(() => location.reload(), 600);
      } catch (err) { toast(err.message, "error"); }
    });
    $("#acctOut", panel).addEventListener("click", async () => {
      await api("/api/account/disconnect", { method: "POST", body: {} });
      location.reload();
    });
    $("#acctForget", panel)?.addEventListener("click", async () => {
      if (!confirm("Delete your PayPal app keys from PayNudge? Invoices already in PayPal stay there.")) return;
      await api("/api/account/disconnect", { method: "POST", body: { forget: true } });
      location.reload();
    });
    return;
  }
  panel.innerHTML = `
    <div class="settings-card">
      <h4>You're using the shared demo seller</h4>
      <p class="muted">Everyone trying this demo shares one PayPal sandbox seller, <b>${esc(s.name || state.status?.business || "")}</b>. Connect your own PayPal sandbox app to send invoices, reminders and plans from your own account, with your own price list, recurring invoices and Telegram chat.</p>
    </div>
    ${s.canUseKeys
      ? `<form class="settings-card" id="keysForm" autocomplete="off">
          <h4>Connect your PayPal sandbox app</h4>
          <p class="muted">In developer.paypal.com → <b>Apps &amp; Credentials</b> → <b>Sandbox</b>, open (or create) a REST app whose business account has Invoicing, then copy its keys. Only sandbox keys work here, so no real money can move. PayNudge checks the keys with PayPal, stores the Secret encrypted and never shows it again.</p>
          <label class="field"><span>Business name on invoices</span><input name="name" maxlength="100" placeholder="My business"></label>
          <label class="field"><span>Client ID</span><input name="clientId" spellcheck="false" autocapitalize="off"></label>
          <label class="field"><span>Secret</span><input name="clientSecret" type="password" spellcheck="false" autocapitalize="off"></label>
          <div class="row"><button class="btn primary" type="submit">Connect my PayPal</button></div>
        </form>`
      : `<p class="muted">Connecting your own PayPal needs this server to run on the live PayPal sandbox.</p>`}
    ${s.canConnect ? `<div class="settings-card"><h4>Or sign in with PayPal</h4><div class="row"><button class="btn ghost" type="button" id="acctConnect">Connect with PayPal</button></div></div>` : ""}`;
  $("#keysForm", panel)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const button = $("button[type=submit]", e.currentTarget);
    button.disabled = true;
    button.textContent = "Checking with PayPal…";
    try {
      const { name } = await api("/api/account/keys", { method: "POST", body: { name: f.get("name"), clientId: f.get("clientId"), clientSecret: f.get("clientSecret") } });
      e.currentTarget.reset();
      toast(`Connected: ${name}. Loading your PayPal invoices…`, "ok");
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      toast(err.message, "error");
      button.disabled = false;
      button.textContent = "Connect my PayPal";
    }
  });
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
