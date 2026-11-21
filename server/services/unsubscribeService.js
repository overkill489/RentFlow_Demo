import { createHash, randomBytes } from "node:crypto";

const TOKEN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function parseTime(value) {
  const time = new Date(value);

  if (!Number.isFinite(time.getTime())) {
    throw new Error("Invalid processing time");
  }

  return time;
}

export function installUnsubscribeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
      token_hash TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      quote_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (company_id)
        REFERENCES companies(id),
      FOREIGN KEY (quote_id)
        REFERENCES quotes(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_quote
    ON unsubscribe_tokens(quote_id);
  `);
}

export function createUnsubscribeToken(
  db,
  { companyId, quoteId, currentTime = new Date().toISOString() },
) {
  const now = parseTime(currentTime);

  const contact = db
    .prepare(
      `
    SELECT c.email
    FROM quote_contacts c
    JOIN quotes q ON q.id = c.quote_id
    WHERE c.quote_id = ?
      AND q.company_id = ?
  `,
    )
    .get(quoteId, companyId);

  if (!contact) {
    return null;
  }

  const email = normalizeEmail(contact.email);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TOKEN_DURATION_MS).toISOString();

  db.prepare(
    `
    INSERT INTO unsubscribe_tokens (
      token_hash,
      company_id,
      quote_id,
      email,
      created_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(tokenHash, companyId, quoteId, email, createdAt, expiresAt);

  return {
    token,
    expiresAt,
  };
}

export function inspectUnsubscribeToken(
  db,
  token,
  currentTime = new Date().toISOString(),
) {
  const now = parseTime(currentTime);

  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return {
      valid: false,
      reason: "INVALID_TOKEN",
    };
  }

  const record = db
    .prepare(
      `
    SELECT
      t.company_id AS companyId,
      t.quote_id AS quoteId,
      t.email,
      t.expires_at AS expiresAt,
      t.used_at AS usedAt,
      c.email AS currentEmail,
      q.company_id AS currentCompanyId
    FROM unsubscribe_tokens t
    LEFT JOIN quotes q ON q.id = t.quote_id
    LEFT JOIN quote_contacts c ON c.quote_id = t.quote_id
    WHERE t.token_hash = ?
  `,
    )
    .get(hashToken(token));

  if (!record) {
    return {
      valid: false,
      reason: "INVALID_TOKEN",
    };
  }

  if (record.usedAt) {
    return {
      valid: false,
      reason: "ALREADY_USED",
    };
  }

  if (new Date(record.expiresAt).getTime() <= now.getTime()) {
    return {
      valid: false,
      reason: "EXPIRED_TOKEN",
    };
  }

  if (
    record.currentCompanyId !== record.companyId ||
    !record.currentEmail ||
    normalizeEmail(record.currentEmail) !== record.email
  ) {
    return {
      valid: false,
      reason: "CONTACT_CHANGED",
    };
  }

  return {
    valid: true,
    companyId: record.companyId,
    quoteId: record.quoteId,
    email: record.email,
    expiresAt: record.expiresAt,
  };
}

export function confirmUnsubscribe(
  db,
  token,
  currentTime = new Date().toISOString(),
) {
  const now = parseTime(currentTime);

  db.exec("BEGIN IMMEDIATE");

  try {
    const inspection = inspectUnsubscribeToken(db, token, now.toISOString());

    if (!inspection.valid) {
      db.exec("COMMIT");

      return {
        success: false,
        reason: inspection.reason,
      };
    }

    const nowIso = now.toISOString();

    const update = db
      .prepare(
        `
      UPDATE unsubscribe_tokens
      SET used_at = ?
      WHERE token_hash = ?
        AND used_at IS NULL
    `,
      )
      .run(nowIso, hashToken(token));

    if (update.changes !== 1) {
      throw new Error("Token could not be consumed");
    }

    db.prepare(
      `
      INSERT OR IGNORE INTO recipient_suppressions (
        company_id,
        email,
        created_at
      )
      VALUES (?, ?, ?)
    `,
    ).run(inspection.companyId, inspection.email, nowIso);

    db.prepare(
      `
      UPDATE quote_contacts
      SET
        opted_out = 1,
        updated_at = ?
      WHERE quote_id IN (
        SELECT q.id
        FROM quotes q
        JOIN quote_contacts c
          ON c.quote_id = q.id
        WHERE q.company_id = ?
          AND LOWER(TRIM(c.email)) = ?
      )
        AND opted_out = 0
    `,
    ).run(nowIso, inspection.companyId, inspection.email);

    db.prepare(
      `
      UPDATE outbound_messages
      SET status = 'cancelled'
      WHERE status = 'draft'
        AND quote_id IN (
          SELECT id
          FROM quotes
          WHERE company_id = ?
        )
        AND LOWER(TRIM(recipient_email)) = ?
    `,
    ).run(inspection.companyId, inspection.email);

    db.prepare(
      `
      UPDATE delivery_queue
      SET
        status = 'cancelled',
        updated_at = ?,
        cancelled_by = NULL,
        cancel_reason = 'RECIPIENT_UNSUBSCRIBED'
      WHERE status IN ('pending_review', 'approved')
        AND message_id IN (
          SELECT m.id
          FROM outbound_messages m
          JOIN quotes q ON q.id = m.quote_id
          WHERE q.company_id = ?
            AND LOWER(TRIM(m.recipient_email)) = ?
        )
    `,
    ).run(nowIso, inspection.companyId, inspection.email);

    db.exec("COMMIT");

    return {
      success: true,
      email: inspection.email,
      companyId: inspection.companyId,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
