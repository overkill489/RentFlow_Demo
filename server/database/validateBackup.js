import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const requiredTables = [
  "companies", "users", "revoked_tokens", "quotes", "follow_ups", "activity_logs",
  "followup_due_events", "quote_contacts", "outbound_messages", "recipient_suppressions",
  "delivery_queue", "delivery_attempts", "delivery_queue_audit", "company_sender_settings",
  "sender_domain_verifications", "unsubscribe_tokens", "delivery_preflight_audit",
];

function validate(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
  if (db.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("SQLite foreign key check failed");
  }

  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(({ name }) => name),
  );
  const missing = requiredTables.filter((table) => !tables.has(table));
  if (missing.length) {
    throw new Error(`Missing RentFlow tables: ${missing.join(", ")}`);
  }

  const counts = Object.fromEntries(requiredTables.map((table) => [
    table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
  const probes = {
    users: `SELECT 1 FROM users u JOIN companies c ON c.id = u.company_id LIMIT 1`,
    quotes: `SELECT 1 FROM quotes q LEFT JOIN companies c ON c.id = q.company_id
             WHERE q.company_id IS NULL OR c.id IS NOT NULL LIMIT 1`,
    follow_ups: `SELECT 1 FROM follow_ups f JOIN quotes q ON q.id = f.quote_id LIMIT 1`,
    recipient_suppressions: `SELECT 1 FROM recipient_suppressions s
                             JOIN companies c ON c.id = s.company_id LIMIT 1`,
    delivery_queue: `SELECT 1 FROM delivery_queue d
                     JOIN outbound_messages m ON m.id = d.message_id
                     JOIN quotes q ON q.id = m.quote_id LIMIT 1`,
  };
  const representativeRecords = {};
  for (const [table, query] of Object.entries(probes)) {
    const present = Boolean(db.prepare(query).get());
    if (!present && counts[table] > 0) {
      throw new Error(`Representative record check failed for ${table}`);
    }
    representativeRecords[table] = present ? "verified" : "empty";
  }
  return { integrity: "ok", foreignKeys: "ok", counts, representativeRecords };
}

const args = process.argv.slice(2);

try {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) {
    throw new Error("Usage: npm run db:validate-backup -- <backup.db>");
  }

  const sourcePath = await realpath(resolve(args[0]));
  if (!(await stat(sourcePath)).isFile()) {
    throw new Error("Backup must be an existing database file");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await lstat(sourcePath + suffix).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (sidecar) throw new Error("Expected a standalone backup file without SQLite sidecars");
  }

  const directory = await mkdtemp(join(tmpdir(), "rentflow-restore-"));
  try {
    const restoredPath = join(directory, "restored.db");
    await copyFile(sourcePath, restoredPath, constants.COPYFILE_EXCL);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      console.log(JSON.stringify(validate(restored)));
    } finally {
      restored.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`Backup validation failed: ${error.message}`);
  process.exitCode = 1;
}
