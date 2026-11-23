import { immediateTransaction } from "./immediateTransaction.js";

const VERSION = 2;

const ATTEMPTS_V2 = `
  CREATE TABLE email_delivery_attempts (
    delivery_id INTEGER NOT NULL REFERENCES email_deliveries(id),
    number INTEGER NOT NULL CHECK (number > 0),
    claimed_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT CHECK (outcome IN ('accepted', 'rejected', 'ambiguous')),
    error_code TEXT,
    CHECK ((finished_at IS NULL) = (outcome IS NULL)),
    CHECK (CASE coalesce(outcome, '')
      WHEN 'rejected' THEN coalesce(error_code, '') IN ('RATE_LIMITED', 'PROVIDER_REJECTED')
      WHEN 'ambiguous' THEN coalesce(error_code, '') IN ('TIMEOUT', 'UNCONFIRMED_RESPONSE', 'IDEMPOTENCY_CONFLICT')
      ELSE error_code IS NULL END),
    PRIMARY KEY (delivery_id, number)
  ) STRICT;
`;

function upgradeAttempts(db) {
  db.exec(`
    ALTER TABLE email_delivery_attempts RENAME TO email_delivery_attempts_v1;
    ${ATTEMPTS_V2}
    INSERT INTO email_delivery_attempts (delivery_id, number, claimed_at, finished_at, outcome, error_code)
      SELECT delivery_id, number, claimed_at, finished_at, outcome, error_code
      FROM email_delivery_attempts_v1;
    DROP TABLE email_delivery_attempts_v1;
    CREATE UNIQUE INDEX email_delivery_one_open_attempt
      ON email_delivery_attempts(delivery_id) WHERE finished_at IS NULL;
  `);
}

// Explicit installer. Importing this module never opens or changes a database.
export function migrateEmailDeliveryLedger(db) {
  if (db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
    throw new Error("Email delivery migration requires foreign keys");
  }

  return immediateTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_delivery_schema (
        version INTEGER PRIMARY KEY
      ) STRICT;
    `);
    const installed = db.prepare("SELECT MAX(version) AS version FROM email_delivery_schema").get().version;
    if (installed === VERSION) return { version: VERSION, applied: false };
    if (installed === 1) {
      upgradeAttempts(db);
      db.prepare("INSERT INTO email_delivery_schema (version) VALUES (?)").run(VERSION);
      return { version: VERSION, applied: true };
    }
    if (installed !== null) throw new Error("Unsupported email delivery schema version");

    // Require the existing ownership and suppression schema before creating the ledger.
    db.prepare(`
      SELECT c.id, q.company_id, m.recipient_email, dq.message_id, s.created_at
      FROM companies c JOIN quotes q ON q.company_id = c.id
      JOIN outbound_messages m ON m.quote_id = q.id JOIN delivery_queue dq ON dq.message_id = m.id
      LEFT JOIN recipient_suppressions s ON s.company_id = c.id AND s.email = m.recipient_email
      LIMIT 0
    `).all();
    db.exec(`
      CREATE TABLE email_deliveries (
        id INTEGER PRIMARY KEY,
        company_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254),
        provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
        provider_account TEXT NOT NULL CHECK (length(provider_account) BETWEEN 1 AND 64),
        provider_message_id TEXT CHECK (length(provider_message_id) BETWEEN 1 AND 128),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        state TEXT NOT NULL CHECK (state IN (
          'claimed', 'accepted', 'rejected', 'ambiguous', 'bounced', 'complained', 'cancelled'
        )),
        updated_at TEXT NOT NULL,
        UNIQUE (provider, provider_account, idempotency_key),
        UNIQUE (provider, provider_account, provider_message_id),
        CHECK ((state IN ('accepted', 'bounced', 'complained')) = (provider_message_id IS NOT NULL))
      ) STRICT;

      CREATE INDEX email_deliveries_company_state ON email_deliveries(company_id, state, updated_at);

      -- Validate the ownership snapshot on insertion without retaining a blocking FK to a draft.
      CREATE TRIGGER email_delivery_check_owner BEFORE INSERT ON email_deliveries
      WHEN NOT EXISTS (
        SELECT 1 FROM outbound_messages m JOIN quotes q ON q.id = m.quote_id
        JOIN companies c ON c.id = q.company_id
        WHERE m.id = NEW.message_id AND c.id = NEW.company_id
          AND lower(trim(m.recipient_email)) = NEW.recipient
      )
      BEGIN
        SELECT RAISE(ABORT, 'Email delivery ownership mismatch');
      END;

      ${ATTEMPTS_V2}
      CREATE UNIQUE INDEX email_delivery_one_open_attempt
        ON email_delivery_attempts(delivery_id) WHERE finished_at IS NULL;

      CREATE TABLE email_delivery_events (
        provider TEXT NOT NULL,
        provider_account TEXT NOT NULL,
        event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
        delivery_id INTEGER NOT NULL REFERENCES email_deliveries(id),
        type TEXT NOT NULL CHECK (type IN ('delivered', 'soft_bounce', 'hard_bounce', 'complaint')),
        body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
        received_at TEXT NOT NULL,
        PRIMARY KEY (provider, provider_account, event_id)
      ) STRICT;
    `);
    db.prepare("INSERT INTO email_delivery_schema (version) VALUES (?)").run(VERSION);
    return { version: VERSION, applied: true };
  });
}
