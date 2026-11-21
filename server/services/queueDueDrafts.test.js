import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installDeliveryQueueAudit } from "./deliveryQueueAudit.js";
import { queueDueDrafts } from "./queueDueDrafts.js";

const NOW = "2026-12-02T16:00:00.000Z";
const PAST = "2026-12-01T16:00:00.000Z";
const FUTURE = "2026-12-10T16:00:00.000Z";

function setup(options = {}) {
  const db = new DatabaseSync(":memory:");

  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      customer TEXT NOT NULL,
      equipment TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE follow_ups (
      quote_id TEXT PRIMARY KEY,
      scheduled_at TEXT NOT NULL
    );

    CREATE TABLE quote_contacts (
      quote_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      opted_out INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE recipient_suppressions (
      company_id TEXT NOT NULL,
      email TEXT NOT NULL,
      PRIMARY KEY (company_id, email)
    );

    CREATE TABLE outbound_messages (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE delivery_queue (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT
    );
  `);

  installDeliveryQueueAudit(db);

  db.prepare(
    `
    INSERT INTO quotes (
      id, company_id, customer, equipment, status
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    "QT-AUTO",
    "company-a",
    "Automatic Queue Test",
    "CAT Excavator",
    options.quoteStatus ?? "Follow-up Scheduled",
  );

  db.prepare(
    `
    INSERT INTO follow_ups (
      quote_id, scheduled_at
    )
    VALUES (?, ?)
  `,
  ).run("QT-AUTO", options.future ? FUTURE : PAST);

  if (!options.noContact) {
    db.prepare(
      `
      INSERT INTO quote_contacts (
        quote_id, email, opted_out
      )
      VALUES (?, ?, ?)
    `,
    ).run("QT-AUTO", "automatic@example.test", options.optedOut ? 1 : 0);
  }

  if (options.suppressed) {
    db.prepare(
      `
      INSERT INTO recipient_suppressions (
        company_id, email
      )
      VALUES (?, ?)
    `,
    ).run("company-a", "automatic@example.test");
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
    "message-auto",
    "QT-AUTO",
    options.wrongRecipient ? "wrong@example.test" : "automatic@example.test",
    "Rental follow-up",
    "draft",
    PAST,
  );

  return db;
}

function process(db, dryRun = false) {
  return queueDueDrafts(db, {
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
    WHERE message_id = 'message-auto'
  `,
    )
    .get();
}

function getAudit(db) {
  return db
    .prepare(
      `
    SELECT
      a.event_type AS eventType,
      a.actor_type AS actorType,
      a.actor_id AS actorId,
      a.reason
    FROM delivery_queue_audit a
    JOIN delivery_queue q ON q.id = a.queue_id
    WHERE q.message_id = 'message-auto'
    ORDER BY a.rowid
  `,
    )
    .all();
}

test("Eligible due draft enters the review queue", () => {
  const db = setup();

  try {
    const result = process(db);

    assert.equal(result.scanned, 1);
    assert.equal(result.eligible, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.emailsSent, 0);
    assert.equal(getQueue(db).status, "pending_review");
  } finally {
    db.close();
  }
});

test("Automatic queue creation records a system audit event", () => {
  const db = setup();

  try {
    process(db);

    const events = getAudit(db);

    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "queued");
    assert.equal(events[0].actorType, "system");
    assert.equal(events[0].actorId, null);
    assert.equal(events[0].reason, "AUTOMATIC_DUE_DRAFT");
  } finally {
    db.close();
  }
});

test("Repeated processing creates no duplicate queue entries", () => {
  const db = setup();

  try {
    const first = process(db);
    const second = process(db);

    assert.equal(first.queued, 1);
    assert.equal(second.queued, 0);
    assert.equal(second.alreadyQueued, 1);

    const count = db
      .prepare(
        `
      SELECT COUNT(*) AS total
      FROM delivery_queue
    `,
      )
      .get().total;

    assert.equal(count, 1);
    assert.equal(getAudit(db).length, 1);
  } finally {
    db.close();
  }
});

test("Future reminders are not queued early", () => {
  const db = setup({ future: true });

  try {
    const result = process(db);

    assert.equal(result.scanned, 0);
    assert.equal(result.queued, 0);
    assert.equal(getQueue(db), undefined);
  } finally {
    db.close();
  }
});

test("Quote-level opt-out blocks automatic queuing", () => {
  const db = setup({ optedOut: true });

  try {
    const result = process(db);

    assert.equal(result.blocked, 1);
    assert.equal(result.queued, 0);
    assert.equal(getQueue(db), undefined);
  } finally {
    db.close();
  }
});

test("Company-wide suppression blocks automatic queuing", () => {
  const db = setup({ suppressed: true });

  try {
    const result = process(db);

    assert.equal(result.blocked, 1);
    assert.equal(result.queued, 0);
    assert.equal(getQueue(db), undefined);
  } finally {
    db.close();
  }
});

test("Recipient mismatch blocks automatic queuing", () => {
  const db = setup({ wrongRecipient: true });

  try {
    const result = process(db);

    assert.equal(result.blocked, 1);
    assert.equal(result.queued, 0);
    assert.equal(getQueue(db), undefined);
  } finally {
    db.close();
  }
});

test("Accepted quotes cannot enter the queue", () => {
  const db = setup({ quoteStatus: "Accepted" });

  try {
    const result = process(db);

    assert.equal(result.scanned, 0);
    assert.equal(result.queued, 0);
    assert.equal(getQueue(db), undefined);
  } finally {
    db.close();
  }
});

test("Dry-run reports eligibility without writing", () => {
  const db = setup();

  try {
    const result = process(db, true);

    assert.equal(result.mode, "dry-run");
    assert.equal(result.eligible, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.emailsSent, 0);
    assert.equal(getQueue(db), undefined);
    assert.equal(getAudit(db).length, 0);
  } finally {
    db.close();
  }
});

test("Cancelled queue entries are not recreated", () => {
  const db = setup();

  try {
    process(db);

    db.prepare(
      `
      UPDATE delivery_queue
      SET status = 'cancelled'
      WHERE message_id = 'message-auto'
    `,
    ).run();

    const result = process(db);

    assert.equal(result.queued, 0);
    assert.equal(result.alreadyQueued, 1);
    assert.equal(getQueue(db).status, "cancelled");
    assert.equal(getAudit(db).length, 2);
  } finally {
    db.close();
  }
});
