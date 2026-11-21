import { randomUUID } from "node:crypto";
import { createFollowUpEmailTemplate } from "../services/followUpEmailTemplate.js";

export function processDueFollowUps(db, processingTime, dryRun = false) {
  const parsed = new Date(processingTime);

  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Invalid processing date");
  }

  const now = parsed.toISOString();

  const findDue = db.prepare(`
  SELECT
    f.quote_id AS quoteId,
    f.scheduled_at AS scheduledAt,
    q.company_id AS companyId,
    q.customer,
    q.equipment,
    c.email,
    c.opted_out AS optedOut,
    EXISTS (
      SELECT 1
      FROM recipient_suppressions s
      WHERE s.company_id = q.company_id
        AND s.email = LOWER(TRIM(c.email))
    ) AS recipientSuppressed,
    EXISTS (
      SELECT 1
      FROM followup_due_events e
      WHERE e.quote_id = f.quote_id
        AND e.scheduled_at = f.scheduled_at
    ) AS alreadyDetected,
    EXISTS (
      SELECT 1
      FROM outbound_messages m
      WHERE m.quote_id = f.quote_id
        AND m.status = 'draft'
    ) AS hasDraft
  FROM follow_ups f
  JOIN quotes q ON q.id = f.quote_id
  LEFT JOIN quote_contacts c ON c.quote_id = q.id
  WHERE f.scheduled_at <= ?
    AND q.status = 'Follow-up Scheduled'
    AND q.company_id IS NOT NULL
  ORDER BY f.scheduled_at, f.quote_id
`);

  const insertDueEvent = db.prepare(`
    INSERT OR IGNORE INTO followup_due_events (
      quote_id, scheduled_at, detected_at
    )
    VALUES (?, ?, ?)
  `);

  const insertDraft = db.prepare(`
    INSERT OR IGNORE INTO outbound_messages (
      id, quote_id, recipient_email,
      subject, body, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, 'draft', ?)
  `);

  const insertActivity = db.prepare(`
    INSERT INTO activity_logs (
      id, quote_id, type, description, timestamp
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  function eligibility(item) {
    if (!item.email) {
      return "missing_contact";
    }

    if (item.optedOut || item.recipientSuppressed) {
      return "opted_out";
    }

    if (item.hasDraft) {
      return "already_prepared";
    }

    return "eligible";
  }

  if (dryRun) {
    const rows = findDue.all(now);

    const data = rows.map((item) => ({
      quoteId: item.quoteId,
      scheduledAt: item.scheduledAt,
      alreadyDetected: Boolean(item.alreadyDetected),
      draftEligibility: eligibility(item),
    }));

    return {
      mode: "dry-run",
      processingTime: now,
      detected: rows.length,
      recorded: 0,
      draftsPrepared: 0,
      eligibleDrafts: data.filter(
        (item) => item.draftEligibility === "eligible",
      ).length,
      emailsSent: 0,
      data,
    };
  }

  const result = {
    mode: "process",
    processingTime: now,
    detected: 0,
    recorded: 0,
    draftsPrepared: 0,
    skipped: {
      missingContact: 0,
      optedOut: 0,
      alreadyPrepared: 0,
    },
    emailsSent: 0,
  };

  db.exec("BEGIN IMMEDIATE");

  try {
    const rows = findDue.all(now);
    result.detected = rows.length;

    for (const item of rows) {
      const timestamp = new Date().toISOString();

      const dueResult = insertDueEvent.run(
        item.quoteId,
        item.scheduledAt,
        timestamp,
      );

      if (dueResult.changes === 1) {
        result.recorded += 1;

        insertActivity.run(
          randomUUID(),
          item.quoteId,
          "due",
          "Scheduled follow-up became due. No email was sent.",
          timestamp,
        );
      }

      const status = eligibility(item);

      if (status === "missing_contact") {
        result.skipped.missingContact += 1;
        continue;
      }

      if (status === "opted_out") {
        result.skipped.optedOut += 1;
        continue;
      }

      if (status === "already_prepared") {
        result.skipped.alreadyPrepared += 1;
        continue;
      }

      const message = createFollowUpEmailTemplate(db, {
        companyId: item.companyId,
        quoteId: item.quoteId,
        customer: item.customer,
        equipment: item.equipment,
        currentTime: new Date().toISOString(),
      });

      const draftResult = insertDraft.run(
        randomUUID(),
        item.quoteId,
        item.email,
        message.subject,
        message.body,
        timestamp,
      );

      if (draftResult.changes === 1) {
        result.draftsPrepared += 1;

        insertActivity.run(
          randomUUID(),
          item.quoteId,
          "draft",
          "Automatic follow-up draft prepared. No email was sent.",
          timestamp,
        );
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return result;
}
