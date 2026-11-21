import { randomUUID } from "node:crypto";
import { getDeliveryReadiness } from "./deliveryReadiness.js";

export function runDeliveryQueueAction(
  db,
  {
    companyId,
    queueId,
    action,
    actorId = null,
    currentTime = new Date().toISOString(),
  },
) {
  if (!["approve", "simulate"].includes(action)) {
    throw new Error("Unsupported delivery queue action");
  }

  const timestamp = new Date(currentTime);

  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Invalid processing time");
  }

  const now = timestamp.toISOString();

  const findEntry = db.prepare(`
    SELECT
      dq.id,
      dq.message_id AS messageId,
      dq.status,
      dq.created_at AS createdAt,
      dq.updated_at AS updatedAt,
      dq.approved_at AS approvedAt,
      dq.created_by AS createdBy,
      dq.approved_by AS approvedBy,
      dq.simulated_by AS simulatedBy,
      dq.cancelled_by AS cancelledBy,
      dq.cancel_reason AS cancelReason,
      m.quote_id AS quoteId,
      m.status AS draftStatus,
      m.recipient_email AS recipientEmail
    FROM delivery_queue dq
    JOIN outbound_messages m
      ON m.id = dq.message_id
    JOIN quotes q
      ON q.id = m.quote_id
    WHERE dq.id = ?
      AND q.company_id = ?
  `);

  const approve = db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'approved',
      updated_at = ?,
      approved_at = ?,
      approved_by = ?
    WHERE id = ?
      AND status = 'pending_review'
  `);

  const simulate = db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'simulated',
      updated_at = ?,
      simulated_by = ?
    WHERE id = ?
      AND status = 'approved'
  `);

  const insertAttempt = db.prepare(`
    INSERT INTO delivery_attempts (
      id,
      queue_id,
      result,
      description,
      created_at
    )
    VALUES (?, ?, 'simulated', ?, ?)
  `);

  const countAttempts = db.prepare(`
    SELECT COUNT(*) AS total
    FROM delivery_attempts
    WHERE queue_id = ?
  `);

  function failure(statusCode, error) {
    return {
      success: false,
      statusCode,
      error,
    };
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    const entry = findEntry.get(queueId, companyId);

    let result;

    if (!entry) {
      result = failure(404, "Queue entry not found");
    } else if (action === "approve" && entry.status !== "pending_review") {
      result = failure(409, "Queue entry is not awaiting review");
    } else if (action === "simulate" && entry.status !== "approved") {
      result = failure(409, "Queue entry must be approved first");
    } else if (entry.draftStatus !== "draft") {
      result = failure(409, "Associated draft is no longer active");
    } else {
      const readiness = getDeliveryReadiness(db, companyId, entry.quoteId, now);

      if (
        !readiness ||
        readiness.status !== "needs_review" ||
        readiness.draftId !== entry.messageId
      ) {
        result = failure(409, "Draft is not currently eligible");
      } else if (action === "approve") {
        const updated = approve.run(now, now, actorId, entry.id);

        if (updated.changes !== 1) {
          throw new Error("Queue approval failed");
        }

        result = {
          success: true,
          statusCode: 200,
          message: "Draft approved for simulated processing only",
          data: findEntry.get(entry.id, companyId),
          emailsSent: 0,
        };
      } else if (countAttempts.get(entry.id).total > 0) {
        result = failure(409, "Processing attempt already exists");
      } else {
        const updated = simulate.run(now, actorId, entry.id);

        if (updated.changes !== 1) {
          throw new Error("Queue simulation failed");
        }

        insertAttempt.run(
          randomUUID(),
          entry.id,
          "Simulated processing completed. No provider contacted and no email sent.",
          now,
        );

        result = {
          success: true,
          statusCode: 200,
          message: "Simulation recorded. No email sent.",
          data: findEntry.get(entry.id, companyId),
          emailsSent: 0,
        };
      }
    }

    db.exec("COMMIT");

    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
