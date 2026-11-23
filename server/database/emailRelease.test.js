import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { constants, copyFileSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DUE, NOW, RECIPIENT, senderDomain } from "../services/fixtures/mockDeliveryDatabase.js";
import { createResendFixtureDelivery } from "../services/resendDelivery.js";
import { createResendWebhook } from "../services/resendWebhook.js";

const exec = promisify(execFile);
const worker = fileURLToPath(new URL("./fixtures/emailReleaseWorker.js", import.meta.url));
const signingKey = Buffer.alloc(32, 15);
const ingest = createResendWebhook({
  account: "staging-a", secret: `whsec_${signingKey.toString("base64")}`, clock: () => Date.parse(NOW),
});
const providerMessageId = "56761188-7520-42d8-8898-ff6fc54ce618";

function run(script, ...args) {
  const path = fileURLToPath(new URL(script, import.meta.url));
  return exec(process.execPath, [path, ...args], { windowsHide: true, timeout: 15000 });
}

async function fixture(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "rentflow-email-release-"));
  t.after(() => {
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  });
  const source = join(directory, "source.db");
  writeFileSync(source, "", { flag: "wx" });
  await run("./fixtures/emailReleaseWorker.js", "seed", source);
  return { directory, source };
}

function read(db) {
  return Object.fromEntries([
    ["delivery_queue", "id"], ["delivery_attempts", "id"], ["delivery_queue_audit", "id"],
    ["outbound_messages", "id"], ["recipient_suppressions", "company_id, email"],
  ].map(([table, order]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
}

function onDatabase(path, action) {
  const db = new DatabaseSync(path);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

async function migrate(path) {
  return JSON.parse((await run("./fixtures/emailReleaseWorker.js", "migrate", path)).stdout);
}

async function snapshot(source, destination) {
  await run("./backupDatabase.js", source, destination);
  return JSON.parse((await run("./validateBackup.js", destination)).stdout);
}

function restore(snapshotPath, destination) {
  copyFileSync(snapshotPath, destination, constants.COPYFILE_EXCL);
}

// Recreate the previous attempt-table shape on the fixture, including its stricter code check.
function seedV1(path) {
  onDatabase(path, (db) => db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE email_delivery_attempts RENAME TO fixture_attempts_v2;
    CREATE TABLE email_delivery_attempts (
      delivery_id INTEGER NOT NULL REFERENCES email_deliveries(id), number INTEGER NOT NULL CHECK (number > 0),
      claimed_at TEXT NOT NULL, finished_at TEXT, outcome TEXT CHECK (outcome IN ('accepted', 'rejected', 'ambiguous')),
      error_code TEXT CHECK (error_code IN ('RATE_LIMITED', 'TIMEOUT', 'UNCONFIRMED_RESPONSE')),
      CHECK ((finished_at IS NULL) = (outcome IS NULL)),
      CHECK ((error_code IS NOT NULL) = (coalesce(outcome, '') IN ('rejected', 'ambiguous'))),
      CHECK ((coalesce(outcome, '') = 'rejected') = (coalesce(error_code, '') = 'RATE_LIMITED')),
      PRIMARY KEY (delivery_id, number)
    ) STRICT;
    DROP TABLE fixture_attempts_v2;
    CREATE UNIQUE INDEX email_delivery_one_open_attempt ON email_delivery_attempts(delivery_id) WHERE finished_at IS NULL;
    UPDATE email_delivery_schema SET version = 1;
    INSERT INTO email_deliveries VALUES (
      1, 'b', 'message-b', '${RECIPIENT}', 'resend', 'staging-b', '${providerMessageId}',
      'fixture-b-idempotency', '${"a".repeat(64)}', 'accepted', '${DUE}'
    );
    INSERT INTO email_delivery_attempts VALUES (1, 1, '${DUE}', '${DUE}', 'accepted', NULL);
    INSERT INTO email_delivery_events VALUES (
      'resend', 'staging-b', 'msg_existing', 1, 'delivered', '${"b".repeat(64)}', '${DUE}'
    );
    COMMIT;
  `));
}

function assertIntegrity(db) {
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

test("real backup and restored v1 ledger survive an interrupted v2 upgrade, restart and repetition", { timeout: 20_000 }, async (t) => {
  const { directory, source } = await fixture(t);
  const original = onDatabase(source, read);
  assert.equal(original.delivery_queue.length, 3);
  assert.equal(original.delivery_attempts.length, 1);
  assert.equal(original.delivery_queue_audit.length, 7);
  const preLedger = join(directory, "simulation.db");
  await snapshot(source, preLedger);
  assert.deepEqual(await migrate(source), { version: 2, applied: true });
  seedV1(source);
  const baselineLedger = (path) => onDatabase(path, (db) => {
    assertIntegrity(db);
    assert.deepEqual(read(db), original);
    return ["email_deliveries", "email_delivery_attempts", "email_delivery_events"].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all());
  });
  const expected = baselineLedger(source);
  const backup = join(directory, "before.db");
  const restored = join(directory, "restored.db");
  const recovery = join(directory, "recovery.db");
  const result = await snapshot(source, backup);
  assert.equal(result.emailDeliveryVersion, 1);
  assert.equal(result.counts.delivery_queue_audit, 7);
  const preserved = readFileSync(backup);
  restore(backup, restored);

  const child = fork(worker, ["interrupt", restored], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exit = once(child, "exit");
  try {
    const [checkpoint] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
    assert.equal(checkpoint.transaction, true);
    assert.equal(checkpoint.rebuilt, true);
    assert.match(checkpoint.sql, /IDEMPOTENCY_CONFLICT/);
    assert.equal(child.kill("SIGKILL"), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  }

  assert.deepEqual(baselineLedger(restored), expected);
  onDatabase(restored, (db) => {
    assert.equal(db.prepare("SELECT max(version) AS version FROM email_delivery_schema").get().version, 1);
    assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'email_delivery_attempts'").get().sql,
      /IDEMPOTENCY_CONFLICT/);
  });
  assert.deepEqual(await migrate(restored), { version: 2, applied: true });
  assert.deepEqual(await migrate(restored), { version: 2, applied: false });
  assert.deepEqual(baselineLedger(restored), expected);
  const upgraded = JSON.parse((await run("./validateBackup.js", "--require-email-ledger", restored)).stdout);
  assert.equal(upgraded.emailDeliveryVersion, 2);
  assert.equal(upgraded.counts.email_delivery_events, 1);
  assert.deepEqual(readFileSync(backup), preserved);
  restore(backup, recovery);
  assert.deepEqual(baselineLedger(recovery), expected);
  assert.equal(onDatabase(recovery, (db) => db.prepare("SELECT version FROM email_delivery_schema").get().version), 1);
});

test("backup validation detects a partial email ledger and can require a ledger after migration", async (t) => {
  const { directory, source } = await fixture(t);
  const simulation = join(directory, "simulation.db");
  assert.equal((await snapshot(source, simulation)).integrity, "ok");
  await migrate(source);
  const complete = join(directory, "complete.db");
  const validated = await snapshot(source, complete);
  onDatabase(source, (db) => db.exec("DROP TABLE email_delivery_events"));
  const partial = join(directory, "partial.db");
  await run("./backupDatabase.js", source, partial);
  await assert.rejects(run("./validateBackup.js", partial), /Missing email delivery ledger tables: email_delivery_events/);
  await assert.rejects(run("./validateBackup.js", "--require-email-ledger", simulation), /Email delivery ledger is required/);
  assert.equal(validated.emailDeliveryVersion, 2);
  assert.equal(validated.counts.email_delivery_events, 0);
  const wrongOwner = join(directory, "wrong-owner.db");
  restore(complete, wrongOwner);
  seedV1(wrongOwner);
  onDatabase(wrongOwner, (db) => db.exec("UPDATE email_delivery_events SET provider_account = 'wrong-account'"));
  await assert.rejects(run("./validateBackup.js", wrongOwner), /Email delivery ledger event ownership check failed/);
});

test("restored v2 fixture reconciles an ambiguous Resend handoff, atomically suppresses and survives another restore", async (t) => {
  const { directory, source } = await fixture(t);
  const snapshotPath = join(directory, "simulation.db");
  const database = join(directory, "restored.db");
  await snapshot(source, snapshotPath);
  restore(snapshotPath, database);
  await migrate(database);

  let key;
  let submissions = 0;
  const send = createResendFixtureDelivery({
    account: "staging-a", companyId: "a", fromEmail: `quotes@${senderDomain("a")}`, timeoutMs: 10,
    request(url, options) {
      assert.equal(url, "https://resend.invalid/emails");
      submissions += 1;
      key = options.headers["Idempotency-Key"];
      return new Promise(() => {});
    },
  });
  const queue = { queueId: "queue-a", currentTime: NOW };
  const db = new DatabaseSync(database);
  try {
    assert.deepEqual(await send(db, queue), { state: "ambiguous" });
    assert.deepEqual(await send(db, queue), { state: "ambiguous" });
  } finally {
    db.close();
  }
  const rawBody = Buffer.from(JSON.stringify({
    type: "email.bounced", data: {
      email_id: providerMessageId, to: [RECIPIENT], bounce: { type: "Permanent" }, tags: { rentflow_delivery: key },
    },
  }));
  const id = "msg_restore_bounce";
  const timestamp = String(Date.parse(NOW) / 1000);
  const signature = createHmac("sha256", signingKey).update(`${id}.${timestamp}.`).update(rawBody).digest("base64");
  const event = { rawBody, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } };

  onDatabase(database, (reopened) => {
    assert.deepEqual(ingest(reopened, event), { state: "recorded" });
    assert.equal(reopened.prepare("SELECT state FROM email_deliveries").get().state, "bounced");
    assert.equal(reopened.prepare("SELECT error_code FROM email_delivery_attempts").get().error_code, "TIMEOUT");
    const state = read(reopened);
    assert.deepEqual(state.delivery_queue.map(({ status }) => status), ["cancelled", "approved", "simulated"]);
    assert.deepEqual(state.recipient_suppressions.map(({ company_id, email }) => [company_id, email]), [["a", RECIPIENT]]);
    assert.equal(state.delivery_queue_audit.length, 8);
    assertIntegrity(reopened);
  });
  const after = join(directory, "reconciled.db");
  const result = await snapshot(database, after);
  const recovered = join(directory, "recovered.db");
  restore(after, recovered);
  onDatabase(recovered, (copy) => {
    assert.deepEqual(ingest(copy, event), { state: "duplicate" });
    assertIntegrity(copy);
  });
  assert.equal(result.counts.email_delivery_attempts, 1);
  assert.equal(result.counts.email_delivery_events, 1);
  assert.equal(submissions, 1);
});
