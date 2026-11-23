import { getDeliveryReadiness } from "./deliveryReadiness.js";

export function recoverDeliveryQueue(
  db,
  {
    dryRun = false,
    currentTime = new Date().toISOString(),
    includeEntries = true,
  } = {},
) {
  const parsedTime = new Date(currentTime);

  if (!Number.isFinite(parsedTime.getTime())) {
    throw new Error("Invalid recovery time");
  }

  const now = parsedTime.toISOString();

  const findActiveEntries = db.prepare(`
    SELECT
      dq.id AS queueId,
      dq.message_id AS messageId,
      dq.status AS queueStatus,
      m.quote_id AS quoteId,
      m.status AS draftStatus,
      q.company_id AS companyId
    FROM delivery_queue dq
    LEFT JOIN outbound_messages m
      ON m.id = dq.message_id
    LEFT JOIN quotes q
      ON q.id = m.quote_id
    WHERE dq.status IN (
      'pending_review',
      'approved'
    )
    ORDER BY dq.created_at, dq.id
  `);

  const cancelEntry = db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'cancelled',
      updated_at = ?
    WHERE id = ?
      AND status IN (
        'pending_review',
        'approved'
      )
  `);

  const cancelDraft = db.prepare(`
    UPDATE outbound_messages
    SET status = 'cancelled'
    WHERE id = ?
      AND status = 'draft'
  `);

  function inspect(entry) {
    if (!entry.messageId || !entry.quoteId || !entry.companyId) {
      return {
        action: "cancel",
        reason: "MISSING_OWNERSHIP_DATA",
      };
    }

    if (entry.draftStatus !== "draft") {
      return {
        action: "cancel",
        reason: "INACTIVE_DRAFT",
      };
    }

    const readiness = getDeliveryReadiness(
      db,
      entry.companyId,
      entry.quoteId,
      now,
    );

    if (!readiness || readiness.draftId !== entry.messageId) {
      return {
        action: "cancel",
        reason: "DRAFT_MISMATCH",
      };
    }

    if (readiness.status === "blocked") {
      return {
        action: "cancel",
        reason: readiness.reasons[0] ?? "READINESS_BLOCKED",
      };
    }

    if (
      entry.queueStatus === "approved" &&
      readiness.status !== "needs_review"
    ) {
      return {
        action: "cancel",
        reason: "APPROVAL_NO_LONGER_VALID",
      };
    }

    return {
      action: "keep",
      reason:
        readiness.status === "scheduled"
          ? "AWAITING_DUE_TIME"
          : "READY_FOR_REVIEW",
    };
  }

  function performRecovery(allowWrites) {
    const entries = findActiveEntries.all();
    const result = {
      mode: dryRun ? "dry-run" : "recovery",
      processingTime: now,
      scanned: entries.length,
      healthy: 0,
      cancelled: 0,
      draftsCancelled: 0,
      emailsSent: 0,
      ...(includeEntries ? { entries: [] } : {}),
    };

    for (const entry of entries) {
      const decision = inspect(entry);

      if (decision.action === "keep") {
        result.healthy += 1;
      } else if (!dryRun) {
        if (!allowWrites) {
          return null;
        }

        const update = cancelEntry.run(now, entry.queueId);

        if (update.changes === 1) {
          result.cancelled += 1;

          if (entry.messageId && entry.draftStatus === "draft") {
            const draftUpdate = cancelDraft.run(entry.messageId);

            result.draftsCancelled += draftUpdate.changes;
          }
        }
      }

      result.entries?.push({
        queueId: entry.queueId,
        quoteId: entry.quoteId,
        previousStatus: entry.queueStatus,
        decision: decision.action,
        reason: decision.reason,
      });
    }

    return result;
  }

  function recoverInTransaction(allowWrites) {
    db.exec(allowWrites ? "BEGIN IMMEDIATE" : "BEGIN");

    try {
      const result = performRecovery(allowWrites);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  if (dryRun) {
    return performRecovery(false);
  }

  // End the read snapshot before taking the writer lock and rechecking current state.
  return recoverInTransaction(false) ?? recoverInTransaction(true);
}
