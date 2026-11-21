import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  installSenderIdentitySchema,
  getSenderIdentity,
  saveSenderIdentity,
  validateSenderIdentity,
} from "./senderIdentity.js";
import { installUnsubscribeSchema } from "./unsubscribeService.js";
import { createFollowUpEmailTemplate } from "./followUpEmailTemplate.js";

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

  installUnsubscribeSchema(db);
  installSenderIdentitySchema(db);

  for (const companyId of ["company-a", "company-b"]) {
    db.prepare(
      `
      INSERT INTO companies (id)
      VALUES (?)
    `,
    ).run(companyId);
  }

  db.prepare(
    `
    INSERT INTO quotes (
      id, company_id, customer, equipment
    )
    VALUES (?, ?, ?, ?)
  `,
  ).run("QT-SENDER", "company-a", "Sender Test Customer", "CAT Excavator");

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
  ).run("QT-SENDER", "customer@example.test", NOW, NOW);

  return db;
}

function settings(overrides = {}) {
  return {
    displayName: "Company A Equipment Rentals",
    replyToEmail: "Office@Example.Test",
    ...overrides,
  };
}

function save(db, companyId = "company-a", input = settings()) {
  return saveSenderIdentity(db, companyId, input, NOW);
}

function generate(db) {
  return createFollowUpEmailTemplate(db, {
    companyId: "company-a",
    quoteId: "QT-SENDER",
    customer: "Sender Test Customer",
    equipment: "CAT Excavator",
    currentTime: NOW,
    baseUrl: "http://localhost:5000",
  });
}

test("Sender settings schema initializes successfully", () => {
  const db = setup();

  try {
    const tables = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'company_sender_settings'
    `,
      )
      .all();

    assert.equal(tables.length, 1);
  } finally {
    db.close();
  }
});

test("Unconfigured company uses the fallback signature", () => {
  const db = setup();

  try {
    const result = getSenderIdentity(db, "company-a");

    assert.equal(result.configured, false);
    assert.equal(result.displayName, "The Rental Team");
    assert.equal(result.replyToEmail, null);
    assert.equal(result.deliveryEnabled, false);
  } finally {
    db.close();
  }
});

test("Valid sender settings are saved", () => {
  const db = setup();

  try {
    const result = save(db);

    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.data.configured, true);
    assert.equal(result.data.displayName, "Company A Equipment Rentals");
    assert.equal(result.data.replyToEmail, "office@example.test");
  } finally {
    db.close();
  }
});

test("Updating sender settings preserves one record", () => {
  const db = setup();

  try {
    save(db);

    const result = save(
      db,
      "company-a",
      settings({
        displayName: "Updated Rental Company",
      }),
    );

    const count = db
      .prepare(
        `
      SELECT COUNT(*) AS total
      FROM company_sender_settings
      WHERE company_id = 'company-a'
    `,
      )
      .get().total;

    assert.equal(count, 1);
    assert.equal(result.data.displayName, "Updated Rental Company");
  } finally {
    db.close();
  }
});

test("Sender settings are isolated by company", () => {
  const db = setup();

  try {
    save(db, "company-a");

    save(
      db,
      "company-b",
      settings({
        displayName: "Company B Rentals",
        replyToEmail: "companyb@example.test",
      }),
    );

    assert.equal(
      getSenderIdentity(db, "company-a").displayName,
      "Company A Equipment Rentals",
    );

    assert.equal(
      getSenderIdentity(db, "company-b").displayName,
      "Company B Rentals",
    );
  } finally {
    db.close();
  }
});

test("Invalid email addresses are rejected", () => {
  const result = validateSenderIdentity(
    settings({
      replyToEmail: "not-an-email",
    }),
  );

  assert.equal(result.valid, false);
});

test("Header injection through reply-to is rejected", () => {
  const result = validateSenderIdentity(
    settings({
      replyToEmail: "office@example.test\r\nBcc: victim@example.test",
    }),
  );

  assert.equal(result.valid, false);
});

test("Invalid sender display names are rejected", () => {
  const result = validateSenderIdentity(
    settings({
      displayName: "Bad\nSender",
    }),
  );

  assert.equal(result.valid, false);
});

test("Unknown company cannot save sender settings", () => {
  const db = setup();

  try {
    const result = save(db, "company-unknown");

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
  } finally {
    db.close();
  }
});

test("Configured sender appears in the email template", () => {
  const db = setup();

  try {
    save(db);

    const message = generate(db);

    assert.ok(message.body.includes("Company A Equipment Rentals"));

    assert.ok(message.body.includes("office@example.test"));

    assert.equal(message.senderDisplayName, "Company A Equipment Rentals");
    assert.equal(message.replyToEmail, "office@example.test");
  } finally {
    db.close();
  }
});

test("Unconfigured template preserves the old signature", () => {
  const db = setup();

  try {
    const message = generate(db);

    assert.ok(message.body.includes("The Rental Team"));

    assert.equal(message.senderConfigured, false);
    assert.equal(message.replyToEmail, null);
  } finally {
    db.close();
  }
});

test("Sender configuration never enables delivery", () => {
  const db = setup();

  try {
    const saved = save(db);
    const message = generate(db);

    assert.equal(saved.data.domainVerified, false);
    assert.equal(saved.data.deliveryEnabled, false);
    assert.equal(message.deliveryEnabled, false);
    assert.ok(message.body.includes("/api/unsubscribe/"));
  } finally {
    db.close();
  }
});
