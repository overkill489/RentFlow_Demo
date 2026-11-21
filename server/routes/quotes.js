import express from "express";
import { randomUUID } from "node:crypto";
import { db } from "../database/db.js";

const router = express.Router();

const allowedStatuses = [
  "Pending",
  "Follow-up Due",
  "Follow-up Scheduled",
  "Accepted",
];

const getAllQuotes = db.prepare(`
  SELECT
    id,
    customer,
    equipment,
    amount,
    date,
    status
  FROM quotes
  WHERE company_id = ?
  ORDER BY CAST(SUBSTR(id, 4) AS INTEGER) DESC
`);

const getQuoteById = db.prepare(`
  SELECT
    id,
    customer,
    equipment,
    amount,
    date,
    status
  FROM quotes
  WHERE id = ?
  AND company_id = ?
`);

const getNextId = db.prepare(`
  SELECT COALESCE(
    MAX(CAST(SUBSTR(id, 4) AS INTEGER)),
    1000
  ) + 1 AS nextId
  FROM quotes
`);

const insertQuote = db.prepare(`
  INSERT INTO quotes (
    id,
    customer,
    equipment,
    amount,
    date,
    status,
    company_id
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const updateQuoteStatus = db.prepare(`
  UPDATE quotes
  SET status = ?
  WHERE id = ?
  AND company_id = ?
`);

const getFollowUp = db.prepare(`
  SELECT quote_id
  FROM follow_ups
  WHERE quote_id = ?
`);

const removeFollowUp = db.prepare(`
  DELETE FROM follow_ups
  WHERE quote_id = ?
`);

const addActivity = db.prepare(`
  INSERT INTO activity_logs (
    id,
    quote_id,
    type,
    description,
    timestamp
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

router.get("/", (req, res) => {
  const quotes = getAllQuotes.all(req.user.companyId);

  res.json({
    success: true,
    count: quotes.length,
    data: quotes,
  });
});

router.get("/:id", (req, res) => {
  const quote = getQuoteById.get(req.params.id, req.user.companyId);

  if (!quote) {
    return res.status(404).json({
      success: false,
      error: "Quote not found",
    });
  }

  res.json({
    success: true,
    data: quote,
  });
});

router.post("/", (req, res) => {
  const { customer, equipment, amount } = req.body ?? {};
  const parsedAmount = Number(amount);

  if (
    typeof customer !== "string" ||
    !customer.trim() ||
    customer.trim().length > 120 ||
    typeof equipment !== "string" ||
    !equipment.trim() ||
    equipment.trim().length > 160 ||
    amount === null ||
    amount === undefined ||
    amount === "" ||
    typeof amount === "boolean" ||
    !Number.isFinite(parsedAmount) ||
    parsedAmount <= 0 ||
    parsedAmount > 10000000
  ) {
    return res.status(400).json({
      success: false,
      error: "Provide a valid customer, equipment, and positive amount",
    });
  }

  const date = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const quote = runTransaction(() => {
    const id = `QT-${getNextId.get().nextId}`;

    insertQuote.run(
      id,
      customer.trim(),
      equipment.trim(),
      parsedAmount,
      date,
      "Pending",
      req.user.companyId,
    );

    return getQuoteById.get(id, req.user.companyId);
  });

  res.status(201).json({
    success: true,
    data: quote,
  });
});

router.patch("/:id", (req, res) => {
  const quoteId = req.params.id;
  const companyId = req.user.companyId;

  const quote = getQuoteById.get(quoteId, companyId);

  if (!quote) {
    return res.status(404).json({
      success: false,
      error: "Quote not found",
    });
  }

  const { status } = req.body ?? {};

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      error: "Invalid quote status",
    });
  }

  if (quote.status === "Accepted" && status !== "Accepted") {
    return res.status(409).json({
      success: false,
      error: "Accepted quotes cannot be reopened",
    });
  }

  if (status === "Follow-up Scheduled" && !getFollowUp.get(quoteId)) {
    return res.status(409).json({
      success: false,
      error: "Schedule a follow-up using the follow-up API",
    });
  }

  runTransaction(() => {
    updateQuoteStatus.run(status, quoteId, companyId);

    if (status !== "Follow-up Scheduled" && getFollowUp.get(quoteId)) {
      removeFollowUp.run(quoteId);

      addActivity.run(
        randomUUID(),
        quoteId,
        "cancellation",
        "Scheduled follow-up removed after quote status changed.",
        new Date().toISOString(),
      );
    }

    if (quote.status !== status || status === "Accepted") {
      addActivity.run(
        randomUUID(),
        quoteId,
        "status",
        status === "Accepted"
          ? "Quote accepted. Scheduled follow-ups cancelled."
          : `Quote status changed to ${status}.`,
        new Date().toISOString(),
      );
    }
  });

  res.json({
    success: true,
    data: getQuoteById.get(quoteId, companyId),
  });
});

export default router;
