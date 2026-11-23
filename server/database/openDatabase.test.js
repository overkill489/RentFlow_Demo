import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { openRentFlowDatabase } from "./openDatabase.js";

const run = promisify(execFile);
const journal = (db) => db.prepare("PRAGMA journal_mode").get().journal_mode;
const walOptions = (path) => ({
  RENTFLOW_SQLITE_PATH: path,
  RENTFLOW_SQLITE_JOURNAL_MODE: "wal",
  RENTFLOW_SQLITE_STORAGE: "local-single-host",
});

function fixture() {
  return mkdtempSync(join(tmpdir(), "rentflow-open-db-"));
}

function initialize(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE operations (id INTEGER PRIMARY KEY)");
  } finally {
    db.close();
  }
}

test("Default database path preserves DELETE configuration and creates only the default location", () => {
  const path = join(fixture(), "storage", "rentflow.db");
  const db = openRentFlowDatabase(path, {});
  try {
    assert.ok(existsSync(path));
    assert.equal(journal(db), "delete");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 0);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  } finally {
    db.close();
  }
});

test("WAL requires an existing absolute file and explicit local single-host confirmation", () => {
  const directory = fixture();
  const path = join(directory, "database.db");
  assert.throws(() => openRentFlowDatabase(path, { RENTFLOW_SQLITE_JOURNAL_MODE: "delete" }), /unset or wal/);
  assert.throws(() => openRentFlowDatabase(path, { RENTFLOW_SQLITE_JOURNAL_MODE: "wal" }), /local-single-host/);
  assert.throws(() => openRentFlowDatabase(path, walOptions("relative.db")), /must be absolute/);
  assert.throws(() => openRentFlowDatabase(path, walOptions(path)), { code: "ENOENT" });
  assert.equal(existsSync(path), false);
  writeFileSync(path, "");
  assert.throws(() => openRentFlowDatabase(path, walOptions(path)), /existing database file/);
  assert.throws(() => openRentFlowDatabase(path, walOptions(directory)), /existing database file/);
});

test("WAL refuses common synchronized directories and non-file sidecars before changing journal mode", () => {
  const directory = fixture();
  const synced = join(directory, "OneDrive - Fictional");
  mkdirSync(synced);
  const syncedPath = join(synced, "database.db");
  initialize(syncedPath);
  assert.throws(() => openRentFlowDatabase(syncedPath, walOptions(syncedPath)), /synchronized storage/);

  const path = join(directory, "database.db");
  initialize(path);
  mkdirSync(path + "-shm");
  assert.throws(() => openRentFlowDatabase(path, walOptions(path)), /sidecars must be regular files/);
  const db = new DatabaseSync(path);
  try {
    assert.equal(journal(db), "delete");
  } finally {
    db.close();
  }
});

test("WAL remains selected after close and holds FULL durability without changing timeout", () => {
  const path = join(fixture(), "database.db");
  initialize(path);
  const wal = openRentFlowDatabase(path, walOptions(path));
  try {
    assert.equal(journal(wal), "wal");
    assert.equal(wal.prepare("PRAGMA synchronous").get().synchronous, 2);
    assert.equal(wal.prepare("PRAGMA busy_timeout").get().timeout, 0);
    assert.equal(wal.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    wal.exec("INSERT INTO operations VALUES (1)");
  } finally {
    wal.close();
  }
  const reopened = openRentFlowDatabase(path, {});
  try {
    assert.equal(journal(reopened), "wal");
    assert.equal(reopened.prepare("SELECT id FROM operations").get().id, 1);
    assert.equal(reopened.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
    assert.equal(reopened.prepare("PRAGMA journal_mode = DELETE").get().journal_mode, "delete");
  } finally {
    reopened.close();
  }
  const rolledBack = openRentFlowDatabase(path, { RENTFLOW_SQLITE_PATH: path });
  try {
    assert.equal(journal(rolledBack), "delete");
    assert.equal(rolledBack.prepare("SELECT id FROM operations").get().id, 1);
  } finally {
    rolledBack.close();
  }
});

test("Independent WAL processes can read through an active write and serialize writes", async (t) => {
  const path = join(fixture(), "database.db");
  initialize(path);
  const writer = openRentFlowDatabase(path, walOptions(path));
  t.after(() => writer.close());
  const source = `
    import { openRentFlowDatabase } from ${JSON.stringify(new URL("./openDatabase.js", import.meta.url).href)};
    const path = process.argv[1];
    const db = openRentFlowDatabase(path, JSON.parse(process.argv[2]));
    const count = db.prepare("SELECT COUNT(*) AS count FROM operations").get().count;
    let busy;
    try {
      db.exec("INSERT INTO operations VALUES (2)");
    } catch (error) {
      if (error.errcode !== 5) throw error;
      busy = error.errcode;
    } finally {
      db.close();
    }
    console.log(JSON.stringify({ count, busy }));
  `;
  async function child() {
    const { stdout } = await run(process.execPath, [
      "--input-type=module", "-e", source, path, JSON.stringify(walOptions(path)),
    ], { windowsHide: true, timeout: 10000 });
    return JSON.parse(stdout);
  }

  writer.exec("BEGIN IMMEDIATE; INSERT INTO operations VALUES (1)");
  assert.deepEqual(await child(), { count: 0, busy: 5 });
  writer.exec("COMMIT");
  assert.deepEqual(await child(), { count: 1 });
  assert.equal(writer.prepare("SELECT COUNT(*) AS count FROM operations").get().count, 2);
});
