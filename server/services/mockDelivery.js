import { createHash } from "node:crypto";
import { immediateTransaction } from "../database/immediateTransaction.js";
import { isRealDeliveryEnabled } from "./deliveryGate.js";
import { getDeliveryPreflight } from "./deliveryPreflight.js";
import { DEFAULT_MOCK_ACCOUNT, isMockAccount, MOCK_PROVIDER } from "./mockDeliveryProtocol.js";
import { createMockDeliveryTransport } from "./mockDeliveryTransport.js";
import { getProviderReadiness } from "./providerReadiness.js";
import { validateSenderIdentity } from "./senderIdentity.js";

const MAX_ATTEMPTS = 3;

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isSingleMailbox(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email) &&
    email.split("@")[0].length <= 64;
}

function claim(db, account, options) {
  return immediateTransaction(db, () => {
    const preflight = getDeliveryPreflight(db, options);
    if (!preflight) return { state: "not_found" };

    const { companyId, messageId } = preflight;
    const previous = db.prepare(`
      SELECT d.id, d.state, d.idempotency_key AS idempotencyKey, d.payload_hash AS payloadHash,
        d.provider, d.provider_account AS account,
        (SELECT max(number) FROM email_delivery_attempts WHERE delivery_id = d.id) AS attempts
      FROM email_deliveries d WHERE company_id = ? AND message_id = ?
    `).get(companyId, messageId);
    if (previous && (previous.provider !== MOCK_PROVIDER || previous.account !== account)) {
      return { state: "blocked" };
    }
    if (previous && previous.state !== "rejected") return { state: previous.state };
    const now = new Date().toISOString();
    if (previous && preflight.queueStatus === "cancelled") {
      db.prepare("UPDATE email_deliveries SET state = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now, previous.id);
      return { state: "cancelled" };
    }
    if (previous?.attempts >= MAX_ATTEMPTS) return { state: "rejected" };
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

    const number = (previous?.attempts ?? 0) + 1;
    const idempotencyKey = previous?.idempotencyKey ?? `mock-${digest([account, companyId, messageId])}`;
    let id = previous?.id;
    if (previous) {
      db.prepare("UPDATE email_deliveries SET state = 'claimed', updated_at = ? WHERE id = ?").run(now, id);
    } else {
      id = db.prepare(`
        INSERT INTO email_deliveries (
          company_id, message_id, recipient, provider, provider_account, idempotency_key,
          payload_hash, state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?)
      `).run(companyId, messageId, recipient, MOCK_PROVIDER, account, idempotencyKey, payloadHash, now).lastInsertRowid;
    }
    db.prepare(`
      INSERT INTO email_delivery_attempts (delivery_id, number, claimed_at) VALUES (?, ?, ?)
    `).run(id, number, now);

    return {
      state: "start", id, number, request: { idempotencyKey, envelope },
    };
  });
}

function finish(db, account, { id, number }, outcome) {
  return immediateTransaction(db, () => {
    const delivery = db.prepare(`
      SELECT state, provider_message_id AS providerMessageId FROM email_deliveries WHERE id = ?
    `).get(id);
    if (delivery.state !== "claimed") {
      // An authenticated event may have proved acceptance while the response was pending.
      if (outcome.providerMessageId && outcome.providerMessageId !== delivery.providerMessageId) {
        return { state: "conflict" };
      }
      return { state: delivery.state };
    }

    let { state, providerMessageId = null, code = null } = outcome;
    if (providerMessageId && db.prepare(`
      SELECT 1 FROM email_deliveries WHERE provider = ? AND provider_account = ? AND provider_message_id = ?
    `).get(MOCK_PROVIDER, account, providerMessageId)) {
      state = "ambiguous";
      code = "UNCONFIRMED_RESPONSE";
      providerMessageId = null;
    }
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE email_delivery_attempts SET finished_at = max(claimed_at, ?), outcome = ?, error_code = ?
      WHERE delivery_id = ? AND number = ? AND finished_at IS NULL
    `).run(now, state, code, id, number);
    if (update.changes !== 1) throw new Error("Mock delivery attempt was lost");
    db.prepare(`
      UPDATE email_deliveries SET state = ?, provider_message_id = ?, updated_at = max(updated_at, ?)
      WHERE id = ?
    `).run(state, providerMessageId, now, id);
    return { state };
  });
}

// The application does not install the ledger or invoke this mock workflow.
export async function attemptDelivery(db, { mode, mock, account = DEFAULT_MOCK_ACCOUNT, ...options } = {}) {
  if (mode !== "mock" && !isRealDeliveryEnabled()) return { state: "disabled" };
  if (mode !== "mock") return { state: "unsupported" };
  if (!isMockAccount(account)) throw new Error("Invalid mock delivery account");

  const submit = createMockDeliveryTransport(mock);
  const delivery = claim(db, account, options);
  if (delivery.state !== "start") return delivery;

  const outcome = await submit(delivery.request);
  return finish(db, account, delivery, outcome);
}
