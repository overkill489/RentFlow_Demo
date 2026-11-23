import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverDeliveryQueue } from "./deliveryQueueRecovery.js";

const NOW = "2026-12-02T16:00:00.000Z";
const PAST = "2026-12-01T16:00:00.000Z";
const FUTURE = "2026-12-10T16:00:00.000Z";

function createDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);

  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      customer TEXT NOT NULL,
      equipment TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quote_contacts (
      quote_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      opted_out INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS follow_ups (
      quote_id TEXT PRIMARY KEY,
      scheduled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipient_suppressions (
      company_id TEXT NOT NULL,
      email TEXT NOT NULL,
      PRIMARY KEY (company_id, email)
    );

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_queue (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      result TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return db;
}

function seed(db, options = {}) {
  db.prepare(
    `
    INSERT INTO quotes (
      id, company_id, customer, equipment, status
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    "QT-RECOVERY",
    "company-a",
    "Recovery Test Customer",
    "CAT Excavator",
    options.quoteStatus ?? "Follow-up Scheduled",
  );

  if (!options.noContact) {
    db.prepare(
      `
      INSERT INTO quote_contacts (
        quote_id, email, opted_out
      )
      VALUES (?, ?, ?)
    `,
    ).run("QT-RECOVERY", "recovery@example.test", options.optedOut ? 1 : 0);
  }

  if (!options.noSchedule) {
    db.prepare(
      `
      INSERT INTO follow_ups (
        quote_id, scheduled_at
      )
      VALUES (?, ?)
    `,
    ).run("QT-RECOVERY", options.future ? FUTURE : PAST);
  }

  db.prepare(
    `
    INSERT INTO outbound_messages (
      id,
      quote_id,
      recipient_email,
      subject,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "message-recovery",
    "QT-RECOVERY",
    options.wrongRecipient ? "different@example.test" : "recovery@example.test",
    "Rental follow-up",
    options.draftStatus ?? "draft",
    PAST,
  );

  db.prepare(
    `
    INSERT INTO delivery_queue (
      id,
      message_id,
      status,
      created_at,
      updated_at,
      approved_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "queue-recovery",
    "message-recovery",
    options.queueStatus ?? "pending_review",
    PAST,
    PAST,
    null,
  );

  if (options.suppressed) {
    db.prepare(
      `
      INSERT INTO recipient_suppressions (
        company_id, email
      )
      VALUES (?, ?)
    `,
    ).run("company-a", "recovery@example.test");
  }
}

function recover(db, dryRun = false) {
  return recoverDeliveryQueue(db, {
    currentTime: NOW,
    dryRun,
  });
}

function getQueue(db) {
  return db
    .prepare(
      `
    SELECT *
    FROM delivery_queue
    WHERE id = 'queue-recovery'
  `,
    )
    .get();
}

function getDraft(db) {
  return db
    .prepare(
      `
    SELECT *
    FROM outbound_messages
    WHERE id = 'message-recovery'
  `,
    )
    .get();
}

test("Summary stays below the scheduler buffer for a large queue", (t) => {
  const db = createDatabase();
  t.after(() => db.close());

  db.exec(`
    WITH RECURSIVE numbers(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM numbers WHERE n < 6000
    )
    INSERT INTO delivery_queue (id, message_id, status, created_at, updated_at)
    SELECT printf('00000000-0000-4000-8000-%012d', n),
      'missing-message-' || n, 'pending_review', '${PAST}', '${PAST}'
    FROM numbers;
  `);
  seed(db);

  const detailed = recover(db, true);
  assert.equal(detailed.entries.length, 6001);
  assert.ok(Buffer.byteLength(JSON.stringify(detailed, null, 2)) > 1024 * 1024);

  const summary = recoverDeliveryQueue(db, {
    currentTime: NOW,
    includeEntries: false,
  });

  assert.deepEqual(summary, {
    mode: "recovery",
    processingTime: NOW,
    scanned: 6001,
    healthy: 1,
    cancelled: 6000,
    draftsCancelled: 0,
    emailsSent: 0,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 1024);
});

test("Summary mode commits draft and queue cancellations and is safe to rerun", (t) => {
  const db = createDatabase();
  t.after(() => db.close());
  seed(db, { optedOut: true });

  const options = { currentTime: NOW, includeEntries: false };
  const summary = recoverDeliveryQueue(db, options);

  assert.equal(summary.cancelled, 1);
  assert.equal(summary.draftsCancelled, 1);
  assert.equal(getQueue(db).status, "cancelled");
  assert.equal(getDraft(db).status, "cancelled");

  const repeated = recoverDeliveryQueue(db, options);
  assert.equal(repeated.scanned, 0);
  assert.equal(repeated.cancelled, 0);
});

test("Healthy pending queue entry is preserved", () => {
  const db = createDatabase();

  try {
    seed(db);

    const result = recover(db);

    assert.equal(result.scanned, 1);
    assert.equal(result.healthy, 1);
    assert.equal(result.cancelled, 0);
    assert.equal(getQueue(db).status, "pending_review");
    assert.equal(getDraft(db).status, "draft");
  } finally {
    db.close();
  }
});

test("Healthy recovery can run while another connection holds the writer lock", (t) => {
  const { db, writer } = openConcurrentFixture(t);
  seed(db);
  writer.exec("BEGIN IMMEDIATE");
  writer.exec(
    "INSERT INTO recipient_suppressions VALUES ('company-b', 'recovery@example.test')",
  );

  const result = recover(db);

  assert.equal(result.scanned, 1);
  assert.equal(result.healthy, 1);
  assert.equal(getQueue(db).status, "pending_review");
  writer.exec("COMMIT");
  assert.equal(recover(db).healthy, 1);
});

test("Recovery rechecks cancellation under the writer lock", (t) => {
  const { db, writer } = openConcurrentFixture(t);
  seed(db, { suppressed: true });

  const exec = db.exec.bind(db);
  let reachedWritePhase = false;
  db.exec = (sql) => {
    if (sql === "BEGIN IMMEDIATE") {
      assert.equal(db.isTransaction, false);
      reachedWritePhase = true;
      writer.exec(
        "DELETE FROM recipient_suppressions WHERE company_id = 'company-a'",
      );
    }
    return exec(sql);
  };

  const result = recover(db);

  assert.equal(reachedWritePhase, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.healthy, 1);
  assert.equal(result.cancelled, 0);
  assert.equal(result.entries.length, 1);
  assert.equal(getQueue(db).status, "pending_review");
  assert.equal(getDraft(db).status, "draft");
});

function openConcurrentFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-contention-"));
  const path = join(directory, "test.db");
  const db = createDatabase(path);
  const writer = new DatabaseSync(path, { timeout: 0 });
  db.exec("PRAGMA busy_timeout = 0");

  t.after(() => {
    writer.close();
    db.close();
    unlinkSync(path);
    rmdirSync(directory);
  });

  return { db, writer };
}

test("Valid future reminder remains pending", () => {
  const db = createDatabase();

  try {
    seed(db, { future: true });

    const result = recover(db);

    assert.equal(result.healthy, 1);
    assert.equal(result.cancelled, 0);
    assert.equal(result.entries[0].reason, "AWAITING_DUE_TIME");
  } finally {
    db.close();
  }
});

test("Valid approved due entry is preserved", () => {
  const db = createDatabase();

  try {
    seed(db, { queueStatus: "approved" });

    const result = recover(db);

    assert.equal(result.healthy, 1);
    assert.equal(getQueue(db).status, "approved");
  } finally {
    db.close();
  }
});

test("Cancelled draft invalidates its queue entry", () => {
  const db = createDatabase();

  try {
    seed(db, { draftStatus: "cancelled" });

    const result = recover(db);

    assert.equal(result.cancelled, 1);
    assert.equal(getQueue(db).status, "cancelled");
    assert.equal(getDraft(db).status, "cancelled");
  } finally {
    db.close();
  }
});

test("Accepted quote invalidates its draft and queue", () => {
  const db = createDatabase();

  try {
    seed(db, { quoteStatus: "Accepted" });

    const result = recover(db);

    assert.equal(result.cancelled, 1);
    assert.equal(result.draftsCancelled, 1);
    assert.equal(getQueue(db).status, "cancelled");
    assert.equal(getDraft(db).status, "cancelled");
  } finally {
    db.close();
  }
});

test("Opted-out recipient cannot retain an active queue", () => {
  const db = createDatabase();

  try {
    seed(db, { optedOut: true });

    const result = recover(db);

    assert.equal(result.cancelled, 1);
    assert.equal(getQueue(db).status, "cancelled");
    assert.equal(getDraft(db).status, "cancelled");
  } finally {
    db.close();
  }
});

test("Recipient suppression invalidates active entries", () => {
  const db = createDatabase();

  try {
    seed(db, { suppressed: true });

    const result = recover(db);

    assert.equal(result.cancelled, 1);
    assert.equal(result.draftsCancelled, 1);
    assert.equal(getQueue(db).status, "cancelled");
  } finally {
    db.close();
  }
});

test("Missing follow-up invalidates active entries", () => {
  const db = createDatabase();

  try {
    seed(db, { noSchedule: true });

    const result = recover(db);

    assert.equal(result.cancelled, 1);
    assert.equal(getDraft(db).status, "cancelled");
  } finally {
    db.close();
  }
});

test("Recipient mismatch invalidates the queue", () => {
  const db = createDatabase();

  try {
    seed(db, { wrongRecipient: true });

    const result = recover(db);

    assert.equal(result.cancelled, 1);
    assert.equal(getQueue(db).status, "cancelled");
    assert.equal(getDraft(db).status, "cancelled");
  } finally {
    db.close();
  }
});

test("Approved future reminder loses its approval", () => {
  const db = createDatabase();

  try {
    seed(db, {
      queueStatus: "approved",
      future: true,
    });

    const result = recover(db);

    assert.equal(result.cancelled, 1);
    assert.equal(result.entries[0].reason, "APPROVAL_NO_LONGER_VALID");
  } finally {
    db.close();
  }
});

test("Dry-run does not modify queue or drafts", () => {
  const db = createDatabase();

  try {
    seed(db, { optedOut: true });

    const beforeQueue = getQueue(db);
    const beforeDraft = getDraft(db);

    const result = recover(db, true);

    assert.equal(result.mode, "dry-run");
    assert.equal(result.entries[0].decision, "cancel");
    assert.equal(result.cancelled, 0);
    assert.deepEqual(getQueue(db), beforeQueue);
    assert.deepEqual(getDraft(db), beforeDraft);
  } finally {
    db.close();
  }
});

test("Repeated recovery is idempotent", () => {
  const db = createDatabase();

  try {
    seed(db, { quoteStatus: "Accepted" });

    const first = recover(db);
    const second = recover(db);

    assert.equal(first.cancelled, 1);
    assert.equal(second.cancelled, 0);
    assert.equal(second.scanned, 0);
    assert.equal(getQueue(db).status, "cancelled");
  } finally {
    db.close();
  }
});

test("Simulated history is preserved", () => {
  const db = createDatabase();

  try {
    seed(db, {
      queueStatus: "simulated",
      quoteStatus: "Accepted",
    });

    db.prepare(
      `
      INSERT INTO delivery_attempts (
        id, queue_id, result, description, created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run("attempt-1", "queue-recovery", "simulated", "No email sent", PAST);

    const result = recover(db);

    assert.equal(result.scanned, 0);
    assert.equal(getQueue(db).status, "simulated");

    const count = db
      .prepare(
        `
      SELECT COUNT(*) AS total
      FROM delivery_attempts
    `,
      )
      .get().total;

    assert.equal(count, 1);
  } finally {
    db.close();
  }
});

test("Recovery remains durable after database restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-recovery-"));

  const path = join(directory, "test.db");

  let db;

  try {
    db = createDatabase(path);
    seed(db, { optedOut: true });

    const first = recover(db);

    assert.equal(first.cancelled, 1);

    db.close();
    db = null;

    db = createDatabase(path);

    const second = recover(db);

    assert.equal(second.cancelled, 0);
    assert.equal(second.scanned, 0);
    assert.equal(getQueue(db).status, "cancelled");
    assert.equal(getDraft(db).status, "cancelled");
  } finally {
    if (db) {
      db.close();
    }

    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});
