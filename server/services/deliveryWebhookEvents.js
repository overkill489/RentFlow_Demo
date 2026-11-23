import { immediateTransaction } from "../database/immediateTransaction.js";

export function recordDeliveryEvent(db, provider, account, event) {
  return immediateTransaction(db, () => {
    const prior = db.prepare(`
      SELECT body_hash AS bodyHash FROM email_delivery_events
      WHERE provider = ? AND provider_account = ? AND event_id = ?
    `).get(provider, account, event.id);
    if (prior) return { state: prior.bodyHash === event.bodyHash ? "duplicate" : "conflict" };

    const matches = db.prepare(`
      SELECT id, company_id AS companyId, recipient, state, provider_message_id AS providerMessageId,
        idempotency_key AS idempotencyKey
      FROM email_deliveries WHERE provider = ? AND provider_account = ?
        AND (provider_message_id = ? OR idempotency_key = ?)
    `).all(provider, account, event.providerMessageId, event.idempotencyKey);
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
    `).run(provider, account, event.id, delivery.id, event.type, event.bodyHash, event.receivedAt);
    if (delivery.state === "claimed") {
      const attempt = db.prepare(`
        UPDATE email_delivery_attempts SET outcome = 'accepted', finished_at = max(claimed_at, ?)
        WHERE delivery_id = ? AND finished_at IS NULL
      `).run(event.receivedAt, delivery.id);
      if (attempt.changes !== 1) throw new Error("Delivery claim has no open attempt");
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
