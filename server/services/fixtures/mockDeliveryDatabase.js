import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateEmailDeliveryLedger } from "../../database/emailDeliveryMigration.js";
import { installSenderIdentitySchema, saveSenderIdentity } from "../senderIdentity.js";
import {
  installSenderVerificationSchema,
  prepareSenderDomainVerification,
} from "../senderVerification.js";
import { createUnsubscribeToken, installUnsubscribeSchema } from "../unsubscribeService.js";

export const DUE = "2026-11-23T12:00:00.000Z";
export const NOW = "2026-11-23T12:01:00Z";
export const RECIPIENT = "shared@example.test";

export function senderDomain(tenant) {
  return `sender-${tenant}.rentflow.invalid-domain.com`;
}

export function deliveryOptions(companyId = "a", queueId = `queue-${companyId}`) {
  return {
    mode: "mock",
    companyId,
    queueId,
    currentTime: NOW,
    providerConfig: { provider: "resend", fromEmail: `quotes@${senderDomain(companyId)}` },
  };
}

export function setup(db, { migrate = true } = {}) {
  db.exec(`
    CREATE TABLE companies (id TEXT PRIMARY KEY);
    CREATE TABLE quotes (id TEXT PRIMARY KEY, company_id TEXT, customer TEXT, equipment TEXT, status TEXT);
    CREATE TABLE follow_ups (quote_id TEXT PRIMARY KEY, scheduled_at TEXT);
    CREATE TABLE quote_contacts (quote_id TEXT PRIMARY KEY, email TEXT, opted_out INTEGER);
    CREATE TABLE outbound_messages (id TEXT PRIMARY KEY, quote_id TEXT, recipient_email TEXT,
      subject TEXT, body TEXT, status TEXT, created_at TEXT);
    CREATE TABLE delivery_queue (id TEXT PRIMARY KEY, message_id TEXT UNIQUE, status TEXT);
    CREATE TABLE delivery_attempts (id TEXT PRIMARY KEY, queue_id TEXT, result TEXT CHECK (result = 'simulated'));
    CREATE TABLE recipient_suppressions (company_id TEXT REFERENCES companies(id), email TEXT,
      created_at TEXT, PRIMARY KEY (company_id, email));
  `);
  if (migrate) migrateEmailDeliveryLedger(db);
  installUnsubscribeSchema(db);
  installSenderIdentitySchema(db);
  installSenderVerificationSchema(db);

  for (const tenant of ["a", "b"]) {
    db.prepare("INSERT INTO companies VALUES (?)").run(tenant);
    assert.equal(saveSenderIdentity(db, tenant, {
      displayName: 'Equipment, "Rental"', replyToEmail: `office@${senderDomain(tenant)}`,
    }, DUE).success, true);
    assert.equal(prepareSenderDomainVerification(db, tenant, DUE).success, true);
    db.prepare(`
      UPDATE sender_domain_verifications SET verified_at = ?, last_checked_at = ?,
        last_check_result = 'TXT_MATCH' WHERE company_id = ?
    `).run(DUE, DUE, tenant);
  }
  for (const [id, tenant] of [["a", "a"], ["b", "b"], ["next", "a"]]) {
    db.prepare("INSERT INTO quotes VALUES (?, ?, 'Fictional customer', 'Lift', 'Follow-up Scheduled')").run(id, tenant);
    db.prepare("INSERT INTO follow_ups VALUES (?, ?)").run(id, DUE);
    db.prepare("INSERT INTO quote_contacts VALUES (?, ?, 0)").run(id, RECIPIENT);
    const { token } = createUnsubscribeToken(db, {
      companyId: tenant, quoteId: id, email: RECIPIENT, currentTime: DUE,
    });
    db.prepare("INSERT INTO outbound_messages VALUES (?, ?, ?, 'Follow-up', ?, 'draft', ?)")
      .run(`message-${id}`, id, RECIPIENT, `https://staging.example.test/api/unsubscribe/${token}`, DUE);
    db.prepare("INSERT INTO delivery_queue VALUES (?, ?, 'approved')").run(`queue-${id}`, `message-${id}`);
  }
}

export function fixture(t, options) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  setup(db, options);
  return db;
}

