import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { processDueFollowUps } from "./dueFollowUpProcessor.js";
import {
  installUnsubscribeSchema,
  inspectUnsubscribeToken,
} from "../services/unsubscribeService.js";
import { installSenderIdentitySchema } from "../services/senderIdentity.js";

const DUE = "2026-12-01T16:00:00.000Z";
const NOW = "2026-12-02T16:00:00.000Z";
const FUTURE = "2026-12-10T16:00:00.000Z";

function createDatabase() {
  const db = new DatabaseSync(":memory:");

  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      customer TEXT NOT NULL,
      equipment TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE follow_ups (
      quote_id TEXT PRIMARY KEY,
      scheduled_at TEXT NOT NULL,
      FOREIGN KEY (quote_id)
        REFERENCES quotes(id)
    );

    CREATE TABLE quote_contacts (
      quote_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      opted_out INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (quote_id)
        REFERENCES quotes(id)
    );

    CREATE TABLE recipient_suppressions (
      company_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, email)
    );

    CREATE TABLE followup_due_events (
      quote_id TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      PRIMARY KEY (quote_id, scheduled_at)
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

    CREATE UNIQUE INDEX unique_active_draft
    ON outbound_messages(quote_id)
    WHERE status = 'draft';

    CREATE TABLE activity_logs (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TRIGGER cancel_draft_on_reschedule
    AFTER UPDATE OF scheduled_at ON follow_ups
    WHEN OLD.scheduled_at <> NEW.scheduled_at
    BEGIN
      UPDATE outbound_messages
      SET status = 'cancelled'
      WHERE quote_id = NEW.quote_id
        AND status = 'draft';
    END;

    CREATE TRIGGER cancel_draft_on_followup_delete
    AFTER DELETE ON follow_ups
    BEGIN
      UPDATE outbound_messages
      SET status = 'cancelled'
      WHERE quote_id = OLD.quote_id
        AND status = 'draft';
    END;

    CREATE TRIGGER cancel_draft_on_quote_accept
    AFTER UPDATE OF status ON quotes
    WHEN NEW.status = 'Accepted'
    BEGIN
      UPDATE outbound_messages
      SET status = 'cancelled'
      WHERE quote_id = NEW.id
        AND status = 'draft';
    END;
  `);

  installUnsubscribeSchema(db);
  installSenderIdentitySchema(db);

  db.prepare(
    `
    INSERT INTO companies (id)
    VALUES (?)
  `,
  ).run("company-a");

  return db;
}

function addQuote(
  db,
  id,
  {
    email = null,
    optedOut = false,
    status = "Follow-up Scheduled",
    scheduledAt = DUE,
  } = {},
) {
  db.prepare(
    `
    INSERT INTO quotes (
      id,
      company_id,
      customer,
      equipment,
      status
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(id, "company-a", `Customer ${id}`, "CAT Excavator", status);

  db.prepare(
    `
    INSERT INTO follow_ups (
      quote_id,
      scheduled_at
    )
    VALUES (?, ?)
  `,
  ).run(id, scheduledAt);

  if (email) {
    addContact(db, id, email, optedOut);
  }
}

function addContact(db, quoteId, email, optedOut = false) {
  db.prepare(
    `
    INSERT INTO quote_contacts (
      quote_id,
      email,
      opted_out,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(quoteId, email, optedOut ? 1 : 0, DUE, DUE);
}

function count(db, table, condition = "1 = 1") {
  return db
    .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${condition}`)
    .get().total;
}

function getDraft(db, quoteId) {
  return db
    .prepare(
      `
    SELECT
      id,
      quote_id AS quoteId,
      recipient_email AS recipientEmail,
      subject,
      body,
      status
    FROM outbound_messages
    WHERE quote_id = ?
    ORDER BY rowid DESC
    LIMIT 1
  `,
    )
    .get(quoteId);
}

function getUnsubscribeToken(body) {
  const match = body.match(
    /https?:\/\/[^\s]+\/api\/unsubscribe\/([A-Za-z0-9_-]{43})/,
  );

  return match?.[1] ?? null;
}

test("Due-time processor writes exactly one eligible draft", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-1", {
      email: "eligible@example.test",
    });

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.detected, 1);
    assert.equal(result.recorded, 1);
    assert.equal(result.draftsPrepared, 1);
    assert.equal(result.emailsSent, 0);

    assert.equal(count(db, "followup_due_events"), 1);
    assert.equal(count(db, "outbound_messages"), 1);
    assert.equal(count(db, "activity_logs"), 2);
    assert.equal(count(db, "unsubscribe_tokens"), 1);

    const draft = getDraft(db, "QT-TEST-1");

    assert.equal(draft.status, "draft");
    assert.equal(draft.recipientEmail, "eligible@example.test");

    assert.ok(
      draft.body.includes("Unsubscribe from rental quote follow-up emails:"),
    );

    const token = getUnsubscribeToken(draft.body);

    assert.ok(token);

    const inspection = inspectUnsubscribeToken(db, token, NOW);

    assert.equal(inspection.valid, true);
    assert.equal(inspection.email, "eligible@example.test");
  } finally {
    db.close();
  }
});

test("Repeated processing does not create duplicate records", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-2", {
      email: "duplicate@example.test",
    });

    processDueFollowUps(db, NOW);

    const second = processDueFollowUps(db, NOW);

    assert.equal(second.recorded, 0);
    assert.equal(second.draftsPrepared, 0);

    assert.equal(count(db, "followup_due_events"), 1);
    assert.equal(count(db, "outbound_messages"), 1);
    assert.equal(count(db, "activity_logs"), 2);
    assert.equal(count(db, "unsubscribe_tokens"), 1);
  } finally {
    db.close();
  }
});

test("Missing contact prevents draft preparation", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-3");

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.recorded, 1);
    assert.equal(result.draftsPrepared, 0);
    assert.equal(result.skipped.missingContact, 1);

    assert.equal(count(db, "outbound_messages"), 0);
    assert.equal(count(db, "unsubscribe_tokens"), 0);
  } finally {
    db.close();
  }
});

test("Contact added after due detection allows a draft", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-4");

    processDueFollowUps(db, NOW);

    addContact(db, "QT-TEST-4", "late@example.test");

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.recorded, 0);
    assert.equal(result.draftsPrepared, 1);

    assert.equal(count(db, "followup_due_events"), 1);
    assert.equal(count(db, "outbound_messages"), 1);
    assert.equal(count(db, "unsubscribe_tokens"), 1);

    const draft = getDraft(db, "QT-TEST-4");

    assert.ok(getUnsubscribeToken(draft.body));
  } finally {
    db.close();
  }
});

test("Quote-level opt-out prevents draft preparation", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-5", {
      email: "opted@example.test",
      optedOut: true,
    });

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.draftsPrepared, 0);
    assert.equal(result.skipped.optedOut, 1);

    assert.equal(count(db, "outbound_messages"), 0);
    assert.equal(count(db, "unsubscribe_tokens"), 0);
  } finally {
    db.close();
  }
});

test("Recipient-level suppression prevents drafts", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-6", {
      email: "suppressed@example.test",
    });

    db.prepare(
      `
      INSERT INTO recipient_suppressions (
        company_id,
        email,
        created_at
      )
      VALUES (?, ?, ?)
    `,
    ).run("company-a", "suppressed@example.test", DUE);

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.draftsPrepared, 0);
    assert.equal(result.skipped.optedOut, 1);

    assert.equal(count(db, "outbound_messages"), 0);
    assert.equal(count(db, "unsubscribe_tokens"), 0);
  } finally {
    db.close();
  }
});

test("Accepted quotes do not generate drafts", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-7", {
      email: "accepted@example.test",
      status: "Accepted",
    });

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.detected, 0);
    assert.equal(result.draftsPrepared, 0);

    assert.equal(count(db, "outbound_messages"), 0);
    assert.equal(count(db, "unsubscribe_tokens"), 0);
  } finally {
    db.close();
  }
});

test("Future reminders are not processed early", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-8", {
      email: "future@example.test",
      scheduledAt: FUTURE,
    });

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.detected, 0);
    assert.equal(result.recorded, 0);
    assert.equal(result.draftsPrepared, 0);

    assert.equal(count(db, "outbound_messages"), 0);
    assert.equal(count(db, "unsubscribe_tokens"), 0);
  } finally {
    db.close();
  }
});

test("Rescheduling cancels the old draft", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-9", {
      email: "reschedule@example.test",
    });

    processDueFollowUps(db, NOW);

    db.prepare(
      `
      UPDATE follow_ups
      SET scheduled_at = ?
      WHERE quote_id = ?
    `,
    ).run(FUTURE, "QT-TEST-9");

    const activeDrafts = count(db, "outbound_messages", "status = 'draft'");

    const cancelledDrafts = count(
      db,
      "outbound_messages",
      "status = 'cancelled'",
    );

    assert.equal(activeDrafts, 0);
    assert.equal(cancelledDrafts, 1);

    const result = processDueFollowUps(db, NOW);

    assert.equal(result.draftsPrepared, 0);
    assert.equal(count(db, "unsubscribe_tokens"), 1);
  } finally {
    db.close();
  }
});

test("Dry-run does not write to the database", () => {
  const db = createDatabase();

  try {
    addQuote(db, "QT-TEST-10", {
      email: "dryrun@example.test",
    });

    const result = processDueFollowUps(db, NOW, true);

    assert.equal(result.detected, 1);
    assert.equal(result.eligibleDrafts, 1);
    assert.equal(result.recorded, 0);
    assert.equal(result.draftsPrepared, 0);
    assert.equal(result.emailsSent, 0);

    assert.equal(count(db, "followup_due_events"), 0);
    assert.equal(count(db, "outbound_messages"), 0);
    assert.equal(count(db, "activity_logs"), 0);
    assert.equal(count(db, "unsubscribe_tokens"), 0);
  } finally {
    db.close();
  }
});
