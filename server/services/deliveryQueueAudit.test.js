import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installDeliveryQueueAudit } from "./deliveryQueueAudit.js";

function setup() {
  const db = new DatabaseSync(":memory:");

  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
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

  return db;
}

function createEntry(db, id = "queue-1", actorId = "admin-1") {
  db.prepare(
    `
    INSERT INTO delivery_queue (
      id,
      message_id,
      status,
      created_at,
      updated_at,
      created_by
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    `message-${id}`,
    "pending_review",
    "2026-12-01T16:00:00.000Z",
    "2026-12-01T16:00:00.000Z",
    actorId,
  );
}

function approve(db, id = "queue-1", actorId = "admin-1") {
  db.prepare(
    `
    UPDATE delivery_queue
    SET status = 'approved',
        updated_at = ?,
        approved_at = ?,
        approved_by = ?
    WHERE id = ?
  `,
  ).run("2026-12-02T16:00:00.000Z", "2026-12-02T16:00:00.000Z", actorId, id);
}

function simulate(db, id = "queue-1", actorId = "admin-1") {
  db.prepare(
    `
    UPDATE delivery_queue
    SET status = 'simulated',
        updated_at = ?,
        simulated_by = ?
    WHERE id = ?
  `,
  ).run("2026-12-02T16:01:00.000Z", actorId, id);
}

function cancel(db, { id = "queue-1", actorId = null, reason = null } = {}) {
  db.prepare(
    `
    UPDATE delivery_queue
    SET status = 'cancelled',
        updated_at = ?,
        cancelled_by = ?,
        cancel_reason = ?
    WHERE id = ?
  `,
  ).run("2026-12-02T16:02:00.000Z", actorId, reason, id);
}

function audit(db, id = "queue-1") {
  return db
    .prepare(
      `
    SELECT
      event_type AS eventType,
      previous_status AS previousStatus,
      new_status AS newStatus,
      actor_type AS actorType,
      actor_id AS actorId,
      reason,
      created_at AS createdAt
    FROM delivery_queue_audit
    WHERE queue_id = ?
    ORDER BY rowid ASC
  `,
    )
    .all(id);
}

test("Installing audit infrastructure creates required columns", () => {
  const db = setup();

  try {
    const columns = db
      .prepare(
        `
      PRAGMA table_info(delivery_queue)
    `,
      )
      .all()
      .map((column) => column.name);

    assert.ok(columns.includes("created_by"));
    assert.ok(columns.includes("approved_by"));
    assert.ok(columns.includes("simulated_by"));
    assert.ok(columns.includes("cancelled_by"));
    assert.ok(columns.includes("cancel_reason"));
  } finally {
    db.close();
  }
});

test("Queue creation produces an audit event", () => {
  const db = setup();

  try {
    createEntry(db);

    const events = audit(db);

    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "queued");
    assert.equal(events[0].actorType, "user");
    assert.equal(events[0].actorId, "admin-1");
    assert.equal(events[0].previousStatus, null);
    assert.equal(events[0].newStatus, "pending_review");
  } finally {
    db.close();
  }
});

test("Approval records the administrator", () => {
  const db = setup();

  try {
    createEntry(db);
    approve(db, "queue-1", "admin-2");

    const events = audit(db);

    assert.equal(events.length, 2);
    assert.equal(events[1].eventType, "approved");
    assert.equal(events[1].previousStatus, "pending_review");
    assert.equal(events[1].actorType, "user");
    assert.equal(events[1].actorId, "admin-2");
  } finally {
    db.close();
  }
});

test("Simulation records the initiating user", () => {
  const db = setup();

  try {
    createEntry(db);
    approve(db);
    simulate(db, "queue-1", "admin-3");

    const events = audit(db);

    assert.equal(events.length, 3);
    assert.equal(events[2].eventType, "simulated");
    assert.equal(events[2].actorType, "user");
    assert.equal(events[2].actorId, "admin-3");
    assert.equal(events[2].newStatus, "simulated");
  } finally {
    db.close();
  }
});

test("Manual cancellation records the actor and reason", () => {
  const db = setup();

  try {
    createEntry(db);

    cancel(db, {
      actorId: "admin-4",
      reason: "MANUAL_CANCELLATION",
    });

    const events = audit(db);

    assert.equal(events.length, 2);
    assert.equal(events[1].eventType, "cancelled");
    assert.equal(events[1].actorType, "user");
    assert.equal(events[1].actorId, "admin-4");
    assert.equal(events[1].reason, "MANUAL_CANCELLATION");
  } finally {
    db.close();
  }
});

test("Automatic cancellation is attributed to the system", () => {
  const db = setup();

  try {
    createEntry(db);
    cancel(db);

    const events = audit(db);

    assert.equal(events.length, 2);
    assert.equal(events[1].eventType, "cancelled");
    assert.equal(events[1].actorType, "system");
    assert.equal(events[1].actorId, null);
    assert.equal(events[1].reason, "AUTOMATIC_INVALIDATION");
  } finally {
    db.close();
  }
});

test("Updating a status to the same value adds no event", () => {
  const db = setup();

  try {
    createEntry(db);
    approve(db);
    approve(db);

    const events = audit(db);

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.eventType),
      ["queued", "approved"],
    );
  } finally {
    db.close();
  }
});

test("Installing the audit schema twice is safe", () => {
  const db = setup();

  try {
    installDeliveryQueueAudit(db);
    createEntry(db);

    assert.equal(audit(db).length, 1);
  } finally {
    db.close();
  }
});

test("Queue histories remain separated", () => {
  const db = setup();

  try {
    createEntry(db, "queue-a");
    createEntry(db, "queue-b");

    approve(db, "queue-a");

    assert.equal(audit(db, "queue-a").length, 2);
    assert.equal(audit(db, "queue-b").length, 1);
  } finally {
    db.close();
  }
});

test("A transaction rollback removes its audit events", () => {
  const db = setup();

  try {
    createEntry(db);

    db.exec("BEGIN IMMEDIATE");

    approve(db);

    db.exec("ROLLBACK");

    const events = audit(db);

    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "queued");

    const entry = db
      .prepare(
        `
      SELECT status
      FROM delivery_queue
      WHERE id = 'queue-1'
    `,
      )
      .get();

    assert.equal(entry.status, "pending_review");
  } finally {
    db.close();
  }
});

test("Audit history is preserved after later cancellation", () => {
  const db = setup();

  try {
    createEntry(db);
    approve(db);

    cancel(db, {
      reason: "AUTOMATIC_INVALIDATION",
    });

    const events = audit(db);

    assert.deepEqual(
      events.map((event) => event.eventType),
      ["queued", "approved", "cancelled"],
    );

    assert.equal(events[2].previousStatus, "approved");
    assert.equal(events[2].newStatus, "cancelled");
  } finally {
    db.close();
  }
});

test("Unknown actor identity is not fabricated", () => {
  const db = setup();

  try {
    createEntry(db, "queue-1", null);
    approve(db, "queue-1", null);

    const events = audit(db);

    assert.equal(events[0].actorType, "unknown");
    assert.equal(events[0].actorId, null);
    assert.equal(events[1].actorType, "unknown");
    assert.equal(events[1].actorId, null);
  } finally {
    db.close();
  }
});
