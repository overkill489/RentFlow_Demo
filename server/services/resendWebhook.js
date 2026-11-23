import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isSingleMailbox } from "./deliveryHandoff.js";
import { recordDeliveryEvent } from "./deliveryWebhookEvents.js";
import { isResendAccount, isResendMessageId, RESEND_CORRELATION_TAG, RESEND_PROVIDER } from "./resendProtocol.js";

const MAX_BODY = 64 * 1024;
const MAX_SKEW_SECONDS = 300;

function decodeSecret(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]{22,172}={0,2}$/.test(secret)) return null;
  const encoded = secret.slice("whsec_".length);
  const key = Buffer.from(encoded, "base64");
  const canonical = key.toString("base64");
  if (encoded !== canonical && encoded !== canonical.replace(/=+$/, "")) return null;
  return key.length >= 16 && key.length <= 128 ? key : null;
}

function hasValidSignature(key, id, timestamp, header, rawBody) {
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest();
  return header.split(/ +/).some((entry) => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(entry)) return false;
    const supplied = Buffer.from(entry.slice(3), "base64");
    return supplied.toString("base64") === entry.slice(3) && timingSafeEqual(supplied, expected);
  });
}

function eventType(event) {
  if (event.type === "email.delivered") return "delivered";
  if (event.type === "email.complained") return "complaint";
  if (event.type !== "email.bounced") return "ignored";
  // The legacy bounce subtype reports an existing account-wide suppression, not a new bounce.
  if (event.data?.bounce?.subType === "Suppressed") return "ignored";
  switch (event.data?.bounce?.type) {
    case "Permanent": return "hard_bounce";
    case "Transient":
    case "Temporary":
    case "Undetermined": return "soft_bounce";
    default: return "invalid";
  }
}

// The configured account comes from the trusted endpoint binding, never the request body.
export function createResendWebhook({ account, secret, clock = Date.now } = {}) {
  const key = decodeSecret(secret);
  if (!key || !isResendAccount(account) || typeof clock !== "function") {
    throw new Error("Invalid Resend webhook configuration");
  }

  return (db, { rawBody, headers = {} } = {}) => {
    const { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature } = headers ?? {};
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_BODY ||
        typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        typeof timestamp !== "string" || !/^[1-9]\d{0,11}$/.test(timestamp) ||
        typeof signature !== "string" || signature.length > 1024) {
      return { state: "invalid" };
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS ||
        !hasValidSignature(key, id, timestamp, signature, rawBody)) {
      return { state: "unauthenticated" };
    }

    let event;
    try {
      event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return { state: "invalid" };
    }
    if (typeof event?.type !== "string") return { state: "invalid" };
    const type = eventType(event);
    if (type === "ignored" || type === "invalid") return { state: type };

    const { email_id: providerMessageId, to, tags } = event.data ?? {};
    const recipient = Array.isArray(to) && to.length === 1 && typeof to[0] === "string"
      ? to[0].trim().toLowerCase() : null;
    const idempotencyKey = tags?.[RESEND_CORRELATION_TAG];
    if (!isResendMessageId(providerMessageId) || !isSingleMailbox(recipient) ||
        (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !/^resend-[a-f0-9]{64}$/.test(idempotencyKey)))) {
      return { state: "invalid" };
    }
    return recordDeliveryEvent(db, RESEND_PROVIDER, account, {
      id, type, recipient, providerMessageId: providerMessageId.toLowerCase(),
      idempotencyKey: idempotencyKey ?? null,
      bodyHash: createHash("sha256").update(rawBody).digest("hex"),
      receivedAt: new Date(now).toISOString(),
    });
  };
}
