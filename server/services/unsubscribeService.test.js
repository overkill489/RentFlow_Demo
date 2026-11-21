import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  installUnsubscribeSchema,
  createUnsubscribeToken,
  inspectUnsubscribeToken,
  confirmUnsubscribe,
} from "./unsubscribeService.js";

const NOW = "2026-12-02T16:00:00.000Z";
const LATER = "2026-12-03T16:00:00.000Z";
const EXPIRED = "2027-01-02T16:00:00.000Z";

function setup() {
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
      status TEXT NOT NULL
    );

    CREATE TABLE quote_contacts (
      quote_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      opted_out INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE recipient_suppressions (
      company_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, email)
    );

    CREATE TABLE outbound_messages (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
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
  `);

  for (const companyId of ["company-a", "company-b"]) {
    db.prepare(
      `
      INSERT INTO companies (id)
      VALUES (?)
    `,
    ).run(companyId);
  }

  addQuote(db, "quote-a", "company-a", "customer@example.test");

  addQuote(db, "quote-a-2", "company-a", "customer@example.test");

  addQuote(db, "quote-b", "company-b", "customer@example.test");

  installUnsubscribeSchema(db);

  return db;
}

function addQuote(db, id, companyId, email) {
  db.prepare(
    `
    INSERT INTO quotes (
      id, company_id, customer, status
    )
    VALUES (?, ?, ?, ?)
  `,
  ).run(id, companyId, "Test Customer", "Follow-up Scheduled");

  db.prepare(
    `
    INSERT INTO quote_contacts (
      quote_id,
      email,
      opted_out,
      created_at,
      updated_at
    )
    VALUES (?, ?, 0, ?, ?)
  `,
  ).run(id, email, NOW, NOW);
}

function createLink(db, quoteId = "quote-a") {
  return createUnsubscribeToken(db, {
    companyId: "company-a",
    quoteId,
    currentTime: NOW,
  });
}

function getContact(db, quoteId) {
  return db
    .prepare(
      `
    SELECT email, opted_out AS optedOut
    FROM quote_contacts
    WHERE quote_id = ?
  `,
    )
    .get(quoteId);
}

function getSuppression(db, companyId) {
  return db
    .prepare(
      `
    SELECT email
    FROM recipient_suppressions
    WHERE company_id = ?
  `,
    )
    .all(companyId);
}

function addDraftAndQueue(db) {
  db.prepare(
    `
    INSERT INTO outbound_messages (
      id,
      quote_id,
      recipient_email,
      subject,
      body,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "message-a",
    "quote-a",
    "customer@example.test",
    "Test",
    "Test body",
    "draft",
    NOW,
  );

  db.prepare(
    `
    INSERT INTO delivery_queue (
      id,
      message_id,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run("queue-a", "message-a", "approved", NOW, NOW);
}

test("Generated token has a secure random format", () => {
  const db = setup();

  try {
    const result = createLink(db);

    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(result.expiresAt);
  } finally {
    db.close();
  }
});

test("Only the token hash is stored", () => {
  const db = setup();

  try {
    const result = createLink(db);

    const record = db
      .prepare(
        `
      SELECT token_hash AS tokenHash
      FROM unsubscribe_tokens
    `,
      )
      .get();

    const expected = createHash("sha256").update(result.token).digest("hex");

    assert.equal(record.tokenHash, expected);
    assert.notEqual(record.tokenHash, result.token);
  } finally {
    db.close();
  }
});

test("Valid token can be inspected without changes", () => {
  const db = setup();

  try {
    const link = createLink(db);

    const first = inspectUnsubscribeToken(db, link.token, LATER);

    const second = inspectUnsubscribeToken(db, link.token, LATER);

    assert.equal(first.valid, true);
    assert.equal(second.valid, true);
    assert.equal(getContact(db, "quote-a").optedOut, 0);
    assert.equal(getSuppression(db, "company-a").length, 0);
  } finally {
    db.close();
  }
});

test("Confirmation creates company-level suppression", () => {
  const db = setup();

  try {
    const link = createLink(db);

    const result = confirmUnsubscribe(db, link.token, LATER);

    assert.equal(result.success, true);
    assert.equal(getSuppression(db, "company-a").length, 1);
    assert.equal(
      getSuppression(db, "company-a")[0].email,
      "customer@example.test",
    );
  } finally {
    db.close();
  }
});

test("Confirmation protects matching quotes in one company", () => {
  const db = setup();

  try {
    const link = createLink(db);

    confirmUnsubscribe(db, link.token, LATER);

    assert.equal(getContact(db, "quote-a").optedOut, 1);
    assert.equal(getContact(db, "quote-a-2").optedOut, 1);
    assert.equal(getContact(db, "quote-b").optedOut, 0);
  } finally {
    db.close();
  }
});

test("Completed token cannot be used twice", () => {
  const db = setup();

  try {
    const link = createLink(db);

    const first = confirmUnsubscribe(db, link.token, LATER);

    const second = confirmUnsubscribe(db, link.token, LATER);

    assert.equal(first.success, true);
    assert.equal(second.success, false);
    assert.equal(second.reason, "ALREADY_USED");
    assert.equal(getSuppression(db, "company-a").length, 1);
  } finally {
    db.close();
  }
});

test("Expired token cannot unsubscribe", () => {
  const db = setup();

  try {
    const link = createLink(db);

    const result = confirmUnsubscribe(db, link.token, EXPIRED);

    assert.equal(result.success, false);
    assert.equal(result.reason, "EXPIRED_TOKEN");
    assert.equal(getContact(db, "quote-a").optedOut, 0);
  } finally {
    db.close();
  }
});

test("Altered token is rejected", () => {
  const db = setup();

  try {
    const link = createLink(db);

    const replacement =
      link.token.slice(0, -1) + (link.token.at(-1) === "A" ? "B" : "A");

    const result = confirmUnsubscribe(db, replacement, LATER);

    assert.equal(result.success, false);
    assert.equal(result.reason, "INVALID_TOKEN");
  } finally {
    db.close();
  }
});

test("A different company cannot generate a link for the quote", () => {
  const db = setup();

  try {
    const result = createUnsubscribeToken(db, {
      companyId: "company-b",
      quoteId: "quote-a",
      currentTime: NOW,
    });

    assert.equal(result, null);
  } finally {
    db.close();
  }
});

test("Changing the contact invalidates the original token", () => {
  const db = setup();

  try {
    const link = createLink(db);

    db.prepare(
      `
      UPDATE quote_contacts
      SET email = ?
      WHERE quote_id = ?
    `,
    ).run("replacement@example.test", "quote-a");

    const result = confirmUnsubscribe(db, link.token, LATER);

    assert.equal(result.success, false);
    assert.equal(result.reason, "CONTACT_CHANGED");
    assert.equal(getSuppression(db, "company-a").length, 0);
  } finally {
    db.close();
  }
});

test("Unsubscribing cancels active drafts and queue entries", () => {
  const db = setup();

  try {
    addDraftAndQueue(db);

    const link = createLink(db);

    const result = confirmUnsubscribe(db, link.token, LATER);

    const draft = db
      .prepare(
        `
      SELECT status
      FROM outbound_messages
      WHERE id = 'message-a'
    `,
      )
      .get();

    const queue = db
      .prepare(
        `
      SELECT status, cancel_reason AS reason
      FROM delivery_queue
      WHERE id = 'queue-a'
    `,
      )
      .get();

    assert.equal(result.success, true);
    assert.equal(draft.status, "cancelled");
    assert.equal(queue.status, "cancelled");
  } finally {
    db.close();
  }
});

test("Repeated schema initialization is safe", () => {
  const db = setup();

  try {
    installUnsubscribeSchema(db);
    installUnsubscribeSchema(db);

    const link = createLink(db);

    assert.equal(inspectUnsubscribeToken(db, link.token, LATER).valid, true);
  } finally {
    db.close();
  }
});
