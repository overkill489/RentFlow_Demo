import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateEmailDeliveryLedger } from "../database/emailDeliveryMigration.js";
import { NOW, RECIPIENT, fixture, senderDomain, setup } from "./fixtures/mockDeliveryDatabase.js";
import { createResendDelivery, createResendFixtureDelivery } from "./resendDelivery.js";
import { createResendWebhook } from "./resendWebhook.js";

const MESSAGE = "56761188-7520-42d8-8898-ff6fc54ce618";
const OTHER_MESSAGE = "67061188-7520-42d8-8898-ff6fc54ce618";
const SIGNED_AT = Date.parse(NOW);
const KEY = Buffer.alloc(32, 25);
const SECRET = `whsec_${KEY.toString("base64")}`;
const ingest = createResendWebhook({ account: "account-a", secret: SECRET, clock: () => SIGNED_AT });
const queue = { queueId: "queue-a", currentTime: NOW };

function config(request, companyId = "a") {
  return { companyId, account: `account-${companyId}`, fromEmail: `quotes@${senderDomain(companyId)}`, request };
}

function signed(id, {
  type = "email.delivered", data = {}, timestamp = String(SIGNED_AT / 1000),
  rawBody = Buffer.from(JSON.stringify({ type, data: { email_id: MESSAGE, to: [RECIPIENT], ...data } })),
} = {}) {
  const digest = createHmac("sha256", KEY).update(`${id}.${timestamp}.`).update(rawBody).digest("base64");
  return { rawBody, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${digest}` } };
}

function delivery(db) {
  return db.prepare("SELECT * FROM email_deliveries WHERE company_id = 'a'").get();
}

test("Resend production delivery is gated before SQLite and HTTP and validates configuration", async () => {
  const unexpected = () => assert.fail("HTTP executed while disabled");
  const production = { ...config(unexpected), apiKey: "re_synthetic_configuration_example" };
  assert.deepEqual(await createResendDelivery(production)(null, queue), { state: "disabled" });
  for (const invalid of [
    { account: "account.with.dots" }, { companyId: "" }, { fromEmail: "x,b@example.test" },
    { timeoutMs: 0 }, { request: undefined }, { apiKey: "re_example\r\nHeader: x" },
  ]) assert.throws(() => createResendDelivery({ ...production, ...invalid }), /Resend .*configuration/);
  assert.throws(() => createResendFixtureDelivery(production), /credential configuration/);
});

test("Resend serializes a single approved message and persists its exact stable idempotency key", async (t) => {
  const db = fixture(t);
  const calls = [];
  const send = createResendFixtureDelivery(config((url, request) => {
    calls.push({ url, request });
    return Response.json({ id: MESSAGE });
  }));
  assert.deepEqual(await send(db, queue), { state: "accepted" });
  assert.deepEqual(await send(db, queue), { state: "accepted" });
  assert.equal(calls.length, 1);
  const [{ url, request }] = calls;
  const record = delivery(db);
  assert.equal(record.provider, "resend");
  assert.equal(record.provider_message_id, MESSAGE);
  assert.match(record.idempotency_key, /^resend-[a-f0-9]{64}$/);
  assert.equal(url, "https://resend.invalid/emails");
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.equal(request.headers.Authorization, "Bearer re_rentflow_fixture_only");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["Idempotency-Key"], record.idempotency_key);
  const { body } = db.prepare("SELECT body FROM outbound_messages WHERE id = 'message-a'").get();
  assert.deepEqual(JSON.parse(request.body), {
    from: `"Equipment, \\"Rental\\"" <quotes@${senderDomain("a")}>`, to: [RECIPIENT],
    reply_to: `office@${senderDomain("a")}`, subject: "Follow-up", text: body,
    tags: [{ name: "rentflow_delivery", value: record.idempotency_key }],
  });
});

test("Resend claim repeats preflight and binds the company before calling the responder", async (t) => {
  const db = fixture(t);
  let calls = 0;
  const send = createResendFixtureDelivery(config(() => { calls += 1; }));
  assert.deepEqual(await send(db, { ...queue, queueId: "queue-b" }), { state: "not_found" });
  db.exec("UPDATE sender_domain_verifications SET last_check_result = 'TXT_NOT_FOUND' WHERE company_id = 'a'");
  assert.deepEqual(await send(db, queue), { state: "blocked" });
  assert.equal(delivery(db), undefined);
  assert.equal(calls, 0);
});

test("Resend classifies documented errors conservatively and never repeats an attempt", async (t) => {
  for (const [status, name, state, code] of [
    [401, "validation_error", "rejected", "PROVIDER_REJECTED"],
    [403, "validation_error", "rejected", "PROVIDER_REJECTED"],
    [429, "rate_limit_exceeded", "rejected", "RATE_LIMITED"],
    [429, "monthly_quota_exceeded", "rejected", "PROVIDER_REJECTED"],
    [409, "concurrent_idempotent_requests", "ambiguous", "IDEMPOTENCY_CONFLICT"],
    [409, "invalid_idempotent_request", "ambiguous", "IDEMPOTENCY_CONFLICT"],
    [503, "service_unavailable", "ambiguous", "UNCONFIRMED_RESPONSE"],
    [200, "malformed_success", "ambiguous", "UNCONFIRMED_RESPONSE"],
    [400, "unrecognized_response", "ambiguous", "UNCONFIRMED_RESPONSE"],
  ]) {
    const db = fixture(t);
    let calls = 0;
    const send = createResendFixtureDelivery(config(() => {
      calls += 1;
      return Response.json({ name, message: "do not persist this" }, { status });
    }));
    assert.deepEqual(await send(db, queue), { state }, name);
    assert.deepEqual(await send(db, queue), { state }, name);
    assert.equal(calls, 1, name);
    assert.equal(db.prepare("SELECT error_code FROM email_delivery_attempts").get().error_code, code, name);
  }
});

test("Resend timeout remains held until a signed tagged event proves acceptance", async (t) => {
  const db = fixture(t);
  let request;
  const send = createResendFixtureDelivery({ ...config((_url, init) => {
    request = init;
    return new Promise(() => {});
  }), timeoutMs: 10 });
  assert.deepEqual(await send(db, queue), { state: "ambiguous" });
  assert.equal(request.signal.aborted, true);
  assert.deepEqual(ingest(db, signed("msg_without_tag")), { state: "unmatched" });
  const reply = signed("msg_tagged", { data: { tags: { rentflow_delivery: request.headers["Idempotency-Key"] } } });
  assert.deepEqual(ingest(db, reply), { state: "recorded" });
  assert.deepEqual(ingest(db, reply), { state: "duplicate" });
  assert.deepEqual(await send(db, queue), { state: "accepted" });
  assert.equal(delivery(db).provider_message_id, MESSAGE);
  assert.equal(db.prepare("SELECT error_code FROM email_delivery_attempts").get().error_code, "TIMEOUT");
});

test("independent SQLite connections contend for one Resend claim and keep signed evidence during handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-resend-"));
  const path = join(directory, "fixture.sqlite");
  const db = new DatabaseSync(path);
  const other = new DatabaseSync(path);
  let release;
  try {
    setup(db);
    let key;
    const send = createResendFixtureDelivery(config((_url, request) => {
      key = request.headers["Idempotency-Key"];
      return new Promise((resolve) => { release = resolve; });
    }));
    const outstanding = send(db, queue);
    assert.deepEqual(await send(other, queue), { state: "claimed" });
    const event = signed("msg_concurrent", { data: { tags: { rentflow_delivery: key } } });
    assert.deepEqual(ingest(other, event), { state: "recorded" });
    release(Response.json({ id: OTHER_MESSAGE }));
    assert.deepEqual(await outstanding, { state: "conflict" });
    assert.equal(delivery(db).provider_message_id, MESSAGE);
    assert.equal(db.prepare("SELECT count(*) AS count FROM email_delivery_attempts").get().count, 1);
  } finally {
    other.close();
    db.close();
    unlinkSync(path);
    rmdirSync(directory);
  }
});

test("Resend Svix verifier matches the published signature example and rejects altered bytes and replay timestamps", () => {
  // Public Svix documentation test vector, unrelated to any configured endpoint.
  const verify = createResendWebhook({ account: "example-account", secret: "whsec_plJ3nmyCDGBKInavdOK15jsl", clock: () => 1731705121000 });
  const example = {
    rawBody: Buffer.from('{"event_type":"ping","data":{"success":true}}'),
    headers: {
      "svix-id": "msg_loFOjxBNrRLzqYUf", "svix-timestamp": "1731705121",
      "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
    },
  };
  assert.deepEqual(verify(null, example), { state: "invalid" }); // Valid signature, unsupported payload shape.
  assert.deepEqual(verify(null, { ...example, rawBody: Buffer.concat([example.rawBody, Buffer.from(" ")]) }),
    { state: "unauthenticated" });
  for (const offset of [-301, 301]) {
    assert.deepEqual(ingest(null, signed("msg_stale", { timestamp: String(SIGNED_AT / 1000 + offset) })),
      { state: "unauthenticated" });
  }
  const supported = signed("msg_rotation", { type: "email.sent" });
  supported.headers["svix-signature"] = `v2,bogus v1,${Buffer.alloc(32).toString("base64")} ${supported.headers["svix-signature"]}`;
  assert.deepEqual(ingest(null, supported), { state: "ignored" });
  supported.headers["svix-id"] = "msg_tampered";
  assert.deepEqual(ingest(null, supported), { state: "unauthenticated" });
});

test("Resend webhook rejects malformed payloads and misbound events without creating receipts", async (t) => {
  const db = fixture(t);
  await createResendFixtureDelivery(config(() => Response.json({ id: MESSAGE })))(db, queue);
  for (const event of [
    signed("msg_invalid_json", { rawBody: Buffer.from("{") }),
    signed("msg_too_large", { rawBody: Buffer.alloc(64 * 1024 + 1) }),
    signed("msg_multi_recipient", { data: { to: [RECIPIENT, "other@example.test"] } }),
    signed("msg_rfc_id_only", { data: { email_id: null, message_id: "<fake@example.test>" } }),
    signed("msg_unknown_bounce", { type: "email.bounced", data: { bounce: { type: "unknown" } } }),
  ]) assert.deepEqual(ingest(db, event), { state: "invalid" });
  assert.deepEqual(ingest(db, signed("msg_recipient_conflict", { data: { to: ["other@example.test"] } })), { state: "conflict" });
  const wrongSecret = createResendWebhook({ account: "account-a", secret: `whsec_${Buffer.alloc(32, 26).toString("base64")}`, clock: () => SIGNED_AT });
  assert.deepEqual(wrongSecret(db, signed("msg_wrong_secret")), { state: "unauthenticated" });
  assert.equal(db.prepare("SELECT count(*) AS count FROM email_delivery_events").get().count, 0);
});

test("Resend events deduplicate by Svix ID and permanently suppress only the matching tenant", async (t) => {
  const db = fixture(t);
  await createResendFixtureDelivery(config(() => Response.json({ id: MESSAGE })))(db, queue);
  await createResendFixtureDelivery(config(() => Response.json({ id: MESSAGE }), "b"))(db, { ...queue, queueId: "queue-b" });
  const other = createResendWebhook({ account: "account-b", secret: SECRET, clock: () => SIGNED_AT });
  assert.deepEqual(ingest(db, signed("msg_soft", { type: "email.bounced", data: { bounce: { type: "Temporary" } } })), { state: "recorded" });
  assert.deepEqual(ingest(db, signed("msg_account_suppression", { type: "email.suppressed" })), { state: "ignored" });
  assert.deepEqual(ingest(db, signed("msg_legacy_suppression", {
    type: "email.bounced", data: { bounce: { type: "Permanent", subType: "Suppressed" } },
  })), { state: "ignored" });
  assert.equal(db.prepare("SELECT count(*) AS count FROM recipient_suppressions").get().count, 0);
  const hard = signed("msg_hard", { type: "email.bounced", data: { bounce: { type: "Permanent" }, company: "b" } });
  assert.deepEqual(ingest(db, hard), { state: "recorded" });
  assert.equal(delivery(db).state, "bounced");
  assert.deepEqual(ingest(db, hard), { state: "duplicate" });
  assert.deepEqual(ingest(db, signed("msg_hard")), { state: "conflict" });
  assert.deepEqual(other(db, signed("msg_hard")), { state: "recorded" });
  assert.deepEqual(ingest(db, signed("msg_complaint", { type: "email.complained" })), { state: "recorded" });
  assert.deepEqual(ingest(db, signed("msg_late")), { state: "recorded" });
  assert.equal(delivery(db).state, "complained");
  assert.equal(db.prepare("SELECT state FROM email_deliveries WHERE company_id = 'b'").get().state, "accepted");
  assert.deepEqual(db.prepare("SELECT company_id, email FROM recipient_suppressions").all().map(Object.values), [["a", RECIPIENT]]);
  assert.deepEqual(await createResendFixtureDelivery(config(() => assert.fail("suppressed")))(db, { ...queue, queueId: "queue-next" }), { state: "blocked" });
});

test("version 1 ledger upgrades transactionally without changing attempt history", async (t) => {
  const db = fixture(t);
  await createResendFixtureDelivery(config(() => Response.json({ id: MESSAGE })))(db, queue);
  db.exec(`
    ALTER TABLE email_delivery_attempts RENAME TO fixture_attempts;
    CREATE TABLE email_delivery_attempts (
      delivery_id INTEGER NOT NULL REFERENCES email_deliveries(id), number INTEGER NOT NULL,
      claimed_at TEXT NOT NULL, finished_at TEXT, outcome TEXT,
      error_code TEXT CHECK (error_code IN ('RATE_LIMITED', 'TIMEOUT', 'UNCONFIRMED_RESPONSE')),
      PRIMARY KEY (delivery_id, number)
    ) STRICT;
    INSERT INTO email_delivery_attempts SELECT * FROM fixture_attempts;
    DROP TABLE fixture_attempts;
    CREATE UNIQUE INDEX email_delivery_one_open_attempt ON email_delivery_attempts(delivery_id) WHERE finished_at IS NULL;
    UPDATE email_delivery_schema SET version = 1;
  `);
  const attempt = db.prepare("SELECT * FROM email_delivery_attempts").get();
  assert.deepEqual(migrateEmailDeliveryLedger(db), { version: 2, applied: true });
  assert.deepEqual(db.prepare("SELECT * FROM email_delivery_attempts").get(), attempt);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(migrateEmailDeliveryLedger(db), { version: 2, applied: false });
});
