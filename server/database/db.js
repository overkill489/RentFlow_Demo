import { openRentFlowDatabase } from "./openDatabase.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quotes as initialQuotes } from "../data/quotes.js";
import { installDeliveryQueueAudit } from "../services/deliveryQueueAudit.js";
import { installUnsubscribeSchema } from "../services/unsubscribeService.js";
import { installSenderIdentitySchema } from "../services/senderIdentity.js";
import { installSenderVerificationSchema } from "../services/senderVerification.js";
import { installDeliveryPreflightAuditSchema } from "../services/deliveryPreflightAudit.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const storageDirectory = join(currentDirectory, "../storage");

const databasePath = join(storageDirectory, "rentflow.db");

export const db = openRentFlowDatabase(databasePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    equipment TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending'
      CHECK (
        status IN (
          'Pending',
          'Follow-up Due',
          'Follow-up Scheduled',
          'Accepted'
        )
      )
  )
`);

const existingCount = db.prepare("SELECT COUNT(*) AS total FROM quotes").get();

if (existingCount.total === 0) {
  const insertQuote = db.prepare(`
    INSERT INTO quotes (
      id,
      customer,
      equipment,
      amount,
      date,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN TRANSACTION");

  try {
    for (const quote of initialQuotes) {
      insertQuote.run(
        quote.id,
        quote.customer,
        quote.equipment,
        quote.amount,
        quote.date,
        quote.status,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL,
    FOREIGN KEY (company_id)
      REFERENCES companies(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_users_company
  ON users(company_id);
`);

const quoteColumns = db.prepare("PRAGMA table_info(quotes)").all();

const hasCompanyId = quoteColumns.some(
  (column) => column.name === "company_id",
);

if (!hasCompanyId) {
  db.exec(`
    ALTER TABLE quotes
    ADD COLUMN company_id TEXT
      REFERENCES companies(id)
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_quotes_company
  ON quotes(company_id);

  CREATE INDEX IF NOT EXISTS idx_quotes_company_status
  ON quotes(company_id, status);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at TEXT NOT NULL,
    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expiry
  ON revoked_tokens(expires_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS followup_due_events (
    quote_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    PRIMARY KEY (quote_id, scheduled_at),
    FOREIGN KEY (quote_id)
      REFERENCES quotes(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_followup_due_events_quote
  ON followup_due_events(quote_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS quote_contacts (
    quote_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    opted_out INTEGER NOT NULL DEFAULT 0
      CHECK (opted_out IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (quote_id)
      REFERENCES quotes(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS outbound_messages (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'cancelled')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (quote_id)
      REFERENCES quotes(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_outbound_messages_quote
  ON outbound_messages(quote_id, created_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recipient_suppressions (
    company_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (company_id, email),
    FOREIGN KEY (company_id)
      REFERENCES companies(id)
      ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_queue (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending_review'
      CHECK (
        status IN (
          'pending_review',
          'approved',
          'simulated',
          'cancelled'
        )
      ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_at TEXT,
    FOREIGN KEY (message_id)
      REFERENCES outbound_messages(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL,
    result TEXT NOT NULL
      CHECK (result = 'simulated'),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (queue_id)
      REFERENCES delivery_queue(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_queue_status
  ON delivery_queue(status);

  CREATE INDEX IF NOT EXISTS idx_delivery_attempts_queue
  ON delivery_attempts(queue_id, created_at);
`);

installDeliveryQueueAudit(db);
installSenderIdentitySchema(db);
installSenderVerificationSchema(db);
installDeliveryPreflightAuditSchema(db);
installUnsubscribeSchema(db);
