import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { recordDeliveryEvent } from "./deliveryWebhookEvents.js";
import {
  DEFAULT_MOCK_ACCOUNT, isMockAccount, isMockMessageId, MOCK_EVENT_TYPES, MOCK_PROVIDER,
} from "./mockDeliveryProtocol.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SKEW_SECONDS = 300;

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
    return recordDeliveryEvent(db, MOCK_PROVIDER, account, {
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
