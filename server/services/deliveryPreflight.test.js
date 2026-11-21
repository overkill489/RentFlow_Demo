import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { installUnsubscribeSchema } from "./unsubscribeService.js";
import { createFollowUpEmailTemplate } from "./followUpEmailTemplate.js";
import {
  installSenderIdentitySchema,
  saveSenderIdentity,
} from "./senderIdentity.js";
import {
  installSenderVerificationSchema,
  prepareSenderDomainVerification,
} from "./senderVerification.js";
import { getDeliveryPreflight } from "./deliveryPreflight.js";

const NOW = "2026-12-02T16:00:00.000Z";
const PAST = "2026-12-01T16:00:00.000Z";
const FUTURE = "2026-12-10T16:00:00.000Z";
const EXPIRED = "2027-02-01T16:00:00.000Z";

function createDatabase() {
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

    CREATE TABLE follow_ups (
      quote_id TEXT PRIMARY KEY,
      scheduled_at TEXT NOT NULL
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
      approved_at TEXT
    );
  `);

  installUnsubscribeSchema(db);
  installSenderIdentitySchema(db);
  installSenderVerificationSchema(db);

  for (const id of ["company-a", "company-b"]) {
    db.prepare(
      `
      INSERT INTO companies (id)
      VALUES (?)
    `,
    ).run(id);
  }

  db.prepare(
    `
    INSERT INTO quotes (
      id, company_id, customer, equipment, status
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    "QT-PREFLIGHT",
    "company-a",
    "Preflight Test Customer",
    "CAT 320 Excavator",
    "Follow-up Scheduled",
  );

  db.prepare(
    `
    INSERT INTO quote_contacts (
      quote_id, email, opted_out,
      created_at, updated_at
    )
    VALUES (?, ?, 0, ?, ?)
  `,
  ).run("QT-PREFLIGHT", "customer@example.test", PAST, PAST);

  db.prepare(
    `
    INSERT INTO follow_ups (
      quote_id, scheduled_at
    )
    VALUES (?, ?)
  `,
  ).run("QT-PREFLIGHT", PAST);

  const saved = saveSenderIdentity(
    db,
    "company-a",
    {
      displayName: "Preflight Equipment Rentals",
      replyToEmail: "office@rentalco.com",
    },
    PAST,
  );

  assert.equal(saved.success, true);

  const prepared = prepareSenderDomainVerification(db, "company-a", PAST);

  assert.equal(prepared.success, true);

  db.prepare(
    `
    UPDATE sender_domain_verifications
    SET
      verified_at = ?,
      last_checked_at = ?,
      last_check_result = 'TXT_MATCH'
    WHERE company_id = ?
  `,
  ).run(PAST, PAST, "company-a");

  const template = createFollowUpEmailTemplate(db, {
    companyId: "company-a",
    quoteId: "QT-PREFLIGHT",
    customer: "Preflight Test Customer",
    equipment: "CAT 320 Excavator",
    currentTime: PAST,
    baseUrl: "http://localhost:5000",
  });

  db.prepare(
    `
    INSERT INTO outbound_messages (
      id, quote_id, recipient_email,
      subject, body, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, 'draft', ?)
  `,
  ).run(
    "message-preflight",
    "QT-PREFLIGHT",
    "customer@example.test",
    template.subject,
    template.body,
    PAST,
  );

  db.prepare(
    `
    INSERT INTO delivery_queue (
      id, message_id, status,
      created_at, updated_at, approved_at
    )
    VALUES (?, ?, 'approved', ?, ?, ?)
  `,
  ).run("queue-preflight", "message-preflight", PAST, PAST, PAST);

  return db;
}

function config(overrides = {}) {
  return {
    provider: "resend",
    fromEmail: "notifications@rentalco.com",
    ...overrides,
  };
}

function check(
  db,
  {
    companyId = "company-a",
    currentTime = NOW,
    providerConfig = config(),
  } = {},
) {
  return getDeliveryPreflight(db, {
    companyId,
    queueId: "queue-preflight",
    currentTime,
    providerConfig,
  });
}

function hasReason(result, reason) {
  return result.reasons.includes(reason);
}

test("Eligible message passes technical checks but remains blocked", () => {
  const db = createDatabase();

  try {
    const result = check(db);

    assert.equal(result.technicalChecksPassed, true);
    assert.equal(result.unsubscribeValid, true);
    assert.equal(result.providerConfigurationValid, true);
    assert.equal(result.queueStatus, "approved");
    assert.equal(result.status, "blocked");
    assert.equal(result.deliveryEnabled, false);
    assert.equal(result.emailsSent, 0);
  } finally {
    db.close();
  }
});

test("Explicit safety gates remain disabled", () => {
  const db = createDatabase();

  try {
    const result = check(db);

    assert.equal(result.providerConnectionVerified, false);
    assert.equal(result.sendingAuthorized, false);

    assert.ok(hasReason(result, "PROVIDER_CONNECTION_NOT_VERIFIED"));

    assert.ok(hasReason(result, "SENDING_NOT_AUTHORIZED"));

    assert.ok(hasReason(result, "DELIVERY_DISABLED"));
  } finally {
    db.close();
  }
});

test("Pending review queue cannot pass preflight", () => {
  const db = createDatabase();

  try {
    db.prepare(
      `
      UPDATE delivery_queue
      SET status = 'pending_review'
      WHERE id = 'queue-preflight'
    `,
    ).run();

    const result = check(db);

    assert.equal(result.technicalChecksPassed, false);
    assert.ok(hasReason(result, "QUEUE_NOT_APPROVED"));
  } finally {
    db.close();
  }
});

test("Accepted quote is blocked", () => {
  const db = createDatabase();

  try {
    db.prepare(
      `
      UPDATE quotes
      SET status = 'Accepted'
      WHERE id = 'QT-PREFLIGHT'
    `,
    ).run();

    const result = check(db);

    assert.equal(result.technicalChecksPassed, false);
    assert.ok(hasReason(result, "QUOTE_ACCEPTED"));
  } finally {
    db.close();
  }
});

test("Future reminder is blocked before due time", () => {
  const db = createDatabase();

  try {
    db.prepare(
      `
      UPDATE follow_ups
      SET scheduled_at = ?
      WHERE quote_id = 'QT-PREFLIGHT'
    `,
    ).run(FUTURE);

    const result = check(db);

    assert.equal(result.technicalChecksPassed, false);
    assert.ok(hasReason(result, "FOLLOWUP_NOT_DUE"));
  } finally {
    db.close();
  }
});

test("Recipient suppression blocks preflight", () => {
  const db = createDatabase();

  try {
    db.prepare(
      `
      INSERT INTO recipient_suppressions (
        company_id, email, created_at
      )
      VALUES (?, ?, ?)
    `,
    ).run("company-a", "customer@example.test", NOW);

    const result = check(db);

    assert.equal(result.technicalChecksPassed, false);
    assert.ok(hasReason(result, "RECIPIENT_OPTED_OUT"));
  } finally {
    db.close();
  }
});

test("Draft recipient mismatch blocks preflight", () => {
  const db = createDatabase();

  try {
    db.prepare(
      `
      UPDATE outbound_messages
      SET recipient_email = ?
      WHERE id = 'message-preflight'
    `,
    ).run("different@example.test");

    const result = check(db);

    assert.equal(result.technicalChecksPassed, false);
    assert.ok(hasReason(result, "DRAFT_RECIPIENT_MISMATCH"));
  } finally {
    db.close();
  }
});

test("Missing unsubscribe link blocks preflight", () => {
  const db = createDatabase();

  try {
    db.prepare(
      `
      UPDATE outbound_messages
      SET body = 'Follow-up without unsubscribe information'
      WHERE id = 'message-preflight'
    `,
    ).run();

    const result = check(db);

    assert.equal(result.unsubscribeValid, false);
    assert.equal(result.technicalChecksPassed, false);
    assert.ok(hasReason(result, "UNSUBSCRIBE_LINK_MISSING_OR_AMBIGUOUS"));
  } finally {
    db.close();
  }
});

test("Unknown unsubscribe token blocks preflight", () => {
  const db = createDatabase();

  try {
    const draft = db
      .prepare(
        `
      SELECT body
      FROM outbound_messages
      WHERE id = 'message-preflight'
    `,
      )
      .get();

    const modified = draft.body.replace(
      /\/api\/unsubscribe\/[A-Za-z0-9_-]{43}/,
      `/api/unsubscribe/${"A".repeat(43)}`,
    );

    db.prepare(
      `
      UPDATE outbound_messages
      SET body = ?
      WHERE id = 'message-preflight'
    `,
    ).run(modified);

    const result = check(db);

    assert.equal(result.unsubscribeValid, false);
    assert.ok(hasReason(result, "UNSUBSCRIBE_TOKEN_NOT_FOUND"));
  } finally {
    db.close();
  }
});

test("Expired unsubscribe token blocks preflight", () => {
  const db = createDatabase();

  try {
    const result = check(db, {
      currentTime: EXPIRED,
    });

    assert.equal(result.unsubscribeValid, false);
    assert.ok(hasReason(result, "UNSUBSCRIBE_TOKEN_EXPIRED"));
  } finally {
    db.close();
  }
});

test("Used unsubscribe token blocks preflight", () => {
  const db = createDatabase();

  try {
    db.prepare(
      `
      UPDATE unsubscribe_tokens
      SET used_at = ?
    `,
    ).run(NOW);

    const result = check(db);

    assert.equal(result.unsubscribeValid, false);
    assert.ok(hasReason(result, "UNSUBSCRIBE_TOKEN_USED"));
  } finally {
    db.close();
  }
});

test("Provider settings and company isolation are enforced", () => {
  const db = createDatabase();

  try {
    const invalid = check(db, {
      providerConfig: config({
        provider: "disabled",
        fromEmail: "",
      }),
    });

    assert.equal(invalid.technicalChecksPassed, false);
    assert.ok(hasReason(invalid, "PROVIDER_CONFIGURATION_INCOMPLETE"));

    assert.equal(
      check(db, {
        companyId: "company-b",
      }),
      null,
    );
  } finally {
    db.close();
  }
});

test("Repeated preflight checks never change database records", () => {
  const db = createDatabase();

  try {
    const beforeQueue = db
      .prepare(
        `
      SELECT * FROM delivery_queue
    `,
      )
      .all();

    const beforeMessages = db
      .prepare(
        `
      SELECT * FROM outbound_messages
    `,
      )
      .all();

    const beforeTokens = db
      .prepare(
        `
      SELECT * FROM unsubscribe_tokens
    `,
      )
      .all();

    check(db);
    check(db);

    assert.deepEqual(
      db.prepare("SELECT * FROM delivery_queue").all(),
      beforeQueue,
    );

    assert.deepEqual(
      db.prepare("SELECT * FROM outbound_messages").all(),
      beforeMessages,
    );

    assert.deepEqual(
      db.prepare("SELECT * FROM unsubscribe_tokens").all(),
      beforeTokens,
    );
  } finally {
    db.close();
  }
});
