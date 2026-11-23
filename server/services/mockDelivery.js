import { createHash } from "node:crypto";
import { isRealDeliveryEnabled } from "./deliveryGate.js";
import { getDeliveryPreflight } from "./deliveryPreflight.js";
import { createMockDeliveryTransport } from "./mockDeliveryTransport.js";
import { getProviderReadiness } from "./providerReadiness.js";
import { validateSenderIdentity } from "./senderIdentity.js";

const MAX_ATTEMPTS = 3;
const EVENT_TYPES = new Set(["delivered", "soft_bounce", "hard_bounce", "complaint"]);

function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isSingleMailbox(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email) &&
    email.split("@")[0].length <= 64;
}

function claim(db, options) {
  return transaction(db, () => {
    const preflight = getDeliveryPreflight(db, options);
    if (!preflight) return { state: "not_found" };

    const { companyId, messageId } = preflight;
    const previous = db.prepare(`
      SELECT state, attempts, payload_hash AS payloadHash
      FROM mock_delivery_claims WHERE company_id = ? AND message_id = ?
    `).get(companyId, messageId);
    if (previous && previous.state !== "retryable") return { state: previous.state };
    if (!preflight.technicalChecksPassed) return { state: "blocked" };

    const sender = getProviderReadiness(db, companyId, options.providerConfig);
    const { subject, body } = db.prepare(`
      SELECT subject, body FROM outbound_messages WHERE id = ?
    `).get(messageId);
    const recipient = preflight.recipientEmail.trim().toLowerCase();
    const identity = validateSenderIdentity({
      displayName: sender.senderDisplayName,
      replyToEmail: sender.replyToEmail,
    });
    if (!identity.valid || !isSingleMailbox(sender.fromEmail) ||
        !isSingleMailbox(sender.replyToEmail) || !isSingleMailbox(recipient) ||
        /[\x00-\x1f\x7f]/.test(subject)) {
      return { state: "blocked" };
    }

    const envelope = {
      from: { address: sender.fromEmail, name: identity.data.displayName },
      replyTo: identity.data.replyToEmail,
      to: recipient,
      subject,
      text: body,
    };
    const payloadHash = digest([sender.provider, envelope]);
    if (previous && previous.payloadHash !== payloadHash) return { state: "blocked" };

    const attempts = (previous?.attempts ?? 0) + 1;
    db.prepare(`
      INSERT INTO mock_delivery_claims (company_id, message_id, recipient, payload_hash, state, attempts)
      VALUES (?, ?, ?, ?, 'in_flight', ?)
      ON CONFLICT (company_id, message_id) DO UPDATE
        SET state = 'in_flight', attempts = excluded.attempts
    `).run(companyId, messageId, recipient, payloadHash, attempts);

    return {
      state: "claimed", companyId, messageId, attempts,
      request: { idempotencyKey: `mock-${digest([companyId, messageId])}`, envelope },
    };
  });
}

// Internal fixture workflow. The app does not install the mock ledger or call this function.
export async function attemptDelivery(db, { mode, mock, ...options } = {}) {
  if (mode !== "mock" && !isRealDeliveryEnabled()) return { state: "disabled" };
  if (mode !== "mock") return { state: "unsupported" };

  const submit = createMockDeliveryTransport(mock);
  const delivery = claim(db, options);
  if (delivery.state !== "claimed") return delivery;

  const outcome = await submit(delivery.request);
  const state = outcome.state === "retryable" && delivery.attempts >= MAX_ATTEMPTS
    ? "exhausted" : outcome.state;
  const update = db.prepare(`
    UPDATE mock_delivery_claims SET state = ?, provider_message_id = ?
    WHERE company_id = ? AND message_id = ? AND state = 'in_flight' AND attempts = ?
  `).run(state, outcome.providerMessageId ?? null, delivery.companyId, delivery.messageId, delivery.attempts);
  if (update.changes !== 1) throw new Error("Mock delivery claim was lost");
  return { state };
}

// Accept only normalized events from a trusted adapter. No HTTP route is registered.
export function recordVerifiedMockDeliveryEvent(db, {
  eventId, providerMessageId, type, currentTime = new Date().toISOString(),
}) {
  if (typeof eventId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(eventId) ||
      typeof providerMessageId !== "string" || !EVENT_TYPES.has(type)) {
    return { state: "invalid" };
  }
  const now = new Date(currentTime).toISOString();

  return transaction(db, () => {
    const delivery = db.prepare(`
      SELECT company_id AS companyId, recipient
      FROM mock_delivery_claims WHERE provider_message_id = ? AND state = 'accepted'
    `).get(providerMessageId);
    if (!delivery) return { state: "unmatched" };

    const event = db.prepare(`
      INSERT INTO mock_delivery_events (event_id, provider_message_id, type, recorded_at)
      VALUES (?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING
    `).run(eventId, providerMessageId, type, now);
    if (event.changes === 0) return { state: "duplicate" };

    if (type === "hard_bounce" || type === "complaint") {
      db.prepare(`
        INSERT INTO recipient_suppressions (company_id, email, created_at)
        VALUES (?, ?, ?) ON CONFLICT (company_id, email) DO NOTHING
      `).run(delivery.companyId, delivery.recipient, now);
    }
    return { state: "recorded" };
  });
}
