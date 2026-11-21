import { randomUUID } from "node:crypto";
import { getDeliveryReadiness } from "./deliveryReadiness.js";

export function queueDueDrafts(
  db,
  { currentTime = new Date().toISOString(), dryRun = false } = {},
) {
  const timestamp = new Date(currentTime);

  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Invalid processing time");
  }

  const now = timestamp.toISOString();

  const findCandidates = db.prepare(`
    SELECT
      m.id AS messageId,
      m.quote_id AS quoteId,
      q.company_id AS companyId
    FROM outbound_messages m
    JOIN quotes q ON q.id = m.quote_id
    JOIN follow_ups f ON f.quote_id = q.id
    WHERE m.status = 'draft'
      AND q.status = 'Follow-up Scheduled'
      AND q.company_id IS NOT NULL
      AND f.scheduled_at <= ?
    ORDER BY f.scheduled_at, m.id
  `);

  const findExisting = db.prepare(`
    SELECT id
    FROM delivery_queue
    WHERE message_id = ?
  `);

  const insertQueue = db.prepare(`
    INSERT OR IGNORE INTO delivery_queue (
      id,
      message_id,
      status,
      created_at,
      updated_at,
      created_by
    )
    VALUES (?, ?, 'pending_review', ?, ?, NULL)
  `);

  const attributeSystemAudit = db.prepare(`
    UPDATE delivery_queue_audit
    SET
      actor_type = 'system',
      actor_id = NULL,
      reason = 'AUTOMATIC_DUE_DRAFT'
    WHERE queue_id = ?
      AND event_type = 'queued'
      AND previous_status IS NULL
  `);

  const result = {
    mode: dryRun ? "dry-run" : "process",
    processingTime: now,
    scanned: 0,
    eligible: 0,
    queued: 0,
    alreadyQueued: 0,
    blocked: 0,
    emailsSent: 0,
  };

  function processCandidates() {
    const candidates = findCandidates.all(now);

    result.scanned = candidates.length;

    for (const candidate of candidates) {
      const readiness = getDeliveryReadiness(
        db,
        candidate.companyId,
        candidate.quoteId,
        now,
      );

      if (
        !readiness ||
        readiness.status !== "needs_review" ||
        readiness.draftId !== candidate.messageId
      ) {
        result.blocked += 1;
        continue;
      }

      result.eligible += 1;

      if (findExisting.get(candidate.messageId)) {
        result.alreadyQueued += 1;
        continue;
      }

      if (dryRun) {
        result.queued += 1;
        continue;
      }

      const id = randomUUID();

      const inserted = insertQueue.run(id, candidate.messageId, now, now);

      if (inserted.changes === 1) {
        attributeSystemAudit.run(id);
        result.queued += 1;
      } else {
        result.alreadyQueued += 1;
      }
    }
  }

  if (dryRun) {
    processCandidates();
    return result;
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    processCandidates();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
