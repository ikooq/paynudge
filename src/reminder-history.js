// Delivery journal for reminders. Stores IDs and timestamps only; PayPal remains the source of
// invoice data. Kept in the PayNudge store (PostgreSQL when DATABASE_URL is set, else a JSON file).
import { store } from "./store.js";

export function reminderHistory(id) { return store.get("reminders", id); }

export async function recordReminder(id, status) {
  return store.set("reminders", id, { status, at: new Date().toISOString() });
}
