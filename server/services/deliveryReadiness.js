export function getDeliveryReadiness(
  db,
  companyId,
  quoteId,
  currentTime = new Date().toISOString(),
) {
  const now = new Date(currentTime);

  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid processing time");
  }

  const quote = db
    .prepare(
      `
    SELECT id, customer, equipment, status
    FROM quotes
    WHERE id = ?
      AND company_id = ?
  `,
    )
    .get(quoteId, companyId);

  if (!quote) {
    return null;
  }

  const contact = db
    .prepare(
      `
    SELECT email, opted_out AS optedOut
    FROM quote_contacts
    WHERE quote_id = ?
  `,
    )
    .get(quoteId);

  const followUp = db
    .prepare(
      `
    SELECT scheduled_at AS scheduledAt
    FROM follow_ups
    WHERE quote_id = ?
  `,
    )
    .get(quoteId);

  const draft = db
    .prepare(
      `
    SELECT
      id,
      recipient_email AS recipientEmail,
      subject,
      status,
      created_at AS createdAt
    FROM outbound_messages
    WHERE quote_id = ?
      AND status = 'draft'
    ORDER BY created_at DESC
    LIMIT 1
  `,
    )
    .get(quoteId);

  const email = contact?.email?.trim().toLowerCase() ?? null;

  const suppressed = email
    ? Boolean(
        db
          .prepare(
            `
          SELECT 1
          FROM recipient_suppressions
          WHERE company_id = ?
            AND email = ?
        `,
          )
          .get(companyId, email),
      )
    : false;

  const reasons = [];

  if (quote.status === "Accepted") {
    reasons.push("QUOTE_ACCEPTED");
  }

  if (quote.status !== "Follow-up Scheduled") {
    reasons.push("QUOTE_NOT_SCHEDULED");
  }

  if (!followUp) {
    reasons.push("NO_SCHEDULED_FOLLOWUP");
  }

  const scheduledTime = followUp
    ? new Date(followUp.scheduledAt).getTime()
    : null;

  if (followUp && !Number.isFinite(scheduledTime)) {
    reasons.push("INVALID_SCHEDULE");
  }

  if (!contact) {
    reasons.push("CONTACT_MISSING");
  } else {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reasons.push("INVALID_EMAIL");
    }

    if (contact.optedOut || suppressed) {
      reasons.push("RECIPIENT_OPTED_OUT");
    }
  }

  if (!draft) {
    reasons.push("ACTIVE_DRAFT_MISSING");
  } else if (email && draft.recipientEmail.trim().toLowerCase() !== email) {
    reasons.push("DRAFT_RECIPIENT_MISMATCH");
  }

  const technicallyEligible = reasons.length === 0;

  let status = "blocked";

  if (technicallyEligible) {
    status = scheduledTime > now.getTime() ? "scheduled" : "needs_review";
  }

  return {
    quoteId: quote.id,
    customer: quote.customer,
    equipment: quote.equipment,
    status,
    quoteStatus: quote.status,
    scheduledAt: followUp?.scheduledAt ?? null,
    recipientEmail: email,
    draftId: draft?.id ?? null,
    draftSubject: draft?.subject ?? null,
    reasons,
    technicallyEligible,
    due:
      scheduledTime !== null &&
      Number.isFinite(scheduledTime) &&
      scheduledTime <= now.getTime(),
    reviewRequired: true,
    deliveryEnabled: false,
    emailsSent: 0,
  };
}
