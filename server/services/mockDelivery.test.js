import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrateEmailDeliveryLedger } from "../database/emailDeliveryMigration.js";
import { getDeliveryPreflight } from "./deliveryPreflight.js";
import { attemptDelivery } from "./mockDelivery.js";
import { createMockDeliveryWebhook } from "./mockDeliveryWebhook.js";
import { NOW, RECIPIENT, deliveryOptions, fixture, senderDomain, setup } from "./fixtures/mockDeliveryDatabase.js";

const SIGNING_KEY = Buffer.alloc(32, 7);
const SIGNED_AT = Date.parse(NOW);
const ingest = createMockDeliveryWebhook({ secret: SIGNING_KEY, clock: () => SIGNED_AT });

function signed(eventId, fields = {}, {
  account = "mock-default", timestamp = String(SIGNED_AT / 1000),
  rawBody = Buffer.from(JSON.stringify({ type: "delivered", providerMessageId: "mock-a", recipient: RECIPIENT, ...fields })),
} = {}) {
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(`mock-v1.${account}.${timestamp}.${eventId}.`).update(rawBody).digest("hex");
  return { eventId, rawBody, timestamp, signature };
}

function states(db) {
  return db.prepare(`
    SELECT state, (SELECT count(*) FROM email_delivery_attempts WHERE delivery_id = d.id) AS attempts
    FROM email_deliveries d ORDER BY message_id
  `).all()
    .map(({ state, attempts }) => [state, attempts]);
}

test("real delivery is closed even with technically valid configuration and an injected responder", async (t) => {
  const db = fixture(t);
  const options = { ...deliveryOptions(), mock: { respond: () => assert.fail("transport called") } };
  const preflight = getDeliveryPreflight(db, options);
  assert.equal(preflight.technicalChecksPassed, true);
  assert.equal(preflight.deliveryEnabled, false);
  assert.deepEqual(await attemptDelivery(db, { ...options, mode: "real" }), { state: "disabled" });
  assert.deepEqual(await attemptDelivery(null), { state: "disabled" });
  assert.deepEqual(await attemptDelivery(null, { ...options, mode: "resend" }), { state: "disabled" });
  assert.deepEqual(states(db), []);
});

test("mock delivery uses structured sender fields and never replays a committed acceptance", async (t) => {
  const db = fixture(t);
  let calls = 0;
  const options = { ...deliveryOptions(), mock: { respond({ envelope }) {
    calls += 1;
    assert.deepEqual(envelope.from, { address: `quotes@${senderDomain("a")}`, name: 'Equipment, "Rental"' });
    assert.equal(envelope.replyTo, `office@${senderDomain("a")}`);
    assert.equal(envelope.to, RECIPIENT);
    assert.equal(envelope.subject, "Follow-up");
    return Response.json({ id: "mock-accepted" });
  } } };
  assert.deepEqual(await attemptDelivery(db, options), { state: "accepted" });
  assert.deepEqual(await attemptDelivery(db, options), { state: "accepted" });
  assert.equal(calls, 1);
  assert.deepEqual(states(db), [["accepted", 1]]);
  assert.equal(db.prepare("SELECT status FROM delivery_queue WHERE id = 'queue-a'").get().status, "approved");
});

test("final claim rejects cross-company queue IDs and state changed since preflight", async (t) => {
  const db = fixture(t);
  assert.equal(getDeliveryPreflight(db, deliveryOptions()).technicalChecksPassed, true);
  assert.deepEqual(await attemptDelivery(db, deliveryOptions("b", "queue-a")), { state: "not_found" });

  for (const sql of [
    "UPDATE quotes SET status = 'Accepted' WHERE id = 'a'",
    "UPDATE delivery_queue SET status = 'cancelled' WHERE id = 'queue-a'",
    "UPDATE quote_contacts SET opted_out = 1 WHERE quote_id = 'a'",
    "INSERT INTO recipient_suppressions VALUES ('a', 'shared@example.test', 'now')",
    "UPDATE unsubscribe_tokens SET used_at = 'now' WHERE quote_id = 'a'",
    "UPDATE unsubscribe_tokens SET expires_at = '2026-11-23T12:00:00Z' WHERE quote_id = 'a'",
    "UPDATE sender_domain_verifications SET last_check_result = 'TXT_NOT_FOUND' WHERE company_id = 'a'",
    "UPDATE company_sender_settings SET reply_to_email = 'office,other@sender-a.rentflow.invalid-domain.com' WHERE company_id = 'a'",
  ]) {
    // Use fresh fixtures because the claim owns its transaction boundary.
    const changed = fixture(t);
    changed.exec(sql);
    assert.deepEqual(await attemptDelivery(changed, deliveryOptions()), { state: "blocked" }, sql);
    assert.deepEqual(states(changed), []);
  }
  assert.deepEqual(await attemptDelivery(db, {
    ...deliveryOptions(), providerConfig: { provider: "resend", fromEmail: "quotes@foreign.example.test" },
  }), { state: "blocked" });
});

test("definitive mock rejection is bounded and retries preserve key and payload", async (t) => {
  const db = fixture(t);
  const requests = [];
  const options = { ...deliveryOptions(), mock: { respond(request) {
    requests.push(request);
    return new Response(null, { status: 429 });
  } } };
  assert.deepEqual(await attemptDelivery(db, options), { state: "rejected" });
  db.exec("UPDATE outbound_messages SET subject = 'Changed' WHERE id = 'message-a'");
  assert.deepEqual(await attemptDelivery(db, options), { state: "blocked" });
  db.exec("UPDATE outbound_messages SET subject = 'Follow-up' WHERE id = 'message-a'");
  assert.deepEqual(await attemptDelivery(db, options), { state: "rejected" });
  assert.deepEqual(await attemptDelivery(db, options), { state: "rejected" });
  assert.deepEqual(await attemptDelivery(db, options), { state: "rejected" });
  assert.deepEqual(requests, [requests[0], requests[0], requests[0]]);
  assert.deepEqual(states(db), [["rejected", 3]]);
  assert.equal(db.prepare("SELECT idempotency_key FROM email_deliveries").get().idempotency_key, requests[0].idempotencyKey);
  const attempts = db.prepare("SELECT * FROM email_delivery_attempts ORDER BY number").all();
  assert.deepEqual(attempts.map(({ number, outcome, error_code }) => [number, outcome, error_code]), [
    [1, "rejected", "RATE_LIMITED"], [2, "rejected", "RATE_LIMITED"], [3, "rejected", "RATE_LIMITED"],
  ]);
  assert.ok(attempts.every(({ claimed_at, finished_at }) => Date.parse(claimed_at) <= Date.parse(finished_at)));
});

test("a rejected mock attempt can later succeed, while a timeout or malformed response stays held", async (t) => {
  const db = fixture(t);
  assert.deepEqual(await attemptDelivery(db, {
    ...deliveryOptions(), mock: { respond: () => new Response(null, { status: 429 }) },
  }), { state: "rejected" });
  assert.deepEqual(await attemptDelivery(db, deliveryOptions()), { state: "accepted" });

  let signal;
  const options = { ...deliveryOptions("b"), mock: { timeoutMs: 10, respond(_request, abortSignal) {
    signal = abortSignal;
    return new Promise(() => {});
  } } };
  assert.deepEqual(await attemptDelivery(db, options), { state: "ambiguous" });
  assert.equal(signal.aborted, true);
  assert.deepEqual(await attemptDelivery(db, deliveryOptions("b")), { state: "ambiguous" });
  assert.deepEqual(await attemptDelivery(db, {
    ...deliveryOptions("a", "queue-next"), mock: { respond: () => Response.json({}) },
  }), { state: "ambiguous" });
  assert.deepEqual(states(db), [["accepted", 2], ["ambiguous", 1], ["ambiguous", 1]]);
  assert.deepEqual(db.prepare(`
    SELECT error_code FROM email_delivery_attempts WHERE outcome = 'ambiguous' ORDER BY delivery_id
  `).all().map(({ error_code }) => error_code), ["TIMEOUT", "UNCONFIRMED_RESPONSE"]);
});

test("a suppression committed after definitive rejection prevents the next attempt", async (t) => {
  const db = fixture(t);
  const options = { ...deliveryOptions(), mock: { respond: () => new Response(null, { status: 429 }) } };
  assert.deepEqual(await attemptDelivery(db, options), { state: "rejected" });
  db.prepare("INSERT INTO recipient_suppressions VALUES (?, ?, ?)").run("a", RECIPIENT, NOW);
  assert.deepEqual(await attemptDelivery(db, deliveryOptions()), { state: "blocked" });
  assert.deepEqual(states(db), [["rejected", 1]]);
});

test("separate processes share a claim and a killed claimant is held across restart", { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-mock-delivery-"));
  const path = join(directory, "fixture.sqlite");
  const writer = new DatabaseSync(path);
  setup(writer);
  writer.close();
  const worker = fileURLToPath(new URL("./fixtures/mockDeliveryWorker.js", import.meta.url));
  const child = fork(worker, [path], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    unlinkSync(path);
    rmdirSync(directory);
  });
  const signal = AbortSignal.timeout(5000);
  const [message] = await once(child, "message", { signal });
  assert.equal(message.providerMessageId, "mock-worker-accepted");
  const competing = new DatabaseSync(path);
  try {
    assert.deepEqual(await attemptDelivery(competing, deliveryOptions()), { state: "claimed" });
  } finally {
    competing.close();
  }
  assert.equal(child.kill(), true);
  await exited;
  const reopened = new DatabaseSync(path);
  const event = signed("restart-proof", message);
  try {
    assert.deepEqual(await attemptDelivery(reopened, deliveryOptions()), { state: "claimed" });
    assert.deepEqual(states(reopened), [["claimed", 1]]);
    assert.equal(reopened.prepare("SELECT idempotency_key FROM email_deliveries").get().idempotency_key,
      message.idempotencyKey);
    assert.deepEqual(ingest(reopened, event), { state: "recorded" });
    assert.deepEqual(await attemptDelivery(reopened, deliveryOptions()), { state: "accepted" });
    assert.deepEqual(states(reopened), [["accepted", 1]]);
    assert.equal(reopened.prepare("SELECT outcome FROM email_delivery_attempts").get().outcome, "accepted");
  } finally {
    reopened.close();
  }

  const replay = fork(worker, [path, "replay"], {
    serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const replayExit = once(replay, "exit");
  try {
    const response = once(replay, "message", { signal: AbortSignal.timeout(5000) });
    replay.send(event);
    const [result] = await response;
    assert.deepEqual(result, { state: "duplicate" });
  } finally {
    if (replay.exitCode === null && replay.signalCode === null) replay.kill();
    await replayExit;
  }
});

for (const type of ["hard_bounce", "complaint"]) {
  test(`${type} mock events are deduplicated and suppress only the stored tenant and recipient`, async (t) => {
    const db = fixture(t);
    const options = { ...deliveryOptions(), mock: { respond: () => Response.json({ id: "mock-a" }) } };
    assert.deepEqual(await attemptDelivery(db, options), { state: "accepted" });
    const record = ({ eventId, ...fields }) => ingest(db, signed(eventId, {
      companyId: "b", email: "other@example.test", ...fields,
    }));
    assert.deepEqual(record({ eventId: "unknown", type, providerMessageId: "mock-missing" }), { state: "unmatched" });
    assert.deepEqual(record({ eventId: "soft", type: "soft_bounce" }), { state: "recorded" });
    assert.equal(db.prepare("SELECT count(*) AS count FROM recipient_suppressions").get().count, 0);
    assert.deepEqual(record({ eventId: "target", type }), { state: "recorded" });
    assert.deepEqual(record({ eventId: "target", type }), { state: "duplicate" });
    assert.deepEqual(record({ eventId: "target", type: "delivered" }), { state: "conflict" });
    assert.deepEqual(record({ eventId: "late", type: "delivered" }), { state: "recorded" });
    assert.deepEqual(db.prepare("SELECT company_id, email FROM recipient_suppressions").all()
      .map(({ company_id, email }) => [company_id, email]), [["a", RECIPIENT]]);
    assert.equal(db.prepare("SELECT count(*) AS count FROM email_delivery_events").get().count, 3);
    assert.equal(db.prepare("SELECT state FROM email_deliveries").get().state,
      type === "hard_bounce" ? "bounced" : "complained");
    assert.deepEqual(await attemptDelivery(db, deliveryOptions("a", "queue-next")), { state: "blocked" });
    assert.deepEqual(await attemptDelivery(db, deliveryOptions("b")), { state: "accepted" });
  });
}

test("event deduplication rolls back if suppression cannot be saved", async (t) => {
  const db = fixture(t);
  const options = { ...deliveryOptions(), mock: { respond: () => Response.json({ id: "mock-a" }) } };
  assert.deepEqual(await attemptDelivery(db, options), { state: "accepted" });
  db.exec(`
    CREATE TRIGGER fail_suppression BEFORE INSERT ON recipient_suppressions
    BEGIN SELECT RAISE(ABORT, 'injected suppression failure'); END;
  `);
  const event = signed("bounce", { type: "hard_bounce" });
  assert.throws(() => ingest(db, event), /injected suppression failure/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM email_delivery_events").get().count, 0);
  assert.deepEqual(states(db), [["accepted", 1]]);
  db.exec("DROP TRIGGER fail_suppression");
  assert.deepEqual(ingest(db, event), { state: "recorded" });
});

test("ledger migration is additive and repeatable on a simulation-era database", (t) => {
  const db = fixture(t, { migrate: false });
  db.exec("INSERT INTO delivery_attempts VALUES ('original', 'queue-b', 'simulated')");
  const queue = db.prepare("SELECT * FROM delivery_queue ORDER BY id").all();
  const simulations = db.prepare("SELECT * FROM delivery_attempts").all();
  assert.deepEqual(migrateEmailDeliveryLedger(db), { version: 2, applied: true });
  assert.deepEqual(migrateEmailDeliveryLedger(db), { version: 2, applied: false });
  assert.deepEqual(db.prepare("SELECT * FROM delivery_queue ORDER BY id").all(), queue);
  assert.deepEqual(db.prepare("SELECT * FROM delivery_attempts").all(), simulations);
  assert.deepEqual(states(db), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => db.prepare(`
    INSERT INTO email_deliveries (company_id, message_id, recipient, provider, provider_account,
      idempotency_key, payload_hash, state, updated_at)
    VALUES ('b', 'message-a', ?, 'mock', 'mock-default', 'key', ?, 'claimed', ?)
  `).run(RECIPIENT, "a".repeat(64), NOW), /ownership mismatch/);
});

test("ledger migration rolls back partial DDL and refuses unsupported schema versions", (t) => {
  const db = fixture(t, { migrate: false });
  db.exec("CREATE TABLE email_delivery_events (unexpected TEXT)");
  assert.throws(() => migrateEmailDeliveryLedger(db), /already exists/);
  assert.deepEqual(db.prepare(`
    SELECT name FROM sqlite_schema WHERE name LIKE 'email_deliver%' ORDER BY name
  `).all().map(({ name }) => name), ["email_delivery_events"]);
  db.exec("CREATE TABLE email_delivery_schema (version INTEGER PRIMARY KEY); INSERT INTO email_delivery_schema VALUES (3)");
  assert.throws(() => migrateEmailDeliveryLedger(db), /Unsupported email delivery schema version/);
  db.exec("PRAGMA foreign_keys = OFF");
  assert.throws(() => migrateEmailDeliveryLedger(db), /requires foreign keys/);
});

test("webhook authentication binds exact bytes, account, event ID and fresh timestamp", async (t) => {
  const db = fixture(t);
  await attemptDelivery(db, { ...deliveryOptions(), mock: { respond: () => Response.json({ id: "mock-a" }) } });
  const valid = signed("authenticated", { type: "complaint" });
  assert.deepEqual(ingest(db, { ...valid, rawBody: Buffer.concat([valid.rawBody, Buffer.from(" ")]) }),
    { state: "unauthenticated" });
  assert.deepEqual(ingest(db, { ...valid, eventId: "other" }), { state: "unauthenticated" });
  assert.deepEqual(ingest(db, signed("wrong-account", {}, { account: "elsewhere" })), { state: "unauthenticated" });
  for (const skew of [-301, 301]) {
    assert.deepEqual(ingest(db, signed("stale", {}, { timestamp: String(SIGNED_AT / 1000 + skew) })),
      { state: "unauthenticated" });
  }
  assert.deepEqual(ingest(db, { ...valid, rawBody: valid.rawBody.toString() }), { state: "invalid" });
  assert.deepEqual(ingest(db, { ...valid, rawBody: Buffer.alloc(16 * 1024 + 1) }), { state: "invalid" });
  assert.deepEqual(ingest(db, signed("bad-json", {}, { rawBody: Buffer.from("{") })), { state: "invalid" });
  assert.deepEqual(ingest(db, signed("bad-recipient", { recipient: "other@example.test", type: "complaint" })),
    { state: "conflict" });
  assert.deepEqual(states(db), [["accepted", 1]]);
  assert.equal(db.prepare("SELECT count(*) AS count FROM email_delivery_events").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM recipient_suppressions").get().count, 0);
  assert.deepEqual(ingest(db, valid), { state: "recorded" });
});

test("provider IDs and replay receipts are account scoped and complaints outrank late bounces", async (t) => {
  const db = fixture(t);
  const mock = { respond: () => Response.json({ id: "mock-a" }) };
  for (const [company, account] of [["a", "mock-default"], ["b", "other-account"]]) {
    assert.deepEqual(await attemptDelivery(db, { ...deliveryOptions(company), account, mock }), { state: "accepted" });
  }
  const other = createMockDeliveryWebhook({ secret: SIGNING_KEY, account: "other-account", clock: () => SIGNED_AT });
  assert.deepEqual(ingest(db, signed("shared-id", { type: "complaint" })), { state: "recorded" });
  assert.deepEqual(other(db, signed("shared-id", {}, { account: "other-account" })), { state: "recorded" });
  assert.deepEqual(ingest(db, signed("late-bounce", { type: "hard_bounce" })), { state: "recorded" });
  const wrongKey = db.prepare("SELECT idempotency_key FROM email_deliveries WHERE company_id = 'b'").get().idempotency_key;
  assert.deepEqual(ingest(db, signed("foreign-key", { idempotencyKey: wrongKey, type: "complaint" })), { state: "conflict" });
  assert.deepEqual(states(db), [["complained", 1], ["accepted", 1]]);
  assert.deepEqual(db.prepare("SELECT company_id FROM recipient_suppressions").all().map(({ company_id }) => company_id), ["a"]);
});

test("signed evidence resolves an ambiguous attempt without erasing the timeout or resubmitting", async (t) => {
  const db = fixture(t);
  const mock = { timeoutMs: 5, respond: () => new Promise(() => {}) };
  assert.deepEqual(await attemptDelivery(db, { ...deliveryOptions(), mock }), { state: "ambiguous" });
  const { idempotency_key: key } = db.prepare("SELECT idempotency_key FROM email_deliveries").get();
  assert.deepEqual(ingest(db, signed("missing-key")), { state: "unmatched" });
  const confirmation = signed("correlated", { idempotencyKey: key });
  assert.deepEqual(ingest(db, confirmation), { state: "recorded" });
  assert.deepEqual(ingest(db, confirmation), { state: "duplicate" });
  assert.deepEqual(await attemptDelivery(db, deliveryOptions()), { state: "accepted" });
  const attempt = db.prepare("SELECT outcome, error_code FROM email_delivery_attempts").get();
  assert.equal(attempt.outcome, "ambiguous");
  assert.equal(attempt.error_code, "TIMEOUT");
  assert.deepEqual(states(db), [["accepted", 1]]);
});

test("a signed event arriving during handoff prevents the later timeout from overwriting acceptance", async (t) => {
  const db = fixture(t);
  let eventOutcome;
  const mock = { timeoutMs: 10, respond: ({ idempotencyKey }) => {
    eventOutcome = ingest(db, signed("during-handoff", { idempotencyKey, type: "hard_bounce" }));
    return new Promise(() => {});
  } };
  assert.deepEqual(await attemptDelivery(db, { ...deliveryOptions(), mock }), { state: "bounced" });
  assert.deepEqual(eventOutcome, { state: "recorded" });
  assert.deepEqual(states(db), [["bounced", 1]]);
  assert.equal(db.prepare("SELECT outcome FROM email_delivery_attempts").get().outcome, "accepted");
});

test("queue cancellation closes a rejected ledger entry without rewriting attempt history", async (t) => {
  const db = fixture(t);
  const mock = { respond: () => new Response(null, { status: 429 }) };
  assert.deepEqual(await attemptDelivery(db, { ...deliveryOptions(), mock }), { state: "rejected" });
  db.exec("UPDATE delivery_queue SET status = 'cancelled' WHERE id = 'queue-a'");
  assert.deepEqual(await attemptDelivery(db, deliveryOptions()), { state: "cancelled" });
  const { idempotency_key: key } = db.prepare("SELECT idempotency_key FROM email_deliveries").get();
  assert.deepEqual(ingest(db, signed("cancelled-conflict", { idempotencyKey: key, type: "complaint" })),
    { state: "conflict" });
  assert.equal(db.prepare("SELECT outcome FROM email_delivery_attempts").get().outcome, "rejected");
  assert.deepEqual(states(db), [["cancelled", 1]]);
});
