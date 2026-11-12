// Small persistent key-value store for what PayPal doesn't hold: reminder journal, price catalog,
// recurring schedules, the daily approval queue, connected sellers and Telegram links.
// PayPal stays the source of truth for invoices and payments.
//
// Backends:
//   - DATABASE_URL set: PostgreSQL (one table, JSONB values). Durable across restarts and redeploys.
//   - otherwise: a JSON file (STORE_FILE, default data/store.json). Survives a process restart,
//     but Render's free filesystem is wiped on redeploy.
// Everything is also kept in memory, so reads are synchronous; writes are persisted in order.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const env = process.env;
const legacyReminderFile = env.REMINDER_HISTORY_FILE ? path.resolve(env.REMINDER_HISTORY_FILE) : path.resolve("data/reminders.json");
const file = path.resolve(env.STORE_FILE || (env.REMINDER_HISTORY_FILE ? path.join(path.dirname(legacyReminderFile), "store.json") : "data/store.json"));

const data = {}; // collection -> { key -> value }
let backend = "file";
let pool = null;
let writing = Promise.resolve();

async function loadFile() {
  try {
    Object.assign(data, JSON.parse(await readFile(file, "utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`Cannot read the PayNudge store (${file}): ${err.message}`);
  }
  // One-time import of the older reminder journal file.
  if (!data.reminders) {
    try {
      data.reminders = JSON.parse(await readFile(legacyReminderFile, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`Cannot read reminder history: ${err.message}`);
    }
  }
}

async function loadPostgres() {
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });
  await pool.query(`CREATE TABLE IF NOT EXISTS paynudge_kv (
    collection text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection, key))`);
  const { rows } = await pool.query("SELECT collection, key, value FROM paynudge_kv");
  for (const r of rows) (data[r.collection] ||= {})[r.key] = r.value;
  backend = "postgres";
}

// Demo mode never touches a real database: sample data must not mix with a live deployment's.
const demo = env.DEMO_MODE === "true" || process.argv.includes("--demo");
if (env.DATABASE_URL && !demo) await loadPostgres();
else await loadFile();

function persist(collection, key, value) {
  if (backend === "postgres") {
    const q = value === undefined
      ? pool.query("DELETE FROM paynudge_kv WHERE collection = $1 AND key = $2", [collection, key])
      : pool.query(`INSERT INTO paynudge_kv (collection, key, value) VALUES ($1, $2, $3)
          ON CONFLICT (collection, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [collection, key, JSON.stringify(value)]);
    writing = writing.then(() => q);
  } else {
    const snapshot = JSON.stringify(data);
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, file);
    });
  }
  return writing;
}

export const store = {
  backend: () => backend,
  get(collection, key) {
    return data[collection]?.[key] ?? null;
  },
  list(collection) {
    return Object.entries(data[collection] || {}).map(([key, value]) => ({ key, value }));
  },
  async set(collection, key, value) {
    (data[collection] ||= {})[key] = value;
    await persist(collection, key, value);
    return value;
  },
  async delete(collection, key) {
    if (data[collection]) delete data[collection][key];
    await persist(collection, key, undefined);
  },
};
