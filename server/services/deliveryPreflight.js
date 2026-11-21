import { createHash } from "node:crypto";
import { getDeliveryReadiness } from "./deliveryReadiness.js";
import { getProviderReadiness } from "./providerReadiness.js";

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function inspectDraftUnsubscribe(db, entry, processingTime) {
  const urls =
    entry.body.match(
      /https?:\/\/[^\s<>"']+\/api\/unsubscribe\/[A-Za-z0-9_-]+/g,
    ) ?? [];

  if (urls.length !== 1) {
    return {
      valid: false,
      reason: "UNSUBSCRIBE_LINK_MISSING_OR_AMBIGUOUS",
    };
  }

  let url;

  try {
    url = new URL(urls[0]);
  } catch {
    return {
      valid: false,
      reason: "INVALID_UNSUBSCRIBE_URL",
    };
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    return {
      valid: false,
      reason: "INVALID_UNSUBSCRIBE_URL",
    };
  }

  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname.toLowerCase())
  ) {
    return {
      valid: false,
      reason: "INSECURE_UNSUBSCRIBE_URL",
    };
  }

  const match = url.pathname.match(/^\/api\/unsubscribe\/([A-Za-z0-9_-]{43})$/);

  if (!match) {
    return {
      valid: false,
      reason: "INVALID_UNSUBSCRIBE_TOKEN",
    };
  }

  const tokenHash = createHash("sha256").update(match[1]).digest("hex");

  const record = db
    .prepare(
      `
    SELECT
      company_id AS companyId,
      quote_id AS quoteId,
      email,
      expires_at AS expiresAt,
      used_at AS usedAt
    FROM unsubscribe_tokens
    WHERE token_hash = ?
  `,
    )
    .get(tokenHash);

  if (!record) {
    return {
      valid: false,
      reason: "UNSUBSCRIBE_TOKEN_NOT_FOUND",
    };
  }

  if (
    record.companyId !== entry.companyId ||
    record.quoteId !== entry.quoteId ||
    normalizeEmail(record.email) !== normalizeEmail(entry.recipientEmail)
  ) {
    return {
      valid: false,
      reason: "UNSUBSCRIBE_TOKEN_MISMATCH",
    };
  }

  if (record.usedAt) {
    return {
      valid: false,
      reason: "UNSUBSCRIBE_TOKEN_USED",
    };
  }

  const expiry = new Date(record.expiresAt).getTime();

  if (
    !Number.isFinite(expiry) ||
    expiry <= new Date(processingTime).getTime()
  ) {
    return {
      valid: false,
      reason: "UNSUBSCRIBE_TOKEN_EXPIRED",
    };
  }

  return {
    valid: true,
    reason: null,
    expiresAt: record.expiresAt,
  };
}

export function getDeliveryPreflight(
  db,
  {
    companyId,
    queueId,
    currentTime = new Date().toISOString(),
    providerConfig = {},
  },
) {
  const date = new Date(currentTime);

  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid preflight time");
  }

  const now = date.toISOString();

  const entry = db
    .prepare(
      `
    SELECT
      dq.id AS queueId,
      dq.status AS queueStatus,
      dq.message_id AS messageId,
      m.quote_id AS quoteId,
      m.status AS messageStatus,
      m.recipient_email AS recipientEmail,
      m.subject,
      m.body,
      q.company_id AS companyId
    FROM delivery_queue dq
    JOIN outbound_messages m
      ON m.id = dq.message_id
    JOIN quotes q
      ON q.id = m.quote_id
    WHERE dq.id = ?
      AND q.company_id = ?
  `,
    )
    .get(queueId, companyId);

  if (!entry) {
    return null;
  }

  const reasons = [];

  if (entry.queueStatus !== "approved") {
    reasons.push("QUEUE_NOT_APPROVED");
  }

  if (entry.messageStatus !== "draft") {
    reasons.push("MESSAGE_NOT_ACTIVE");
  }

  const readiness = getDeliveryReadiness(db, companyId, entry.quoteId, now);

  if (
    !readiness ||
    readiness.status !== "needs_review" ||
    readiness.draftId !== entry.messageId
  ) {
    reasons.push("DELIVERY_READINESS_FAILED");
  }

  if (readiness?.reasons) {
    for (const reason of readiness.reasons) {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }

  if (readiness?.status === "scheduled") {
    reasons.push("FOLLOWUP_NOT_DUE");
  }

  const unsubscribe = inspectDraftUnsubscribe(db, entry, now);

  if (!unsubscribe.valid) {
    reasons.push(unsubscribe.reason);
  }

  const provider = getProviderReadiness(db, companyId, providerConfig);

  if (!provider || !provider.configurationValid) {
    reasons.push("PROVIDER_CONFIGURATION_INCOMPLETE");
  }

  if (provider?.reasons) {
    for (const reason of provider.reasons) {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }

  const technicalChecksPassed = reasons.length === 0;

  const safetyBlocks = [
    "PROVIDER_CONNECTION_NOT_VERIFIED",
    "SENDING_NOT_AUTHORIZED",
    "DELIVERY_DISABLED",
  ];

  return {
    queueId: entry.queueId,
    quoteId: entry.quoteId,
    messageId: entry.messageId,
    companyId: entry.companyId,
    queueStatus: entry.queueStatus,
    messageStatus: entry.messageStatus,
    recipientEmail: entry.recipientEmail,
    checkedAt: now,
    status: "blocked",
    technicalChecksPassed,
    unsubscribeValid: unsubscribe.valid,
    unsubscribeExpiresAt: unsubscribe.expiresAt ?? null,
    providerConfigurationValid: provider?.configurationValid ?? false,
    provider: provider?.provider ?? "disabled",
    reasons: [...reasons, ...safetyBlocks],
    providerConnectionVerified: false,
    sendingAuthorized: false,
    deliveryEnabled: false,
    emailsSent: 0,
  };
}
