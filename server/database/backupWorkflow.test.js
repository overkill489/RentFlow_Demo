import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openRentFlowDatabase } from "./openDatabase.js";

const run = promisify(execFile);

function command(script, ...args) {
  const path = fileURLToPath(new URL(`./${script}.js`, import.meta.url));
  return run(process.execPath, [path, ...args], { windowsHide: true, timeout: 15000 });
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-backup-test-"));
  const source = join(directory, "source.db");
  const backup = join(directory, "backup.db");
  const db = new DatabaseSync(source);
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE companies (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY, company_id TEXT REFERENCES companies(id));
    CREATE TABLE quotes (id TEXT PRIMARY KEY, company_id TEXT REFERENCES companies(id));
    CREATE TABLE follow_ups (quote_id TEXT REFERENCES quotes(id));
    CREATE TABLE recipient_suppressions (company_id TEXT REFERENCES companies(id), email TEXT);
    CREATE TABLE outbound_messages (id TEXT PRIMARY KEY, quote_id TEXT REFERENCES quotes(id));
    CREATE TABLE delivery_queue (message_id TEXT REFERENCES outbound_messages(id));
    CREATE TABLE revoked_tokens (id TEXT);
    CREATE TABLE activity_logs (id TEXT);
    CREATE TABLE followup_due_events (id TEXT);
    CREATE TABLE quote_contacts (id TEXT);
    CREATE TABLE delivery_attempts (id TEXT);
    CREATE TABLE delivery_queue_audit (id TEXT);
    CREATE TABLE company_sender_settings (id TEXT);
    CREATE TABLE sender_domain_verifications (id TEXT);
    CREATE TABLE unsubscribe_tokens (id TEXT);
    CREATE TABLE delivery_preflight_audit (id TEXT);
    INSERT INTO companies VALUES ('tenant-a'), ('tenant-b');
    INSERT INTO users VALUES ('user-a', 'tenant-a');
    INSERT INTO quotes VALUES ('quote-a', 'tenant-a'), ('demo', NULL);
    INSERT INTO follow_ups VALUES ('quote-a');
    INSERT INTO outbound_messages VALUES ('draft-a', 'quote-a');
    INSERT INTO delivery_queue VALUES ('draft-a');
  `);
  return { directory, source, backup, db };
}

test("Backs up committed WAL records and excludes an active uncommitted write", async (t) => {
  const { source, backup } = fixture(t);
  const db = openRentFlowDatabase(source, {
    RENTFLOW_SQLITE_PATH: source,
    RENTFLOW_SQLITE_JOURNAL_MODE: "wal",
    RENTFLOW_SQLITE_STORAGE: "local-single-host",
  });
  t.after(() => db.close());
  const mainFile = readFileSync(source);
  db.exec(`
    PRAGMA wal_autocheckpoint = 0;
    INSERT INTO recipient_suppressions VALUES ('tenant-b', 'committed@example.test');
    BEGIN IMMEDIATE;
    INSERT INTO recipient_suppressions VALUES ('tenant-a', 'uncommitted@example.test');
  `);
  assert.ok(readFileSync(source + "-wal").length > 32);
  assert.deepEqual(readFileSync(source), mainFile);

  await command("backupDatabase", source, backup);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recipient_suppressions").get().count, 2);
  db.exec("ROLLBACK");

  const { stdout } = await command("validateBackup", backup);
  const result = JSON.parse(stdout);
  assert.equal(result.integrity, "ok");
  assert.equal(result.foreignKeys, "ok");
  assert.equal(result.counts.companies, 2);
  assert.equal(result.counts.recipient_suppressions, 1);
  assert.equal(result.representativeRecords.delivery_queue, "verified");
  assert.equal(result.representativeRecords.recipient_suppressions, "verified");
  assert.doesNotMatch(stdout, /example\.test|tenant-/);

  const copy = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(copy.prepare("SELECT email FROM recipient_suppressions").get().email,
      "committed@example.test");
  } finally {
    copy.close();
  }
});

test("A DELETE-mode backup validates and keeps an existing backup byte-for-byte", async (t) => {
  const { source, backup, db } = fixture(t);
  await command("backupDatabase", source, backup);
  const before = readFileSync(backup);
  db.exec("INSERT INTO companies VALUES ('tenant-c')");
  await assert.rejects(command("backupDatabase", source, backup), /already exists/);
  await assert.rejects(command("backupDatabase", source, source), /already exists/);
  const { stdout } = await command("validateBackup", backup);
  assert.equal(JSON.parse(stdout).counts.companies, 2);
  assert.deepEqual(readFileSync(backup), before);
});

test("Concurrent backups targeting one path publish only one complete snapshot", async (t) => {
  const { directory, source, backup } = fixture(t);
  const outcomes = await Promise.allSettled([
    command("backupDatabase", source, backup),
    command("backupDatabase", source, backup),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.match(String(outcomes.find(({ status }) => status === "rejected").reason),
    /already exists|EEXIST/);
  await command("validateBackup", backup);
  assert.deepEqual(readdirSync(directory).sort(), ["backup.db", "source.db"]);
});

test("Failed backup leaves no destination or staging directory", async (t) => {
  const { directory, backup } = fixture(t);
  const missing = join(directory, "missing.db");
  const invalid = join(directory, "invalid.db");
  writeFileSync(invalid, "This is not a SQLite database.");

  await assert.rejects(command("backupDatabase", missing, backup), /ENOENT/);
  await assert.rejects(command("backupDatabase", invalid, backup), /not a database/i);
  writeFileSync(backup + "-wal", "Existing sidecar");
  await assert.rejects(command("backupDatabase", join(directory, "source.db"), backup),
    /sidecar already exists/);
  assert.equal(readFileSync(backup + "-wal", "utf8"), "Existing sidecar");
  assert.deepEqual(readdirSync(directory).sort(), ["backup.db-wal", "invalid.db", "source.db"]);
});

test("Validation rejects corrupt and incomplete backups", async (t) => {
  const { source, backup, db } = fixture(t);
  writeFileSync(backup, "This is not a SQLite database.");
  await assert.rejects(command("validateBackup", backup), /not a database/i);

  db.exec("DROP TABLE follow_ups");
  await assert.rejects(command("validateBackup", source), /Missing RentFlow tables: follow_ups/);
});

test("Validation rejects foreign key violations and input with sidecars", async (t) => {
  const { source, db } = fixture(t);
  db.exec("PRAGMA foreign_keys = OFF; INSERT INTO users VALUES ('orphan', 'absent')");
  await assert.rejects(command("validateBackup", source), /foreign key check failed/);

  db.exec("PRAGMA journal_mode = WAL; INSERT INTO companies VALUES ('tenant-c')");
  await assert.rejects(command("validateBackup", source), /standalone backup file/);
});
