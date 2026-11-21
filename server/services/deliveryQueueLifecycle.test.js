import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runDeliveryQueueAction } from "./deliveryQueueLifecycle.js";

const NOW = "2026-12-02T16:00:00.000Z";
const PAST = "2026-12-01T16:00:00.000Z";
const FUTURE = "2026-12-10T16:00:00.000Z";

function setup(options = {}) {
  const db = new DatabaseSync(":memory:");

  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      customer TEXT NOT NULL,
      equipment TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE quote_contacts (
      quote_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      opted_out INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE follow_ups (
      quote_id TEXT PRIMARY KEY,
      scheduled_at TEXT NOT NULL
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
      approved_at TEXT,
      created_by TEXT,
      approved_by TEXT,
      simulated_by TEXT,
      cancelled_by TEXT,
      cancel_reason TEXT
    );

    CREATE TABLE delivery_attempts (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      result TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (queue_id)
        REFERENCES delivery_queue(id)
    );
  `);

  db.prepare(
    `
    INSERT INTO companies (id)
    VALUES (?)
  `,
  ).run("company-a");

  db.prepare(
    `
    INSERT INTO companies (id)
    VALUES (?)
  `,
  ).run("company-b");

  db.prepare(
    `
    INSERT INTO quotes (
      id, company_id, customer, equipment, status
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    "QT-TEST",
    "company-a",
    "Step 28 Construction",
    "CAT 320 Excavator",
    options.quoteStatus ?? "Follow-up Scheduled",
  );

  if (!options.noSchedule) {
    db.prepare(
      `
      INSERT INTO follow_ups (
        quote_id, scheduled_at
      )
      VALUES (?, ?)
    `,
    ).run("QT-TEST", options.future ? FUTURE : PAST);
  }

  if (!options.noContact) {
    db.prepare(
      `
      INSERT INTO quote_contacts (
        quote_id, email, opted_out
      )
      VALUES (?, ?, ?)
    `,
    ).run("QT-TEST", "step28@example.test", options.optedOut ? 1 : 0);
  }

  if (options.suppressed) {
    db.prepare(
      `
      INSERT INTO recipient_suppressions (
        company_id, email
      )
      VALUES (?, ?)
    `,
    ).run("company-a", "step28@example.test");
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
    "message-1",
    "QT-TEST",
    options.wrongRecipient ? "different@example.test" : "step28@example.test",
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
    "queue-1",
    "message-1",
    options.queueStatus ?? "pending_review",
    PAST,
    PAST,
    options.queueStatus === "approved" ? PAST : null,
  );

  return db;
}

function action(db, type, companyId = "company-a") {
  return runDeliveryQueueAction(db, {
    companyId,
    queueId: "queue-1",
    action: type,
    currentTime: NOW,
  });
}

function queue(db) {
  return db
    .prepare(
      `
    SELECT *
    FROM delivery_queue
    WHERE id = 'queue-1'
  `,
    )
    .get();
}

function attempts(db) {
  return db
    .prepare(
      `
    SELECT *
    FROM delivery_attempts
    WHERE queue_id = 'queue-1'
  `,
    )
    .all();
}

test("Eligible due draft can be approved", () => {
  const db = setup();

  try {
    const result = action(db, "approve");

    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.data.status, "approved");
    assert.equal(result.emailsSent, 0);
    assert.equal(queue(db).status, "approved");
    assert.equal(queue(db).approved_at, NOW);
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Approved draft creates one simulated attempt", () => {
  const db = setup();

  try {
    const approval = action(db, "approve");
    const result = action(db, "simulate");

    assert.equal(approval.success, true);
    assert.equal(result.success, true);
    assert.equal(result.data.status, "simulated");
    assert.equal(result.emailsSent, 0);
    assert.equal(queue(db).status, "simulated");
    assert.equal(attempts(db).length, 1);
    assert.equal(attempts(db)[0].result, "simulated");
  } finally {
    db.close();
  }
});

test("Simulation before approval is rejected", () => {
  const db = setup();

  try {
    const result = action(db, "simulate");

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    assert.equal(queue(db).status, "pending_review");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Repeated approval cannot change the state twice", () => {
  const db = setup();

  try {
    const first = action(db, "approve");
    const second = action(db, "approve");

    assert.equal(first.success, true);
    assert.equal(second.statusCode, 409);
    assert.equal(queue(db).status, "approved");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Repeated simulation cannot duplicate attempts", () => {
  const db = setup();

  try {
    action(db, "approve");

    const first = action(db, "simulate");
    const second = action(db, "simulate");

    assert.equal(first.success, true);
    assert.equal(second.statusCode, 409);
    assert.equal(attempts(db).length, 1);
  } finally {
    db.close();
  }
});

test("Future reminder cannot be approved", () => {
  const db = setup({ future: true });

  try {
    const result = action(db, "approve");

    assert.equal(result.statusCode, 409);
    assert.equal(queue(db).status, "pending_review");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Quote-level opt-out prevents approval", () => {
  const db = setup({ optedOut: true });

  try {
    const result = action(db, "approve");

    assert.equal(result.statusCode, 409);
    assert.equal(queue(db).status, "pending_review");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Recipient suppression prevents simulation", () => {
  const db = setup();

  try {
    assert.equal(action(db, "approve").success, true);

    db.prepare(
      `
      INSERT INTO recipient_suppressions (
        company_id, email
      )
      VALUES (?, ?)
    `,
    ).run("company-a", "step28@example.test");

    const result = action(db, "simulate");

    assert.equal(result.statusCode, 409);
    assert.equal(queue(db).status, "approved");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Accepted quote cannot be approved", () => {
  const db = setup({ quoteStatus: "Accepted" });

  try {
    const result = action(db, "approve");

    assert.equal(result.statusCode, 409);
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Cancelled draft cannot be simulated", () => {
  const db = setup({
    queueStatus: "approved",
    draftStatus: "cancelled",
  });

  try {
    const result = action(db, "simulate");

    assert.equal(result.statusCode, 409);
    assert.equal(queue(db).status, "approved");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Another company cannot approve the queue", () => {
  const db = setup();

  try {
    const result = action(db, "approve", "company-b");

    assert.equal(result.statusCode, 404);
    assert.equal(queue(db).status, "pending_review");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});

test("Recipient mismatch prevents approval", () => {
  const db = setup({ wrongRecipient: true });

  try {
    const result = action(db, "approve");

    assert.equal(result.statusCode, 409);
    assert.equal(queue(db).status, "pending_review");
    assert.equal(attempts(db).length, 0);
  } finally {
    db.close();
  }
});
