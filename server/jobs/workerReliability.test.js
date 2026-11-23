import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startDeliveryQueueScheduler } from "./startDeliveryQueueScheduler.js";
import { createUnsubscribeToken } from "../services/unsubscribeService.js";

const worker = fileURLToPath(new URL("./fixtures/workerReliability.js", import.meta.url));

function start(t, directory, mode, checkpoint = "", gate = "", token = "") {
  const child = fork(worker, [directory, mode, checkpoint, gate, token], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
    timeout: 15000,
  });
  const messages = [];
  let stderr = "";
  child.on("message", (message) => messages.push(message));
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });

  return {
    async checkpoint(expected) {
      if (messages.includes(expected)) return;
      const result = await Promise.race([
        once(child, "message").then(([message]) => message),
        exited.then(() => stderr),
      ]);
      assert.equal(result, expected);
    },
    async finish() {
      const [code, signal] = await exited;
      assert.equal(code, 0, stderr || signal);
      return messages.at(-1);
    },
    async crash() {
      assert.ok(child.kill("SIGKILL"));
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
    },
  };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-workers-"));
  mkdirSync(join(directory, "database"));
  copyFileSync(new URL("../database/db.js", import.meta.url), join(directory, "database", "db.mjs"));
  await start(t, directory, "setup").finish();
  const db = new DatabaseSync(join(directory, "storage", "rentflow.db"));
  t.after(() => db.close());
  return { directory, db };
}

function count(db, table, predicate = "1") {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`).get().n;
}

function queued(db, quote = "quote-a") {
  return db.prepare(`SELECT dq.id, dq.status, dq.approved_by AS approvedBy
                     FROM delivery_queue dq JOIN outbound_messages m ON m.id = dq.message_id
                     WHERE m.quote_id = ?`).get(quote);
}

function assertSinglePass(db) {
  assert.equal(count(db, "followup_due_events"), 2);
  assert.equal(count(db, "activity_logs", "type = 'due'"), 2);
  assert.equal(count(db, "activity_logs", "type = 'draft'"), 2);
  assert.equal(count(db, "outbound_messages", "status = 'draft'"), 2);
  assert.equal(count(db, "unsubscribe_tokens"), 2);
  assert.equal(count(db, "delivery_queue", "status = 'pending_review'"), 2);
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'queued' AND actor_type = 'system'"), 2);
}

test("manual draft returns the draft committed by a concurrent due worker", async (t) => {
  const { directory, db } = await fixture(t);
  const gate = join(directory, "continue");
  const manual = start(t, directory, "manual", "before-begin", gate);
  await manual.checkpoint("before-begin");
  const processed = await start(t, directory, "due").finish();
  assert.equal(processed.queue.queued, 2);
  writeFileSync(gate, "");

  const response = await manual.finish();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.id, db.prepare("SELECT id FROM outbound_messages WHERE quote_id = 'quote-a'").get().id);
  assertSinglePass(db);
});

test("manual drafting observes a suppression committed before it takes the writer lock", async (t) => {
  const { directory, db } = await fixture(t);
  const gate = join(directory, "continue");
  const manual = start(t, directory, "manual", "before-begin", gate);
  await manual.checkpoint("before-begin");
  db.exec("INSERT INTO recipient_suppressions VALUES ('a', 'shared@example.test', '2025-01-02T00:00:00.000Z')");
  writeFileSync(gate, "");

  assert.equal((await manual.finish()).status, 409);
  assert.equal(count(db, "outbound_messages"), 0);
  assert.equal(count(db, "unsubscribe_tokens"), 0);
  assert.equal(db.prepare("SELECT opted_out FROM quote_contacts WHERE quote_id = 'quote-b'").get().opted_out, 0);
});

test("a contending due worker can retry after an abrupt pre-commit crash", async (t) => {
  const { directory, db } = await fixture(t);
  const interrupted = start(t, directory, "due", "before-commit");
  await interrupted.checkpoint("before-commit");
  assert.deepEqual(await start(t, directory, "due-no-wait").finish(), { sqliteBusy: true });
  await interrupted.crash();

  for (const table of ["followup_due_events", "activity_logs", "outbound_messages", "unsubscribe_tokens", "delivery_queue"]) {
    assert.equal(count(db, table), 0, table);
  }
  await start(t, directory, "due").finish();
  assertSinglePass(db);
});

test("overlapping due workers replay a crash between the draft and queue commits without duplicates", async (t) => {
  const { directory, db } = await fixture(t);
  const interrupted = start(t, directory, "due", "after-commit");
  await interrupted.checkpoint("after-commit");
  assert.equal(count(db, "outbound_messages"), 2);
  assert.equal(count(db, "delivery_queue"), 0);
  await interrupted.crash();

  const first = start(t, directory, "due");
  const second = start(t, directory, "due");
  const results = await Promise.all([first.finish(), second.finish()]);
  assert.equal(results.reduce((sum, result) => sum + result.drafts.draftsPrepared, 0), 0);
  assert.equal(results.reduce((sum, result) => sum + result.queue.queued, 0), 2);
  assertSinglePass(db);
});

test("draft and queue batches resume after a committed batch without duplicate history", async (t) => {
  const { directory, db } = await fixture(t);
  db.exec(`
    CREATE TEMP TABLE bulk AS
      WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 50)
      SELECT 'bulk-' || n AS id FROM numbers;
    INSERT INTO quotes (id, company_id, customer, equipment, amount, date, status)
      SELECT id, 'a', 'Bulk customer', 'Lift', 100, '2025-01-01', 'Follow-up Scheduled' FROM bulk;
    INSERT INTO follow_ups
      SELECT id, '2025-01-01T00:00:00.000Z', '2025-01-01', '2025-01-01' FROM bulk;
    INSERT INTO quote_contacts
      SELECT id, id || '@example.test', 0, '2025-01-01', '2025-01-01' FROM bulk;
  `);
  for (const expected of [50, 52]) {
    const drafts = start(t, directory, "due", "after-commit");
    await drafts.checkpoint("after-commit");
    assert.equal(count(db, "outbound_messages"), expected);
    await drafts.crash();
  }

  const queue = start(t, directory, "queue", "after-write-commit");
  await queue.checkpoint("after-write-commit");
  assert.equal(count(db, "delivery_queue"), 50);
  await queue.crash();

  const replay = await start(t, directory, "due").finish();
  assert.equal(replay.drafts.recorded, 0);
  assert.equal(replay.queue.queued, 2);
  assert.equal(count(db, "delivery_queue"), 52);
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'queued' AND actor_type = 'system'"), 52);
  assert.equal(count(db, "activity_logs", "type = 'draft'"), 52);
  assert.equal(count(db, "followup_due_events"), 52);
  assert.equal(count(db, "unsubscribe_tokens"), 52);

  db.exec("BEGIN IMMEDIATE");
  try {
    const quiet = await start(t, directory, "due-no-wait").finish();
    assert.equal(quiet.drafts.recorded, 0);
    assert.equal(quiet.queue.alreadyQueued, 52);
  } finally {
    db.exec("ROLLBACK");
  }
});

test("queue batches revalidate a suppression committed after the read snapshot", async (t) => {
  const { directory, db } = await fixture(t);
  const drafts = start(t, directory, "due", "after-commit");
  await drafts.checkpoint("after-commit");
  await drafts.crash();

  const gate = join(directory, "resume-queue");
  const queue = start(t, directory, "queue", "after-commit", gate);
  await queue.checkpoint("after-commit");
  db.exec("INSERT INTO recipient_suppressions VALUES ('a', 'shared@example.test', '2025-01-02')");
  writeFileSync(gate, "");

  assert.equal((await queue.finish()).queued, 1);
  assert.equal(queued(db), undefined);
  assert.equal(queued(db, "quote-b").status, "pending_review");
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'queued'"), 1);
});

test("approval races and a crashed simulation preserve status, attempts and audit", async (t) => {
  const { directory, db } = await fixture(t);
  await start(t, directory, "due").finish();
  const firstGate = join(directory, "approval-commit");
  const secondGate = join(directory, "approval-begin");
  const first = start(t, directory, "approve", "before-commit", firstGate);
  await first.checkpoint("before-commit");
  const second = start(t, directory, "approve", "before-begin", secondGate);
  await second.checkpoint("before-begin");
  assert.equal(queued(db).status, "pending_review");
  writeFileSync(secondGate, "");
  writeFileSync(firstGate, "");
  const responses = await Promise.all([first.finish(), second.finish()]);
  assert.deepEqual(responses.map(({ statusCode }) => statusCode).sort(), [200, 409]);
  assert.equal(queued(db).approvedBy, "admin-a");
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'approved'"), 1);

  const crash = start(t, directory, "simulate", "before-commit");
  await crash.checkpoint("before-commit");
  await crash.crash();
  assert.equal(queued(db).status, "approved");
  assert.equal(count(db, "delivery_attempts"), 0);
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'simulated'"), 0);

  const simulation = await start(t, directory, "simulate").finish();
  assert.equal(simulation.statusCode, 200);
  assert.equal(simulation.emailsSent, 0);
  assert.equal((await start(t, directory, "simulate").finish()).statusCode, 409);
  assert.equal(queued(db).status, "simulated");
  assert.equal(queued(db, "quote-b").status, "pending_review");
  assert.equal(count(db, "delivery_attempts"), 1);
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'simulated' AND actor_id = 'admin-a'"), 1);
});

test("concurrent unsubscribe consumes the token once and cannot cancel another tenant's queue", async (t) => {
  const { directory, db } = await fixture(t);
  db.exec("PRAGMA journal_mode = WAL");
  await start(t, directory, "due").finish();
  assert.equal((await start(t, directory, "approve").finish()).statusCode, 200);
  const { token } = createUnsubscribeToken(db, {
    companyId: "a", quoteId: "quote-a", currentTime: "2025-01-24T00:00:00.000Z",
  });
  const writerGate = join(directory, "unsubscribe-commit");
  const contenderGate = join(directory, "unsubscribe-begin");
  const first = start(t, directory, "unsubscribe", "before-commit", writerGate, token);
  await first.checkpoint("before-commit");
  const second = start(t, directory, "unsubscribe", "before-begin", contenderGate, token);
  await second.checkpoint("before-begin");
  assert.equal(queued(db).status, "approved");
  assert.equal(count(db, "unsubscribe_tokens", "used_at IS NOT NULL"), 0);
  writeFileSync(contenderGate, "");
  writeFileSync(writerGate, "");

  assert.equal((await first.finish()).success, true);
  assert.deepEqual(await second.finish(), { success: false, reason: "ALREADY_USED" });
  assert.equal((await start(t, directory, "reconcile").finish()).cancelled, 0);
  assert.equal(count(db, "unsubscribe_tokens", "used_at IS NOT NULL"), 1);
  assert.equal(count(db, "recipient_suppressions", "company_id = 'a'"), 1);
  assert.equal(count(db, "recipient_suppressions", "company_id = 'b'"), 0);
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'approved'"), 1);
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'cancelled'"), 1);
  assert.equal(queued(db).status, "cancelled");
  assert.equal(queued(db, "quote-b").status, "pending_review");
});

test("scheduler ticks skip local overlap and two live reconcilers cancel only once", async (t) => {
  const { directory, db } = await fixture(t);
  await start(t, directory, "due").finish();
  db.exec("UPDATE quotes SET status = 'Pending' WHERE id = 'quote-a'");
  const gate = join(directory, "continue");
  const paused = start(t, directory, "reconcile", "after-commit", gate);
  const logger = { log() {}, error() {} };
  t.mock.timers.enable({ apis: ["setInterval"] });
  let ticks = 0;
  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 100,
    logger,
    runJob() {
      ticks += 1;
      return paused.finish();
    },
  });
  t.after(() => scheduler.stop());
  const initial = scheduler.checkNow();
  await paused.checkpoint("after-commit");
  t.mock.timers.tick(300);
  assert.equal(ticks, 1);

  const other = await start(t, directory, "reconcile").finish();
  assert.equal(other.cancelled, 1);
  writeFileSync(gate, "");
  assert.equal(await initial, true);
  assert.equal((await paused.finish()).cancelled, 0);
  assert.equal(queued(db).status, "cancelled");
  assert.equal(queued(db, "quote-b").status, "pending_review");
  assert.equal(count(db, "delivery_queue_audit", "event_type = 'cancelled' AND actor_type = 'system'"), 1);
});
