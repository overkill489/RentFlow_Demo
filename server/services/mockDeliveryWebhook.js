import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { immediateTransaction } from "../database/immediateTransaction.js";
import {
  DEFAULT_MOCK_ACCOUNT, isMockAccount, isMockMessageId, MOCK_EVENT_TYPES, MOCK_PROVIDER,
} from "./mockDeliveryProtocol.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SKEW_SECONDS = 300;

function recordEvent(db, account, event) {
  return immediateTransaction(db, () => {
    const prior = db.prepare(`
      SELECT body_hash AS bodyHash FROM email_delivery_events
      WHERE provider = ? AND provider_account = ? AND event_id = ?
    `).get(MOCK_PROVIDER, account, event.id);
    if (prior) return { state: prior.bodyHash === event.bodyHash ? "duplicate" : "conflict" };

    const matches = db.prepare(`
      SELECT id, company_id AS companyId, recipient, state, provider_message_id AS providerMessageId,
        idempotency_key AS idempotencyKey
      FROM email_deliveries WHERE provider = ? AND provider_account = ?
        AND (provider_message_id = ? OR idempotency_key = ?)
    `).all(MOCK_PROVIDER, account, event.providerMessageId, event.idempotencyKey);
    if (matches.length === 0) return { state: "unmatched" };
    const [delivery] = matches;
    if (matches.length > 1 || delivery.recipient !== event.recipient ||
        (event.idempotencyKey && delivery.idempotencyKey !== event.idempotencyKey) ||
        (delivery.providerMessageId && delivery.providerMessageId !== event.providerMessageId) ||
        ["rejected", "cancelled"].includes(delivery.state)) {
      return { state: "conflict" };
    }

    let state = "accepted";
    if (delivery.state === "complained" || event.type === "complaint") state = "complained";
    else if (delivery.state === "bounced" || event.type === "hard_bounce") state = "bounced";

    db.prepare(`
      INSERT INTO email_delivery_events (provider, provider_account, event_id, delivery_id, type, body_hash, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(MOCK_PROVIDER, account, event.id, delivery.id, event.type, event.bodyHash, event.receivedAt);
    if (delivery.state === "claimed") {
      const attempt = db.prepare(`
        UPDATE email_delivery_attempts SET outcome = 'accepted', finished_at = max(claimed_at, ?)
        WHERE delivery_id = ? AND finished_at IS NULL
      `).run(event.receivedAt, delivery.id);
      if (attempt.changes !== 1) throw new Error("Mock delivery claim has no open attempt");
    }
    db.prepare(`
      UPDATE email_deliveries SET state = ?, provider_message_id = ?, updated_at = max(updated_at, ?)
      WHERE id = ?
    `).run(state, event.providerMessageId, event.receivedAt, delivery.id);

    if (event.type === "hard_bounce" || event.type === "complaint") {
      db.prepare(`
        INSERT INTO recipient_suppressions (company_id, email, created_at)
        SELECT id, ?, ? FROM companies WHERE id = ?
        ON CONFLICT (company_id, email) DO NOTHING
      `).run(delivery.recipient, event.receivedAt, delivery.companyId);
    }
    return { state: "recorded" };
  });
}

// Mock protocol only. No HTTP route or provider-specific verification is registered.
export function createMockDeliveryWebhook({ secret, account = DEFAULT_MOCK_ACCOUNT, clock = Date.now }) {
  if (!Buffer.isBuffer(secret) || secret.length < 32 || !isMockAccount(account)) {
    throw new Error("Invalid mock webhook configuration");
  }
  const key = Buffer.from(secret);

  return (db, { rawBody, timestamp, eventId, signature } = {}) => {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES ||
        typeof eventId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(eventId) ||
        typeof timestamp !== "string" || !/^[1-9]\d{0,11}$/.test(timestamp) ||
        typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) {
      return { state: "invalid" };
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) {
      return { state: "unauthenticated" };
    }
    const expected = createHmac("sha256", key)
      .update(`mock-v1.${account}.${timestamp}.${eventId}.`).update(rawBody).digest();
    if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) return { state: "unauthenticated" };

    let event;
    try {
      event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return { state: "invalid" };
    }
    if (!event || !MOCK_EVENT_TYPES.has(event.type) || !isMockMessageId(event.providerMessageId) ||
        typeof event.recipient !== "string" || event.recipient.length > 254 ||
        (event.idempotencyKey !== undefined &&
          (typeof event.idempotencyKey !== "string" || !/^mock-[a-f0-9]{64}$/.test(event.idempotencyKey)))) {
      return { state: "invalid" };
    }
    return recordEvent(db, account, {
      id: eventId,
      providerMessageId: event.providerMessageId,
      idempotencyKey: event.idempotencyKey ?? null,
      type: event.type,
      recipient: event.recipient.trim().toLowerCase(),
      bodyHash: createHash("sha256").update(rawBody).digest("hex"),
      receivedAt: new Date(now).toISOString(),
    });
  };
}
