import express from "express";
import { randomUUID } from "node:crypto";
import { db } from "../database/db.js";

const router = express.Router();

const MAX_FOLLOWUPS = 2;
const BUSINESS_TIMEZONE = "America/Chicago";

db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS follow_ups (
    quote_id TEXT PRIMARY KEY,
    scheduled_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (quote_id) REFERENCES quotes(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (quote_id) REFERENCES quotes(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_followups_scheduled
  ON follow_ups(scheduled_at);

  CREATE INDEX IF NOT EXISTS idx_activity_quote
  ON activity_logs(quote_id, timestamp);
`);

const findQuote = db.prepare(`
  SELECT id, customer, equipment, amount, date, status
  FROM quotes
  WHERE id = ?
  AND company_id = ?
`);

const findFollowUp = db.prepare(`
  SELECT f.*
  FROM follow_ups f
  JOIN quotes q ON q.id = f.quote_id
  WHERE f.quote_id = ?
  AND q.company_id = ?
`);

const findActivity = db.prepare(`
  SELECT
    a.id,
    a.quote_id,
    a.type,
    a.description,
    a.timestamp
  FROM activity_logs a
  JOIN quotes q ON q.id = a.quote_id
  WHERE a.quote_id = ?
  AND q.company_id = ?
  ORDER BY a.timestamp DESC, a.rowid DESC
`);

const countSimulations = db.prepare(`
  SELECT COUNT(*) AS total
  FROM activity_logs a
  JOIN quotes q ON q.id = a.quote_id
  WHERE a.quote_id = ?
  AND q.company_id = ?
  AND a.type = 'simulation'
`);

const getQueue = db.prepare(`
  SELECT
    f.quote_id AS quoteId,
    f.scheduled_at AS scheduledAt,
    q.customer,
    q.equipment,
    q.amount,
    q.status
  FROM follow_ups f
  JOIN quotes q ON q.id = f.quote_id
  WHERE q.company_id = ?
  AND q.status != 'Accepted'
  ORDER BY f.scheduled_at ASC
`);

const saveFollowUp = db.prepare(`
  INSERT INTO follow_ups (
    quote_id, scheduled_at, created_at, updated_at
  )
  VALUES (?, ?, ?, ?)
  ON CONFLICT(quote_id)
  DO UPDATE SET
    scheduled_at = excluded.scheduled_at,
    updated_at = excluded.updated_at
`);

const removeFollowUp = db.prepare(`
  DELETE FROM follow_ups
  WHERE quote_id = ?
  AND EXISTS (
    SELECT 1
    FROM quotes
    WHERE quotes.id = follow_ups.quote_id
    AND quotes.company_id = ?
  )
`);

const updateStatus = db.prepare(`
  UPDATE quotes
  SET status = ?
  WHERE id = ?
  AND company_id = ?
`);

const addActivity = db.prepare(`
  INSERT INTO activity_logs (
    id, quote_id, type, description, timestamp
  )
  VALUES (?, ?, ?, ?, ?)
`);

function recordActivity(quoteId, type, description) {
  addActivity.run(
    randomUUID(),
    quoteId,
    type,
    description,
    new Date().toISOString(),
  );
}

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

function validateDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return {
      error: "Provide a valid ISO date with timezone.",
    };
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    return {
      error: "Follow-up must be scheduled in the future.",
    };
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  const hour = Number(values.hour);
  const weekday = values.weekday;

  if (weekday === "Sat" || weekday === "Sun" || hour < 9 || hour >= 17) {
    return {
      error: "Choose Monday-Friday, 9 AM-5 PM Central.",
    };
  }

  return {
    scheduledAt: date.toISOString(),
  };
}

router.get("/", (req, res) => {
  const rows = getQueue.all(req.user.companyId);
  const now = Date.now();

  const data = rows.map((row) => ({
    ...row,
    isDue: new Date(row.scheduledAt).getTime() <= now,
  }));

  res.json({
    success: true,
    count: data.length,
    data,
  });
});

router.get("/quotes/:id/activity", (req, res) => {
  const quote = findQuote.get(req.params.id, req.user.companyId);

  if (!quote) {
    return res.status(404).json({
      success: false,
      error: "Quote not found",
    });
  }

  res.json({
    success: true,
    data: findActivity.all(req.params.id, req.user.companyId),
  });
});

router.put("/quotes/:id", (req, res) => {
  const quoteId = req.params.id;
  const companyId = req.user.companyId;

  const quote = findQuote.get(quoteId, companyId);

  if (!quote) {
    return res.status(404).json({
      success: false,
      error: "Quote not found",
    });
  }

  if (quote.status === "Accepted") {
    return res.status(409).json({
      success: false,
      error: "Accepted quotes cannot receive follow-ups",
    });
  }

  const completed = countSimulations.get(quoteId, companyId).total;

  if (completed >= MAX_FOLLOWUPS) {
    return res.status(409).json({
      success: false,
      error: "Follow-up limit reached",
    });
  }

  const result = validateDate(req.body?.scheduledAt);

  if (result.error) {
    return res.status(400).json({
      success: false,
      error: result.error,
    });
  }

  const existing = findFollowUp.get(quoteId, companyId);

  const now = new Date().toISOString();

  runTransaction(() => {
    saveFollowUp.run(
      quoteId,
      result.scheduledAt,
      existing?.created_at ?? now,
      now,
    );

    updateStatus.run("Follow-up Scheduled", quoteId, companyId);

    recordActivity(
      quoteId,
      "scheduling",
      existing ? "Follow-up rescheduled." : "Follow-up scheduled.",
    );
  });

  res.json({
    success: true,
    message: existing ? "Follow-up rescheduled." : "Follow-up scheduled.",
    data: findFollowUp.get(quoteId, companyId),
  });
});

router.delete("/quotes/:id", (req, res) => {
  const quoteId = req.params.id;
  const companyId = req.user.companyId;

  const quote = findQuote.get(quoteId, companyId);

  if (!quote) {
    return res.status(404).json({
      success: false,
      error: "Quote not found",
    });
  }

  const existing = findFollowUp.get(quoteId, companyId);

  if (!existing) {
    return res.status(404).json({
      success: false,
      error: "No follow-up is scheduled",
    });
  }

  runTransaction(() => {
    removeFollowUp.run(quoteId, companyId);

    if (quote.status !== "Accepted") {
      updateStatus.run("Pending", quoteId, companyId);
    }

    recordActivity(quoteId, "cancellation", "Scheduled follow-up cancelled.");
  });

  res.json({
    success: true,
    message: "Follow-up cancelled.",
  });
});

router.post("/quotes/:id/simulate", (req, res) => {
  const quoteId = req.params.id;
  const companyId = req.user.companyId;

  const quote = findQuote.get(quoteId, companyId);

  if (!quote) {
    return res.status(404).json({
      success: false,
      error: "Quote not found",
    });
  }

  if (quote.status === "Accepted") {
    return res.status(409).json({
      success: false,
      error: "Accepted quotes cannot receive follow-ups",
    });
  }

  const existing = findFollowUp.get(quoteId, companyId);

  if (!existing) {
    return res.status(409).json({
      success: false,
      error: "Schedule a follow-up first",
    });
  }

  const completed = countSimulations.get(quoteId, companyId).total;

  if (completed >= MAX_FOLLOWUPS) {
    return res.status(409).json({
      success: false,
      error: "Follow-up limit reached",
    });
  }

  runTransaction(() => {
    removeFollowUp.run(quoteId, companyId);

    updateStatus.run("Pending", quoteId, companyId);

    recordActivity(
      quoteId,
      "simulation",
      "Follow-up simulated successfully. No email was sent.",
    );
  });

  res.json({
    success: true,
    message: "Simulation completed. No email was sent.",
    remaining: MAX_FOLLOWUPS - completed - 1,
  });
});

export default router;
