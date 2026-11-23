import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function openFixture(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-journal-test-"));
  const path = join(directory, "fixture.db");
  const reader = new DatabaseSync(path);
  t.after(() => reader.close());
  assert.equal(
    reader.prepare(`PRAGMA journal_mode = ${mode}`).get().journal_mode,
    mode,
  );
  reader.exec(`
    CREATE TABLE companies (id INTEGER PRIMARY KEY);
    INSERT INTO companies VALUES (1);
    CREATE TABLE writes (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id)
    );
  `);

  const writer = new DatabaseSync(path);
  t.after(() => writer.close());
  return { reader, writer, directory };
}

test("DELETE blocks a write commit while a read snapshot is active", (t) => {
  const { reader, writer } = openFixture(t, "delete");
  reader.exec("BEGIN");
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM writes").get().count, 0);

  writer.exec("BEGIN IMMEDIATE; INSERT INTO writes (id) VALUES (1)");
  assert.throws(() => writer.exec("COMMIT"), { errcode: 5 });
  assert.equal(writer.isTransaction, true);
  reader.exec("COMMIT");
  writer.exec("COMMIT");
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM writes").get().count, 1);
});

test("WAL permits a writer to commit during a read snapshot and still serializes writers", (t) => {
  const { reader, writer } = openFixture(t, "wal");
  const count = reader.prepare("SELECT COUNT(*) AS count FROM writes");
  reader.exec("BEGIN");
  assert.equal(count.get().count, 0);

  writer.exec("BEGIN IMMEDIATE; INSERT INTO writes (id) VALUES (1); COMMIT");
  assert.equal(count.get().count, 0);
  reader.exec("COMMIT");
  assert.equal(count.get().count, 1);

  writer.exec("BEGIN IMMEDIATE");
  assert.throws(() => reader.exec("BEGIN IMMEDIATE"), { errcode: 5 });
  writer.exec("ROLLBACK");
});

test("SQLite online backup includes a WAL commit while an older reader is active", async (t) => {
  const { reader, writer, directory } = openFixture(t, "wal");
  const count = reader.prepare("SELECT COUNT(*) AS count FROM writes");
  reader.exec("BEGIN");
  assert.equal(count.get().count, 0);
  writer.exec("INSERT INTO writes (id) VALUES (1)");
  assert.equal(count.get().count, 0);

  const path = join(directory, "snapshot.db");
  await backup(writer, path);
  const restored = new DatabaseSync(path, { readOnly: true });
  t.after(() => restored.close());
  assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM writes").get().count, 1);
  reader.exec("COMMIT");
});
