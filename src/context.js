// Which seller the current request (or bot action) acts for. Set once per request by middleware;
// PayPal calls, the activity log and stored settings read it, so handlers don't pass it around.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();
export const DEFAULT_SELLER = { id: "default", merchantId: "", name: "", email: "" };

export function currentSeller() {
  return storage.getStore() || DEFAULT_SELLER;
}

export function runAsSeller(seller, fn) {
  return storage.run(seller || DEFAULT_SELLER, fn);
}
