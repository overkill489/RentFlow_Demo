import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  installUnsubscribeSchema,
  inspectUnsubscribeToken,
  confirmUnsubscribe,
} from "./unsubscribeService.js";
import { createFollowUpEmailTemplate } from "./followUpEmailTemplate.js";
import { installSenderIdentitySchema } from "./senderIdentity.js";

const NOW = "2026-12-02T16:00:00.000Z";

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
      equipment TEXT NOT NULL
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
      cancelled_by TEXT,
      cancel_reason TEXT
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
    INSERT INTO quotes (
      id, company_id, customer, equipment
    )
    VALUES (?, ?, ?, ?)
  `,
  ).run("QT-TEMPLATE", "company-a", "Template Test Customer", "CAT Excavator");

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
  ).run("QT-TEMPLATE", "template@example.test", NOW, NOW);

  installUnsubscribeSchema(db);
  installSenderIdentitySchema(db);

  return db;
}

function generate(db, overrides = {}) {
  return createFollowUpEmailTemplate(db, {
    companyId: "company-a",
    quoteId: "QT-TEMPLATE",
    customer: "Template Test Customer",
    equipment: "CAT Excavator",
    currentTime: NOW,
    baseUrl: "http://localhost:5000",
    ...overrides,
  });
}

function tokenFromUrl(url) {
  return new URL(url).pathname.split("/").at(-1);
}

function tokenCount(db) {
  return db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM unsubscribe_tokens
  `,
    )
    .get().total;
}

test("Template contains the rental quote ID", () => {
  const db = setup();

  try {
    const result = generate(db);

    assert.ok(result.subject.includes("QT-TEMPLATE"));
    assert.ok(result.body.includes("QT-TEMPLATE"));
  } finally {
    db.close();
  }
});

test("Template contains customer and equipment details", () => {
  const db = setup();

  try {
    const result = generate(db);

    assert.ok(result.body.includes("Template Test Customer"));

    assert.ok(result.body.includes("CAT Excavator"));
  } finally {
    db.close();
  }
});

test("Template includes an unsubscribe URL", () => {
  const db = setup();

  try {
    const result = generate(db);

    assert.ok(result.body.includes(result.unsubscribeUrl));

    assert.ok(result.body.includes("Unsubscribe"));

    assert.ok(
      result.unsubscribeUrl.startsWith(
        "http://localhost:5000/api/unsubscribe/",
      ),
    );
  } finally {
    db.close();
  }
});

test("Generated unsubscribe token is valid", () => {
  const db = setup();

  try {
    const result = generate(db);

    const token = tokenFromUrl(result.unsubscribeUrl);

    const inspection = inspectUnsubscribeToken(db, token, NOW);

    assert.equal(inspection.valid, true);
    assert.equal(inspection.email, "template@example.test");
  } finally {
    db.close();
  }
});

test("Creating a template stores one token hash", () => {
  const db = setup();

  try {
    const result = generate(db);

    assert.equal(tokenCount(db), 1);

    const row = db
      .prepare(
        `
      SELECT token_hash AS tokenHash
      FROM unsubscribe_tokens
    `,
      )
      .get();

    assert.notEqual(row.tokenHash, tokenFromUrl(result.unsubscribeUrl));
  } finally {
    db.close();
  }
});

test("Separate templates receive unique links", () => {
  const db = setup();

  try {
    const first = generate(db);
    const second = generate(db);

    assert.notEqual(first.unsubscribeUrl, second.unsubscribeUrl);

    assert.equal(tokenCount(db), 2);
  } finally {
    db.close();
  }
});

test("Template token can be used to unsubscribe", () => {
  const db = setup();

  try {
    const result = generate(db);

    const confirmation = confirmUnsubscribe(
      db,
      tokenFromUrl(result.unsubscribeUrl),
      "2026-12-03T16:00:00.000Z",
    );

    assert.equal(confirmation.success, true);

    const contact = db
      .prepare(
        `
      SELECT opted_out AS optedOut
      FROM quote_contacts
      WHERE quote_id = 'QT-TEMPLATE'
    `,
      )
      .get();

    assert.equal(contact.optedOut, 1);
  } finally {
    db.close();
  }
});

test("A failed draft transaction rolls back its token", () => {
  const db = setup();

  try {
    assert.throws(() => {
      db.exec("BEGIN IMMEDIATE");

      try {
        generate(db);

        throw new Error("Simulated draft failure");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }, /Simulated draft failure/);

    assert.equal(tokenCount(db), 0);
  } finally {
    db.close();
  }
});

test("Template rejects a different company", () => {
  const db = setup();

  try {
    assert.throws(
      () =>
        generate(db, {
          companyId: "company-b",
        }),
      /Quote contact not found/,
    );

    assert.equal(tokenCount(db), 0);
  } finally {
    db.close();
  }
});

test("Public HTTP unsubscribe URLs are rejected", () => {
  const db = setup();

  try {
    assert.throws(
      () =>
        generate(db, {
          baseUrl: "http://example.com",
        }),
      /Public unsubscribe URLs require HTTPS/,
    );

    assert.equal(tokenCount(db), 0);
  } finally {
    db.close();
  }
});

test("Public HTTPS unsubscribe URLs are allowed", () => {
  const db = setup();

  try {
    const result = generate(db, {
      baseUrl: "https://rentflow.example.test",
    });

    assert.ok(
      result.unsubscribeUrl.startsWith(
        "https://rentflow.example.test/api/unsubscribe/",
      ),
    );
  } finally {
    db.close();
  }
});

test("The generated email never claims delivery", () => {
  const db = setup();

  try {
    const result = generate(db);

    assert.equal(result.body.includes("Email successfully sent"), false);

    assert.equal(tokenCount(db), 1);
  } finally {
    db.close();
  }
});
