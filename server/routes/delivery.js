import express from "express";
import { randomUUID } from "node:crypto";
import { db } from "../database/db.js";
import { createUnsubscribeToken } from "../services/unsubscribeService.js";
import { createFollowUpEmailTemplate } from "../services/followUpEmailTemplate.js";

const router = express.Router();

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_active_draft
  ON outbound_messages(quote_id)
  WHERE status = 'draft'
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS suppress_recipient_drafts
  AFTER INSERT ON recipient_suppressions
  BEGIN
    UPDATE quote_contacts
    SET
      opted_out = 1,
      updated_at = NEW.created_at
    WHERE LOWER(TRIM(email)) = NEW.email
      AND quote_id IN (
        SELECT id
        FROM quotes
        WHERE company_id = NEW.company_id
      )
      AND opted_out = 0;

    UPDATE outbound_messages
    SET status = 'cancelled'
    WHERE status = 'draft'
      AND quote_id IN (
        SELECT id
        FROM quotes
        WHERE company_id = NEW.company_id
      )
      AND LOWER(TRIM(recipient_email)) = NEW.email;
  END;
`);

db.exec(`
  INSERT OR IGNORE INTO recipient_suppressions (
    company_id,
    email,
    created_at
  )
  SELECT
    q.company_id,
    LOWER(TRIM(c.email)),
    MIN(c.updated_at)
  FROM quote_contacts c
  JOIN quotes q ON q.id = c.quote_id
  WHERE c.opted_out = 1
    AND q.company_id IS NOT NULL
  GROUP BY q.company_id, LOWER(TRIM(c.email))
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS cancel_draft_on_reschedule
  AFTER UPDATE OF scheduled_at ON follow_ups
  WHEN OLD.scheduled_at <> NEW.scheduled_at
  BEGIN
    UPDATE outbound_messages
    SET status = 'cancelled'
    WHERE quote_id = NEW.quote_id
      AND status = 'draft';
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_draft_on_followup_delete
  AFTER DELETE ON follow_ups
  BEGIN
    UPDATE outbound_messages
    SET status = 'cancelled'
    WHERE quote_id = OLD.quote_id
      AND status = 'draft';
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_draft_on_quote_accept
  AFTER UPDATE OF status ON quotes
  WHEN NEW.status = 'Accepted'
    AND OLD.status <> 'Accepted'
  BEGIN
    UPDATE outbound_messages
    SET status = 'cancelled'
    WHERE quote_id = NEW.id
      AND status = 'draft';
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_draft_on_contact_optout
  AFTER UPDATE OF opted_out ON quote_contacts
  WHEN NEW.opted_out = 1
    AND OLD.opted_out = 0
  BEGIN
    UPDATE outbound_messages
    SET status = 'cancelled'
    WHERE quote_id = NEW.quote_id
      AND status = 'draft';
  END;

  CREATE TRIGGER IF NOT EXISTS cancel_draft_on_email_change
  AFTER UPDATE OF email ON quote_contacts
  WHEN NEW.email <> OLD.email
  BEGIN
    UPDATE outbound_messages
    SET status = 'cancelled'
    WHERE quote_id = NEW.quote_id
      AND status = 'draft';
  END;
`);

const findQuote = db.prepare(`
  SELECT id, customer, equipment, amount, status
  FROM quotes
  WHERE id = ?
  AND company_id = ?
`);

const findContact = db.prepare(`
  SELECT
    c.quote_id AS quoteId,
    c.email,
    c.opted_out AS optedOut,
    c.created_at AS createdAt,
    c.updated_at AS updatedAt
  FROM quote_contacts c
  JOIN quotes q ON q.id = c.quote_id
  WHERE c.quote_id = ?
  AND q.company_id = ?
`);

const saveContact = db.prepare(`
  INSERT INTO quote_contacts (
    quote_id, email, opted_out,
    created_at, updated_at
  )
  VALUES (?, ?, 0, ?, ?)
  ON CONFLICT(quote_id)
  DO UPDATE SET
    email = excluded.email,
    updated_at = excluded.updated_at
`);

const findSuppression = db.prepare(`
  SELECT email
  FROM recipient_suppressions
  WHERE company_id = ?
    AND email = ?
`);

const optOutContact = db.prepare(`
  UPDATE quote_contacts
  SET opted_out = 1, updated_at = ?
  WHERE quote_id = ?
`);

const insertSuppression = db.prepare(`
  INSERT OR IGNORE INTO recipient_suppressions (
    company_id,
    email,
    created_at
  )
  VALUES (?, ?, ?)
`);

const cancelDrafts = db.prepare(`
  UPDATE outbound_messages
  SET status = 'cancelled'
  WHERE quote_id = ?
  AND status = 'draft'
`);

const findScheduledFollowUp = db.prepare(`
  SELECT f.scheduled_at AS scheduledAt
  FROM follow_ups f
  JOIN quotes q ON q.id = f.quote_id
  WHERE f.quote_id = ?
  AND q.company_id = ?
`);

const findActiveDraft = db.prepare(`
  SELECT
    id,
    quote_id AS quoteId,
    recipient_email AS recipientEmail,
    subject,
    body,
    status,
    created_at AS createdAt
  FROM outbound_messages
  WHERE quote_id = ?
  AND status = 'draft'
`);

const insertDraft = db.prepare(`
  INSERT INTO outbound_messages (
    id, quote_id, recipient_email,
    subject, body, status, created_at
  )
  VALUES (?, ?, ?, ?, ?, 'draft', ?)
`);

const findMessages = db.prepare(`
  SELECT
    id,
    quote_id AS quoteId,
    recipient_email AS recipientEmail,
    subject,
    body,
    status,
    created_at AS createdAt
  FROM outbound_messages
  WHERE quote_id = ?
  ORDER BY created_at DESC, rowid DESC
`);

const addActivity = db.prepare(`
  INSERT INTO activity_logs (
    id, quote_id, type, description, timestamp
  )
  VALUES (?, ?, ?, ?, ?)
`);

function runTransaction(callback) {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getOwnedQuote(req, res) {
  const quote = findQuote.get(req.params.id, req.user.companyId);

  if (!quote) {
    res.status(404).json({
      success: false,
      error: "Quote not found",
    });

    return null;
  }

  return quote;
}

function publicContact(contact) {
  if (!contact) return null;

  return {
    ...contact,
    optedOut: Boolean(contact.optedOut),
  };
}

function recordActivity(quoteId, type, description) {
  addActivity.run(
    randomUUID(),
    quoteId,
    type,
    description,
    new Date().toISOString(),
  );
}

router.get("/quotes/:id/contact", (req, res) => {
  const quote = getOwnedQuote(req, res);

  if (!quote) return;

  const contact = findContact.get(quote.id, req.user.companyId);

  res.json({
    success: true,
    data: publicContact(contact),
  });
});

router.put("/quotes/:id/contact", (req, res) => {
  const quote = getOwnedQuote(req, res);

  if (!quote) return;

  const { email } = req.body ?? {};

  if (
    typeof email !== "string" ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    return res.status(400).json({
      success: false,
      error: "Provide a valid customer email address",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const existing = findContact.get(quote.id, req.user.companyId);

  const suppressed = Boolean(
    findSuppression.get(req.user.companyId, normalizedEmail),
  );

  const now = new Date().toISOString();

  runTransaction(() => {
    saveContact.run(quote.id, normalizedEmail, existing?.createdAt ?? now, now);

    if (existing && existing.email !== normalizedEmail) {
      cancelDrafts.run(quote.id);
    }

    if (suppressed) {
      optOutContact.run(now, quote.id);
      cancelDrafts.run(quote.id);
    }

    recordActivity(
      quote.id,
      "contact",
      existing
        ? "Customer contact information updated."
        : "Customer contact information saved.",
    );
  });

  res.json({
    success: true,
    data: publicContact(findContact.get(quote.id, req.user.companyId)),
  });
});

router.post("/quotes/:id/opt-out", (req, res) => {
  const quote = getOwnedQuote(req, res);

  if (!quote) return;

  const contact = findContact.get(quote.id, req.user.companyId);

  if (!contact) {
    return res.status(404).json({
      success: false,
      error: "Customer contact not found",
    });
  }

  const now = new Date().toISOString();

  runTransaction(() => {
    insertSuppression.run(
      req.user.companyId,
      contact.email.trim().toLowerCase(),
      now,
    );

    optOutContact.run(now, quote.id);

    cancelDrafts.run(quote.id);

    if (!contact.optedOut) {
      recordActivity(
        quote.id,
        "opt-out",
        "Recipient opted out. Matching company drafts cancelled.",
      );
    }
  });

  res.json({
    success: true,
    message: "Recipient suppressed for this company.",
    data: publicContact(findContact.get(quote.id, req.user.companyId)),
  });
});

router.post("/quotes/:id/draft", (req, res) => {
  const companyId = req.user.companyId;
  const result = runTransaction(() => {
    const quote = findQuote.get(req.params.id, companyId);

    if (!quote) {
      return { status: 404, error: "Quote not found" };
    }

    if (quote.status === "Accepted") {
      return { status: 409, error: "Accepted quotes cannot receive follow-ups" };
    }

    const contact = findContact.get(quote.id, companyId);

    if (!contact) {
      return { status: 409, error: "Add a customer email before preparing a draft" };
    }

    if (
      contact.optedOut ||
      findSuppression.get(companyId, contact.email.trim().toLowerCase())
    ) {
      return { status: 409, error: "Recipient has opted out of follow-up emails" };
    }

    const followUp = findScheduledFollowUp.get(quote.id, companyId);

    if (!followUp) {
      return { status: 409, error: "Schedule a follow-up before preparing a draft" };
    }

    const existing = findActiveDraft.get(quote.id);

    if (existing) {
      return {
        status: 200,
        message: "Existing draft retrieved. No email sent.",
        data: existing,
      };
    }

    const now = new Date().toISOString();

    const message = createFollowUpEmailTemplate(db, {
      companyId,
      quoteId: quote.id,
      customer: quote.customer,
      equipment: quote.equipment,
      currentTime: now,
    });

    insertDraft.run(
      randomUUID(),
      quote.id,
      contact.email,
      message.subject,
      message.body,
      now,
    );

    recordActivity(
      quote.id,
      "draft",
      "Follow-up email draft prepared with an unsubscribe link. No email was sent.",
    );

    return {
      status: 201,
      message: "Email draft prepared. No email sent.",
      data: findActiveDraft.get(quote.id),
    };
  });

  if (result.error) {
    return res.status(result.status).json({ success: false, error: result.error });
  }

  res.status(result.status).json({
    success: true,
    message: result.message,
    data: result.data,
  });
});

router.get("/quotes/:id/messages", (req, res) => {
  const quote = getOwnedQuote(req, res);

  if (!quote) return;

  const messages = findMessages.all(quote.id);

  res.json({
    success: true,
    count: messages.length,
    data: messages,
  });
});

router.post("/quotes/:id/unsubscribe-link", (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Administrator access required",
      });
    }

    const result = createUnsubscribeToken(db, {
      companyId: req.user.companyId,
      quoteId: req.params.id,
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        error: "Quote contact not found",
      });
    }

    const url = new URL(
      `/api/unsubscribe/${result.token}`,
      "http://localhost:5000",
    ).toString();

    res.set("Cache-Control", "no-store");

    res.status(201).json({
      success: true,
      message: "Unsubscribe link created for testing",
      data: {
        url,
        expiresAt: result.expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
