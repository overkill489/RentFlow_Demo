import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getDeliveryPreflight } from "./deliveryPreflight.js";
import { attemptDelivery, recordVerifiedMockDeliveryEvent } from "./mockDelivery.js";
import { installSenderIdentitySchema, saveSenderIdentity } from "./senderIdentity.js";
import {
  installSenderVerificationSchema,
  prepareSenderDomainVerification,
} from "./senderVerification.js";
import { createUnsubscribeToken, installUnsubscribeSchema } from "./unsubscribeService.js";

const DUE = "2026-11-23T12:00:00.000Z";
const NOW = "2026-11-23T12:01:00Z";
const RECIPIENT = "shared@example.test";

function senderDomain(tenant) {
  return `sender-${tenant}.rentflow.invalid-domain.com`;
}

function deliveryOptions(companyId = "a", queueId = `queue-${companyId}`) {
  return {
    mode: "mock",
    companyId,
    queueId,
    currentTime: NOW,
    providerConfig: { provider: "resend", fromEmail: `quotes@${senderDomain(companyId)}` },
  };
}

function setup(db) {
  db.exec(`
    CREATE TABLE companies (id TEXT PRIMARY KEY);
    CREATE TABLE quotes (id TEXT PRIMARY KEY, company_id TEXT, customer TEXT, equipment TEXT, status TEXT);
    CREATE TABLE follow_ups (quote_id TEXT PRIMARY KEY, scheduled_at TEXT);
    CREATE TABLE quote_contacts (quote_id TEXT PRIMARY KEY, email TEXT, opted_out INTEGER);
    CREATE TABLE outbound_messages (id TEXT PRIMARY KEY, quote_id TEXT, recipient_email TEXT,
      subject TEXT, body TEXT, status TEXT, created_at TEXT);
    CREATE TABLE delivery_queue (id TEXT PRIMARY KEY, message_id TEXT UNIQUE, status TEXT);
    CREATE TABLE recipient_suppressions (company_id TEXT REFERENCES companies(id), email TEXT,
      created_at TEXT, PRIMARY KEY (company_id, email));

    CREATE TABLE mock_delivery_claims (
      company_id TEXT NOT NULL REFERENCES companies(id),
      message_id TEXT NOT NULL REFERENCES outbound_messages(id),
      recipient TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_flight', 'accepted', 'retryable', 'uncertain', 'exhausted')),
      attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 3),
      provider_message_id TEXT UNIQUE,
      CHECK ((state = 'accepted') = (provider_message_id IS NOT NULL)),
      PRIMARY KEY (company_id, message_id)
    );
    CREATE TABLE mock_delivery_events (
      event_id TEXT PRIMARY KEY,
      provider_message_id TEXT NOT NULL REFERENCES mock_delivery_claims(provider_message_id),
      type TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
  `);
  installUnsubscribeSchema(db);
  installSenderIdentitySchema(db);
  installSenderVerificationSchema(db);

  for (const tenant of ["a", "b"]) {
    db.prepare("INSERT INTO companies VALUES (?)").run(tenant);
    assert.equal(saveSenderIdentity(db, tenant, {
      displayName: 'Equipment, "Rental"', replyToEmail: `office@${senderDomain(tenant)}`,
    }, DUE).success, true);
    assert.equal(prepareSenderDomainVerification(db, tenant, DUE).success, true);
    db.prepare(`
      UPDATE sender_domain_verifications SET verified_at = ?, last_checked_at = ?,
        last_check_result = 'TXT_MATCH' WHERE company_id = ?
    `).run(DUE, DUE, tenant);
  }
  for (const [id, tenant] of [["a", "a"], ["b", "b"], ["next", "a"]]) {
    db.prepare("INSERT INTO quotes VALUES (?, ?, 'Fictional customer', 'Lift', 'Follow-up Scheduled')").run(id, tenant);
    db.prepare("INSERT INTO follow_ups VALUES (?, ?)").run(id, DUE);
    db.prepare("INSERT INTO quote_contacts VALUES (?, ?, 0)").run(id, RECIPIENT);
    const { token } = createUnsubscribeToken(db, {
      companyId: tenant, quoteId: id, email: RECIPIENT, currentTime: DUE,
    });
    db.prepare("INSERT INTO outbound_messages VALUES (?, ?, ?, 'Follow-up', ?, 'draft', ?)")
      .run(`message-${id}`, id, RECIPIENT, `https://staging.example.test/api/unsubscribe/${token}`, DUE);
    db.prepare("INSERT INTO delivery_queue VALUES (?, ?, 'approved')").run(`queue-${id}`, `message-${id}`);
  }
}

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  setup(db);
  return db;
}

function states(db) {
  return db.prepare("SELECT state, attempts FROM mock_delivery_claims ORDER BY message_id").all()
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
  assert.deepEqual(await attemptDelivery(db, options), { state: "retryable" });
  db.exec("UPDATE outbound_messages SET subject = 'Changed' WHERE id = 'message-a'");
  assert.deepEqual(await attemptDelivery(db, options), { state: "blocked" });
  db.exec("UPDATE outbound_messages SET subject = 'Follow-up' WHERE id = 'message-a'");
  assert.deepEqual(await attemptDelivery(db, options), { state: "retryable" });
  assert.deepEqual(await attemptDelivery(db, options), { state: "exhausted" });
  assert.deepEqual(await attemptDelivery(db, options), { state: "exhausted" });
  assert.deepEqual(requests, [requests[0], requests[0], requests[0]]);
  assert.deepEqual(states(db), [["exhausted", 3]]);
});

test("a rejected mock attempt can later succeed, while a timeout or malformed response stays held", async (t) => {
  const db = fixture(t);
  assert.deepEqual(await attemptDelivery(db, {
    ...deliveryOptions(), mock: { respond: () => new Response(null, { status: 429 }) },
  }), { state: "retryable" });
  assert.deepEqual(await attemptDelivery(db, deliveryOptions()), { state: "accepted" });

  let signal;
  const options = { ...deliveryOptions("b"), mock: { timeoutMs: 10, respond(_request, abortSignal) {
    signal = abortSignal;
    return new Promise(() => {});
  } } };
  assert.deepEqual(await attemptDelivery(db, options), { state: "uncertain" });
  assert.equal(signal.aborted, true);
  assert.deepEqual(await attemptDelivery(db, deliveryOptions("b")), { state: "uncertain" });
  assert.deepEqual(await attemptDelivery(db, {
    ...deliveryOptions("a", "queue-next"), mock: { respond: () => Response.json({}) },
  }), { state: "uncertain" });
  assert.deepEqual(states(db), [["accepted", 2], ["uncertain", 1], ["uncertain", 1]]);
});

test("a suppression committed after definitive rejection prevents the next attempt", async (t) => {
  const db = fixture(t);
  const options = { ...deliveryOptions(), mock: { respond: () => new Response(null, { status: 429 }) } };
  assert.deepEqual(await attemptDelivery(db, options), { state: "retryable" });
  db.prepare("INSERT INTO recipient_suppressions VALUES (?, ?, ?)").run("a", RECIPIENT, NOW);
  assert.deepEqual(await attemptDelivery(db, deliveryOptions()), { state: "blocked" });
  assert.deepEqual(states(db), [["retryable", 1]]);
});

test("separate processes share a claim and a killed claimant is held across restart", { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-mock-delivery-"));
  const path = join(directory, "fixture.sqlite");
  const writer = new DatabaseSync(path);
  setup(writer);
  writer.close();
  const child = fork(fileURLToPath(new URL("./fixtures/mockDeliveryWorker.js", import.meta.url)), [path], {
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
  assert.equal(message, "claimed");
  const competing = new DatabaseSync(path);
  try {
    assert.deepEqual(await attemptDelivery(competing, deliveryOptions()), { state: "in_flight" });
  } finally {
    competing.close();
  }
  assert.equal(child.kill(), true);
  await exited;
  const reopened = new DatabaseSync(path);
  try {
    assert.deepEqual(await attemptDelivery(reopened, deliveryOptions()), { state: "in_flight" });
    assert.deepEqual(states(reopened), [["in_flight", 1]]);
  } finally {
    reopened.close();
  }
});

for (const type of ["hard_bounce", "complaint"]) {
  test(`${type} mock events are deduplicated and suppress only the stored tenant and recipient`, async (t) => {
    const db = fixture(t);
    const options = { ...deliveryOptions(), mock: { respond: () => Response.json({ id: "mock-a" }) } };
    assert.deepEqual(await attemptDelivery(db, options), { state: "accepted" });
    const record = (event) => recordVerifiedMockDeliveryEvent(db, {
      currentTime: NOW, providerMessageId: "mock-a", companyId: "b", email: "other@example.test", ...event,
    });
    assert.deepEqual(record({ eventId: "unknown", type, providerMessageId: "mock-missing" }), { state: "unmatched" });
    assert.deepEqual(record({ eventId: "soft", type: "soft_bounce" }), { state: "recorded" });
    assert.equal(db.prepare("SELECT count(*) AS count FROM recipient_suppressions").get().count, 0);
    assert.deepEqual(record({ eventId: "target", type }), { state: "recorded" });
    assert.deepEqual(record({ eventId: "target", type }), { state: "duplicate" });
    assert.deepEqual(record({ eventId: "late", type: "delivered" }), { state: "recorded" });
    assert.deepEqual(db.prepare("SELECT company_id, email FROM recipient_suppressions").all()
      .map(({ company_id, email }) => [company_id, email]), [["a", RECIPIENT]]);
    assert.equal(db.prepare("SELECT count(*) AS count FROM mock_delivery_events").get().count, 3);
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
  const event = { eventId: "bounce", providerMessageId: "mock-a", type: "hard_bounce", currentTime: NOW };
  assert.throws(() => recordVerifiedMockDeliveryEvent(db, event), /injected suppression failure/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM mock_delivery_events").get().count, 0);
  db.exec("DROP TRIGGER fail_suppression");
  assert.deepEqual(recordVerifiedMockDeliveryEvent(db, event), { state: "recorded" });
});
