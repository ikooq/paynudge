// Local delivery journal. Stores IDs and timestamps only; PayPal remains the source of invoice data.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.resolve(process.env.REMINDER_HISTORY_FILE || "data/reminders.json");
let records = {};
try {
  records = JSON.parse(await readFile(file, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") throw new Error(`Cannot read reminder history: ${err.message}`);
}
let writing = Promise.resolve();

export function reminderHistory(id) { return records[id] || null; }

export async function recordReminder(id, status) {
  const entry = { status, at: new Date().toISOString() };
  records[id] = entry;
  const snapshot = JSON.stringify(records);
  writing = writing.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, snapshot, { mode: 0o600 });
    await rename(temp, file);
  });
  await writing;
  return entry;
}
