import express from "express";
import { randomUUID } from "node:crypto";
import { db } from "../database/db.js";
import { getDeliveryReadiness } from "../services/deliveryReadiness.js";
import { runDeliveryQueueAction } from "../services/deliveryQueueLifecycle.js";

const router = express.Router();

db.exec(`
  CREATE TRIGGER IF NOT EXISTS cancel_queue_on_draft_cancel
  AFTER UPDATE OF status ON outbound_messages
  WHEN NEW.status = 'cancelled'
  BEGIN
    UPDATE delivery_queue
    SET status = 'cancelled',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE message_id = NEW.id
      AND status IN ('pending_review', 'approved');
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_queue_on_quote_accept
  AFTER UPDATE OF status ON quotes
  WHEN NEW.status = 'Accepted'
  BEGIN
    UPDATE delivery_queue
    SET status = 'cancelled',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('pending_review', 'approved')
      AND message_id IN (
        SELECT id FROM outbound_messages
        WHERE quote_id = NEW.id
      );
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_queue_on_followup_delete
  AFTER DELETE ON follow_ups
  BEGIN
    UPDATE delivery_queue
    SET status = 'cancelled',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('pending_review', 'approved')
      AND message_id IN (
        SELECT id FROM outbound_messages
        WHERE quote_id = OLD.quote_id
      );
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_queue_on_reschedule
  AFTER UPDATE OF scheduled_at ON follow_ups
  WHEN NEW.scheduled_at <> OLD.scheduled_at
  BEGIN
    UPDATE delivery_queue
    SET status = 'cancelled',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('pending_review', 'approved')
      AND message_id IN (
        SELECT id FROM outbound_messages
        WHERE quote_id = NEW.quote_id
      );
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_queue_on_contact_optout
  AFTER UPDATE OF opted_out ON quote_contacts
  WHEN NEW.opted_out = 1
  BEGIN
    UPDATE delivery_queue
    SET status = 'cancelled',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('pending_review', 'approved')
      AND message_id IN (
        SELECT id FROM outbound_messages
        WHERE quote_id = NEW.quote_id
      );
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_queue_on_recipient_suppression
  AFTER INSERT ON recipient_suppressions
  BEGIN
    UPDATE delivery_queue
    SET status = 'cancelled',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status IN ('pending_review', 'approved')
      AND message_id IN (
        SELECT m.id
        FROM outbound_messages m
        JOIN quotes q ON q.id = m.quote_id
        WHERE q.company_id = NEW.company_id
          AND LOWER(TRIM(m.recipient_email)) = NEW.email
      );
  END;
`);

const findQueueByMessage = db.prepare(`
  SELECT
    dq.id,
    dq.message_id AS messageId,
    m.quote_id AS quoteId,
    m.recipient_email AS recipientEmail,
    m.subject,
    dq.status,
    dq.created_at AS createdAt,
    dq.updated_at AS updatedAt,
    dq.approved_at AS approvedAt
  FROM delivery_queue dq
  JOIN outbound_messages m ON m.id = dq.message_id
  JOIN quotes q ON q.id = m.quote_id
  WHERE dq.message_id = ?
    AND q.company_id = ?
`);

const findQueueById = db.prepare(`
  SELECT
    dq.id,
    dq.message_id AS messageId,
    m.quote_id AS quoteId,
    m.recipient_email AS recipientEmail,
    m.subject,
    m.status AS draftStatus,
    dq.status,
    dq.created_at AS createdAt,
    dq.updated_at AS updatedAt,
    dq.approved_at AS approvedAt
  FROM delivery_queue dq
  JOIN outbound_messages m ON m.id = dq.message_id
  JOIN quotes q ON q.id = m.quote_id
  WHERE dq.id = ?
    AND q.company_id = ?
`);

const findAllQueue = db.prepare(`
  SELECT
    dq.id,
    dq.message_id AS messageId,
    m.quote_id AS quoteId,
    m.recipient_email AS recipientEmail,
    m.subject,
    dq.status,
    dq.created_at AS createdAt,
    dq.updated_at AS updatedAt,
    dq.approved_at AS approvedAt
  FROM delivery_queue dq
  JOIN outbound_messages m ON m.id = dq.message_id
  JOIN quotes q ON q.id = m.quote_id
  WHERE q.company_id = ?
  ORDER BY dq.created_at DESC, dq.rowid DESC
`);

const insertQueue = db.prepare(`
  INSERT INTO delivery_queue (
    id,
    message_id,
    status,
    created_at,
    updated_at,
    created_by
  )
  VALUES (?, ?, 'pending_review', ?, ?, ?)
`);

const approveQueue = db.prepare(`
  UPDATE delivery_queue
  SET status = 'approved',
      updated_at = ?,
      approved_at = ?
  WHERE id = ?
    AND status = 'pending_review'
`);

const simulateQueue = db.prepare(`
  UPDATE delivery_queue
  SET status = 'simulated',
      updated_at = ?
  WHERE id = ?
    AND status = 'approved'
`);

const cancelQueue = db.prepare(`
  UPDATE delivery_queue
  SET status = 'cancelled',
      updated_at = ?,
      cancelled_by = ?,
      cancel_reason = 'MANUAL_CANCELLATION'
  WHERE id = ?
    AND status IN ('pending_review', 'approved')
`);

const cancelDraft = db.prepare(`
  UPDATE outbound_messages
  SET status = 'cancelled'
  WHERE id = ?
    AND status = 'draft'
`);

const insertAttempt = db.prepare(`
  INSERT INTO delivery_attempts (
    id, queue_id, result, description, created_at
  )
  VALUES (?, ?, 'simulated', ?, ?)
`);

const findAttempts = db.prepare(`
  SELECT
    id,
    queue_id AS queueId,
    result,
    description,
    created_at AS createdAt
  FROM delivery_attempts
  WHERE queue_id = ?
  ORDER BY created_at DESC, rowid DESC
`);

const findAuditEvents = db.prepare(`
  SELECT
    id,
    queue_id AS queueId,
    event_type AS eventType,
    previous_status AS previousStatus,
    new_status AS newStatus,
    actor_type AS actorType,
    actor_id AS actorId,
    reason,
    created_at AS createdAt
  FROM delivery_queue_audit
  WHERE queue_id = ?
  ORDER BY rowid ASC
`);

function transaction(action) {
  db.exec("BEGIN IMMEDIATE");

  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "Administrator access required",
    });
  }

  next();
}

function getActorId(req) {
  return req.user.id ?? req.user.userId ?? req.user.sub ?? null;
}

function readOwnedQueue(req, res) {
  const entry = findQueueById.get(req.params.id, req.user.companyId);

  if (!entry) {
    res.status(404).json({
      success: false,
      error: "Queue entry not found",
    });

    return null;
  }

  return entry;
}

router.get("/", (req, res) => {
  const data = findAllQueue.all(req.user.companyId);

  res.json({
    success: true,
    count: data.length,
    data,
  });
});

router.post("/quotes/:id", requireAdmin, (req, res, next) => {
  try {
    const result = transaction(() => {
      const readiness = getDeliveryReadiness(
        db,
        req.user.companyId,
        req.params.id,
      );

      if (!readiness) {
        return {
          statusCode: 404,
          error: "Quote not found",
        };
      }

      if (readiness.status === "blocked") {
        return {
          statusCode: 409,
          error: "Draft is not eligible for the queue",
          reasons: readiness.reasons,
        };
      }

      const existing = findQueueByMessage.get(
        readiness.draftId,
        req.user.companyId,
      );

      if (existing) {
        return {
          statusCode: 200,
          data: existing,
          message: "Existing queue entry returned",
        };
      }

      const now = new Date().toISOString();
      const id = randomUUID();

      insertQueue.run(id, readiness.draftId, now, now, getActorId(req));

      return {
        statusCode: 201,
        data: findQueueById.get(id, req.user.companyId),
        message: "Draft added to delivery review queue",
      };
    });

    if (result.error) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
        reasons: result.reasons ?? [],
      });
    }

    res.status(result.statusCode).json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/audit", requireAdmin, (req, res) => {
  const entry = readOwnedQueue(req, res);

  if (!entry) return;

  const data = findAuditEvents.all(entry.id);

  res.json({
    success: true,
    count: data.length,
    data,
  });
});

router.get("/:id/attempts", (req, res) => {
  const entry = readOwnedQueue(req, res);

  if (!entry) return;

  const data = findAttempts.all(entry.id);

  res.json({
    success: true,
    count: data.length,
    data,
  });
});

router.post("/:id/approve", requireAdmin, (req, res, next) => {
  try {
    const result = runDeliveryQueueAction(db, {
      companyId: req.user.companyId,
      queueId: req.params.id,
      action: "approve",
      actorId: getActorId(req),
    });

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    res.status(result.statusCode).json({
      success: true,
      message: result.message,
      data: result.data,
      emailsSent: result.emailsSent,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/simulate", requireAdmin, (req, res, next) => {
  try {
    const result = runDeliveryQueueAction(db, {
      companyId: req.user.companyId,
      queueId: req.params.id,
      action: "simulate",
      actorId: getActorId(req),
    });

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    res.status(result.statusCode).json({
      success: true,
      message: result.message,
      data: result.data,
      emailsSent: result.emailsSent,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/cancel", requireAdmin, (req, res, next) => {
  try {
    const result = transaction(() => {
      const entry = findQueueById.get(req.params.id, req.user.companyId);

      if (!entry) {
        return {
          statusCode: 404,
          error: "Queue entry not found",
        };
      }

      if (entry.status !== "pending_review" && entry.status !== "approved") {
        return {
          statusCode: 409,
          error: "Queue entry cannot be cancelled in its current state",
        };
      }

      const now = new Date().toISOString();

      cancelQueue.run(now, getActorId(req), entry.id);
      cancelDraft.run(entry.messageId);

      return {
        statusCode: 200,
        data: findQueueById.get(entry.id, req.user.companyId),
      };
    });

    if (result.error) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      message: "Queue entry and active draft cancelled",
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
