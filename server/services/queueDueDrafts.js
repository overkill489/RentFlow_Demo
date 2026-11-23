import { randomUUID } from "node:crypto";
import { getDeliveryReadiness } from "./deliveryReadiness.js";
import { forEachWorkerBatch } from "./workerBatches.js";

export function queueDueDrafts(
  db,
  { currentTime = new Date().toISOString(), dryRun = false } = {},
) {
  return createQueuePass(db, currentTime).run(dryRun);
}

export function queueDueDraftsInBatches(db, { currentTime = new Date().toISOString() } = {}) {
  return createQueuePass(db, currentTime).runBatched();
}

function createQueuePass(db, currentTime) {
  const timestamp = new Date(currentTime);

  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Invalid processing time");
  }

  const now = timestamp.toISOString();

  const findCandidatesSql = (source) => `
    SELECT
      m.id AS messageId,
      m.quote_id AS quoteId,
      q.company_id AS companyId
    FROM ${source}
    JOIN quotes q ON q.id = m.quote_id
    JOIN follow_ups f ON f.quote_id = q.id
    WHERE m.status = 'draft'
      AND q.status = 'Follow-up Scheduled'
      AND q.company_id IS NOT NULL
      AND f.scheduled_at <= ?
    ORDER BY f.scheduled_at, m.id
  `;
  const findCandidates = db.prepare(findCandidatesSql("outbound_messages m"));

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

  function createResult(dryRun) {
    return {
      mode: dryRun ? "dry-run" : "process", processingTime: now,
      scanned: 0, eligible: 0, queued: 0, alreadyQueued: 0, blocked: 0, emailsSent: 0,
    };
  }

  function processCandidates(candidates, result, { dryRun = false, pending } = {}) {
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
        result.scanned += 1;
        result.blocked += 1;
        continue;
      }

      const existing = findExisting.get(candidate.messageId);
      if (pending && !existing) {
        pending.push(candidate.messageId);
        continue;
      }
      result.scanned += 1;
      result.eligible += 1;

      if (existing) {
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

  function runTransaction(begin, callback) {
    db.exec(begin);
    try {
      callback();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function run(dryRun) {
    const result = createResult(dryRun);
    const process = () => processCandidates(findCandidates.all(now), result, { dryRun });
    if (dryRun) process();
    else runTransaction("BEGIN IMMEDIATE", process);
    return result;
  }

  async function runBatched() {
    const result = createResult(false);
    const pending = [];
    runTransaction("BEGIN", () => processCandidates(findCandidates.all(now), result, { pending }));
    const findBatch = db.prepare(findCandidatesSql(
      "json_each(?) batch CROSS JOIN outbound_messages m ON m.id = batch.value",
    ));
    await forEachWorkerBatch(pending, (ids) => {
      runTransaction("BEGIN IMMEDIATE", () => {
        processCandidates(findBatch.all(JSON.stringify(ids), now), result);
      });
    });
    return result;
  }

  return { run, runBatched };
}
