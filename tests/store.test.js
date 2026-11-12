import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const storeUrl = new URL("../src/store.js", import.meta.url).href;

test("the file store keeps values across restarts and imports the old reminder journal", async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), "paynudge-store-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const legacy = path.join(tmp, "reminders.json");
  await writeFile(legacy, JSON.stringify({ "INV-1": { status: "sent", at: "2026-11-01T00:00:00.000Z" } }));
  const env = { ...process.env, DATABASE_URL: "", STORE_FILE: path.join(tmp, "store.json"), REMINDER_HISTORY_FILE: legacy };
  const script = (code) => run(process.execPath, ["--input-type=module", "-e", `import { store } from ${JSON.stringify(storeUrl)};\n${code}`], { env });

  await script(`await store.set("catalog", "logo", { name: "Logo", price: 450 }); await store.set("catalog", "gone", { name: "Old" }); await store.delete("catalog", "gone");`);
  const { stdout } = await script(`console.log(JSON.stringify({ logo: store.get("catalog", "logo"), gone: store.get("catalog", "gone"), legacy: store.get("reminders", "INV-1"), backend: store.backend() }));`);
  const read = JSON.parse(stdout);
  assert.deepEqual(read.logo, { name: "Logo", price: 450 });
  assert.equal(read.gone, null);
  assert.equal(read.legacy.status, "sent");
  assert.equal(read.backend, "file");
});
