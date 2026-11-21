import { randomUUID } from "node:crypto";
import { getDeliveryPreflight } from "./deliveryPreflight.js";

export function installDeliveryPreflightAuditSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_preflight_audit (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      actor_id TEXT,
      checked_at TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status = 'blocked'),
      technical_checks_passed INTEGER NOT NULL
        CHECK (technical_checks_passed IN (0, 1)),
      unsubscribe_valid INTEGER NOT NULL
        CHECK (unsubscribe_valid IN (0, 1)),
      provider_configuration_valid INTEGER NOT NULL
        CHECK (provider_configuration_valid IN (0, 1)),
      reasons_json TEXT NOT NULL,
      FOREIGN KEY (queue_id)
        REFERENCES delivery_queue(id)
        ON DELETE CASCADE,
      FOREIGN KEY (company_id)
        REFERENCES companies(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_preflight_audit_queue
    ON delivery_preflight_audit(
      queue_id,
      checked_at DESC
    );
  `);
}

function publicRecord(row) {
  return {
    id: row.id,
    queueId: row.queueId,
    checkedAt: row.checkedAt,
    status: row.status,
    actorId: row.actorId,
    technicalChecksPassed: Boolean(row.technicalChecksPassed),
    unsubscribeValid: Boolean(row.unsubscribeValid),
    providerConfigurationValid: Boolean(row.providerConfigurationValid),
    reasons: JSON.parse(row.reasonsJson),
    deliveryEnabled: false,
    emailsSent: 0,
  };
}

const selectFields = `
  id,
  queue_id AS queueId,
  actor_id AS actorId,
  checked_at AS checkedAt,
  status,
  technical_checks_passed AS technicalChecksPassed,
  unsubscribe_valid AS unsubscribeValid,
  provider_configuration_valid AS providerConfigurationValid,
  reasons_json AS reasonsJson
`;

export function recordDeliveryPreflight(
  db,
  {
    companyId,
    queueId,
    actorId = null,
    currentTime = new Date().toISOString(),
    providerConfig = {},
    evaluate = getDeliveryPreflight,
  },
) {
  const timestamp = new Date(currentTime);

  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Invalid preflight audit timestamp");
  }

  const now = timestamp.toISOString();

  db.exec("BEGIN IMMEDIATE");

  try {
    const result = evaluate(db, {
      companyId,
      queueId,
      currentTime: now,
      providerConfig,
    });

    if (!result) {
      db.exec("COMMIT");

      return null;
    }

    if (
      result.queueId !== queueId ||
      result.companyId !== companyId ||
      result.status !== "blocked" ||
      result.deliveryEnabled !== false ||
      !Array.isArray(result.reasons) ||
      !result.reasons.every((reason) => typeof reason === "string")
    ) {
      throw new Error("Invalid delivery preflight result");
    }

    const id = randomUUID();

    db.prepare(
      `
      INSERT INTO delivery_preflight_audit (
        id,
        queue_id,
        company_id,
        actor_id,
        checked_at,
        status,
        technical_checks_passed,
        unsubscribe_valid,
        provider_configuration_valid,
        reasons_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      queueId,
      companyId,
      actorId,
      now,
      "blocked",
      result.technicalChecksPassed ? 1 : 0,
      result.unsubscribeValid ? 1 : 0,
      result.providerConfigurationValid ? 1 : 0,
      JSON.stringify(result.reasons),
    );

    const row = db
      .prepare(
        `
      SELECT ${selectFields}
      FROM delivery_preflight_audit
      WHERE id = ?
    `,
      )
      .get(id);

    db.exec("COMMIT");

    return publicRecord(row);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getDeliveryPreflightHistory(
  db,
  { companyId, queueId, limit = 50 },
) {
  const ownedQueue = db
    .prepare(
      `
    SELECT dq.id
    FROM delivery_queue dq
    JOIN outbound_messages m
      ON m.id = dq.message_id
    JOIN quotes q
      ON q.id = m.quote_id
    WHERE dq.id = ?
      AND q.company_id = ?
  `,
    )
    .get(queueId, companyId);

  if (!ownedQueue) {
    return null;
  }

  const safeLimit = Number.isInteger(limit)
    ? Math.min(100, Math.max(1, limit))
    : 50;

  const rows = db
    .prepare(
      `
    SELECT ${selectFields}
    FROM delivery_preflight_audit
    WHERE queue_id = ?
      AND company_id = ?
    ORDER BY checked_at DESC, rowid DESC
    LIMIT ?
  `,
    )
    .all(queueId, companyId, safeLimit);

  return rows.map(publicRecord);
}
