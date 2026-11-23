import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import { createOperations } from "./operations.js";
import { startDeliveryQueueScheduler } from "./jobs/startDeliveryQueueScheduler.js";

const directory = mkdtempSync(join(tmpdir(), "rentflow-http-"));
const originalDb = new URL("./database/db.js", import.meta.url).href;
mkdirSync(join(directory, "database"));
const fixturePath = join(directory, "database", "db.mjs");
copyFileSync(new URL(originalDb), fixturePath);
const fixtureDb = pathToFileURL(fixturePath).href;
delete process.env.RENTFLOW_SQLITE_PATH;
delete process.env.RENTFLOW_SQLITE_JOURNAL_MODE;
delete process.env.RENTFLOW_SQLITE_BUSY_TIMEOUT_MS;

// Run the real bootstrap with its file path anchored in the temporary directory.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === fixtureDb) {
      return nextResolve(specifier, { ...context, parentURL: originalDb });
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") &&
        new URL(specifier, context.parentURL).href === originalDb) {
      return nextResolve(fixtureDb, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createApp } = await import("./app.js").finally(() => hooks.deregister());
const { db } = await import(fixtureDb);
const secret = randomUUID() + randomUUID();
process.env.JWT_SECRET = secret;
const date = "2025-01-01T00:00:00.000Z";
const email = "shared-recipient@example.test";

for (const company of ["a", "b"]) {
  db.prepare("INSERT INTO companies VALUES (?, ?, ?)").run(company, `Company ${company}`, date);
  for (const role of ["admin", "member"]) {
    db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)")
      .run(`${company}-${role}`, company, `${company}-${role}@example.test`, "unused", role, date);
  }
  db.prepare("INSERT INTO quotes (id, company_id, customer, equipment, amount, date, status) VALUES (?, ?, ?, 'Lift', 100, ?, 'Follow-up Scheduled')")
    .run(`quote-${company}`, company, `Customer ${company}`, date);
  db.prepare("INSERT INTO follow_ups VALUES (?, ?, ?, ?)").run(`quote-${company}`, date, date, date);
  db.prepare("INSERT INTO quote_contacts VALUES (?, ?, 0, ?, ?)").run(`quote-${company}`, email, date, date);
  db.prepare("INSERT INTO outbound_messages VALUES (?, ?, ?, 'Subject', 'Synthetic draft', 'draft', ?)")
    .run(`draft-${company}`, `quote-${company}`, email, date);
  db.prepare("INSERT INTO delivery_queue (id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(`queue-${company}`, `draft-${company}`, date, date);
}

const observabilityLines = [];
let now = 0;
const operations = createOperations({
  clock: () => now,
  probe: () => db.prepare("SELECT 1 FROM companies LIMIT 1").get(),
  logger: {
    log: (line) => observabilityLines.push(line),
    error: (line) => observabilityLines.push(line),
  },
});
const metricsToken = randomUUID() + randomUUID();
const server = createApp({ operations, metricsToken }).listen(0, "127.0.0.1");
await once(server, "listening");
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});

function token(company = "a", role = "admin", options = {}, signingKey = secret) {
  return jwt.sign({ companyId: company }, signingKey, {
    algorithm: "HS256",
    issuer: "rentflow-api",
    audience: "rentflow-app",
    subject: `${company}-${role}`,
    jwtid: randomUUID(),
    expiresIn: 300,
    ...options,
  });
}

async function request(method, path, bearer, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body && JSON.stringify(body),
  });
  const content = response.headers.get("content-type");
  const data = content?.includes("application/json") ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, data };
}

const authenticated = [
  ["GET", "/auth/me"], ["POST", "/auth/logout"],
  ["GET", "/quotes"], ["POST", "/quotes"], ["GET", "/followups"],
  ["GET", "/delivery-queue"], ["GET", "/sender-identity"], ["GET", "/sender-verification"],
];
const quoteResources = [
  ["GET", "/quotes/:quote"], ["PATCH", "/quotes/:quote"],
  ["GET", "/followups/quotes/:quote/activity"], ["PUT", "/followups/quotes/:quote"],
  ["DELETE", "/followups/quotes/:quote"], ["POST", "/followups/quotes/:quote/simulate"],
  ["GET", "/delivery/quotes/:quote/contact"], ["PUT", "/delivery/quotes/:quote/contact"],
  ["POST", "/delivery/quotes/:quote/opt-out"], ["POST", "/delivery/quotes/:quote/draft"],
  ["GET", "/delivery/quotes/:quote/messages"], ["GET", "/delivery-readiness/quotes/:quote/readiness"],
];
const queueResources = [["GET", "/delivery-queue/:queue/attempts"]];
const adminResources = [
  ["POST", "/delivery/quotes/:quote/unsubscribe-link"],
  ["POST", "/delivery-queue/quotes/:quote"], ["GET", "/delivery-queue/:queue/audit"],
  ["POST", "/delivery-queue/:queue/approve"], ["POST", "/delivery-queue/:queue/simulate"],
  ["POST", "/delivery-queue/:queue/cancel"], ["GET", "/delivery-preflight/:queue"],
  ["POST", "/delivery-preflight-audit/:queue/check"], ["GET", "/delivery-preflight-audit/:queue/history"],
];
const adminCompany = [
  ["PUT", "/sender-identity"], ["POST", "/sender-verification/prepare"],
  ["POST", "/sender-verification/check"], ["GET", "/provider-readiness"],
];
const target = (path, company) => path.replace(":quote", `quote-${company}`).replace(":queue", `queue-${company}`);
const bodyFor = (method, path) => {
  if (method === "PATCH") return { status: "Accepted" };
  if (path.endsWith("/contact") && method === "PUT") return { email: "changed@example.test" };
  if (method === "PUT" && path.startsWith("/followups")) return { scheduledAt: "2099-01-05T16:00:00.000Z" };
};

test("all 34 protected HTTP endpoints require a bearer token", async () => {
  const endpoints = [...authenticated, ...quoteResources, ...queueResources, ...adminResources, ...adminCompany];
  assert.equal(endpoints.length, 34);
  for (const [method, path] of endpoints) {
    assert.equal((await request(method, target(path, "a"))).status, 401, `${method} ${path}`);
  }
});

test("authentication rejects expired, malformed, wrongly signed and wrong-context JWTs", async () => {
  for (const bearer of [
    "invalid",
    token("a", "admin", { expiresIn: -1 }),
    token("a", "admin", {}, "wrong-secret"),
    token("a", "admin", { audience: "different-audience" }),
    token("a", "admin", { issuer: "different-issuer" }),
    token("a", "admin", { algorithm: "HS384" }),
    token("a", "admin", { subject: "b-admin" }),
  ]) {
    assert.equal((await request("GET", "/auth/me", bearer)).status, 401);
  }
  const active = token();
  assert.equal((await request("GET", "/auth/me", active)).data.user.companyId, "a");
  assert.equal((await request("POST", "/auth/logout", active)).status, 200);
  assert.equal((await request("GET", "/quotes", active)).status, 401);
});

test("existing other-company resources are rejected across protected routes", async () => {
  const admin = token();
  for (const [method, path] of [...quoteResources, ...queueResources, ...adminResources]) {
    const url = target(path, "b");
    assert.equal((await request(method, url, admin, bodyFor(method, url))).status, 404, `${method} ${path}`);
  }
  assert.equal(db.prepare("SELECT status FROM delivery_queue WHERE id = 'queue-b'").get().status, "pending_review");
  assert.equal(db.prepare("SELECT opted_out FROM quote_contacts WHERE quote_id = 'quote-b'").get().opted_out, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM delivery_preflight_audit").get().count, 0);
});

test("members retain tenant reads and receive 403 on every administrator operation", async () => {
  const member = token("a", "member");
  for (const [method, path] of [...adminResources, ...adminCompany]) {
    assert.equal((await request(method, target(path, "a"), member)).status, 403, `${method} ${path}`);
  }
  for (const path of ["/quotes", "/followups", "/delivery-queue", "/sender-identity", "/sender-verification",
    "/delivery/quotes/quote-a/contact", "/delivery-queue/queue-a/attempts"]) {
    const result = await request("GET", path, member);
    assert.equal(result.status, 200, path);
    assert.doesNotMatch(JSON.stringify(result.data), /quote-b|queue-b|draft-b|Company b/);
  }
  const admin = token();
  for (const path of ["/provider-readiness", "/delivery-preflight/queue-a", "/delivery-preflight-audit/queue-a/history",
    "/delivery-queue/queue-a/audit"]) {
    assert.equal((await request("GET", path, admin)).status, 200, path);
  }
  assert.equal((await request("POST", "/delivery-preflight-audit/queue-a/check", admin)).status, 201);
});

test("company-scoped settings use the authenticated company and the current database role", async () => {
  const adminA = token();
  const adminB = token("b");
  const settings = { displayName: "Sender a", replyToEmail: "sender@example.test", companyId: "b" };
  assert.equal((await request("PUT", "/sender-identity", adminA, settings)).status, 200);
  assert.equal((await request("GET", "/sender-identity", adminA)).data.data.displayName, "Sender a");
  assert.equal((await request("GET", "/sender-identity", adminB)).data.data.configured, false);
  assert.equal((await request("GET", "/sender-verification", adminB)).data.data.companyId, "b");

  db.exec("UPDATE users SET role = 'member' WHERE id = 'a-admin'");
  try {
    assert.equal((await request("PUT", "/sender-identity", adminA, settings)).status, 403);
    assert.equal((await request("GET", "/auth/me", adminA)).data.user.role, "member");
  } finally {
    db.exec("UPDATE users SET role = 'admin' WHERE id = 'a-admin'");
  }
});

test("public unsubscribe GET and HEAD disclose no tenant records and POST affects only the linked company", async () => {
  const minted = await request("POST", "/delivery/quotes/quote-a/unsubscribe-link", token());
  assert.equal(minted.status, 201);
  const url = new URL(minted.data.data.url).pathname.slice("/api".length);
  const invalid = "/unsubscribe/" + "0".repeat(43);
  const suppressionCount = () => db.prepare("SELECT COUNT(*) AS count FROM recipient_suppressions").get().count;
  for (const method of ["GET", "HEAD"]) {
    const response = await request(method, url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.doesNotMatch(response.data, /example\.test|Company [ab]|Customer [ab]|quote-[ab]/);
    assert.equal(suppressionCount(), 0);
    assert.equal(db.prepare("SELECT used_at FROM unsubscribe_tokens").get().used_at, null);
  }
  for (const method of ["GET", "POST"]) {
    assert.equal((await request(method, invalid)).status, 400);
    assert.equal(suppressionCount(), 0);
  }
  assert.equal((await request("POST", url)).status, 200);
  assert.deepEqual(db.prepare("SELECT company_id AS company FROM recipient_suppressions").get().company, "a");
  assert.equal(db.prepare("SELECT opted_out FROM quote_contacts WHERE quote_id = 'quote-b'").get().opted_out, 0);
  assert.equal(db.prepare("SELECT status FROM delivery_queue WHERE id = 'queue-b'").get().status, "pending_review");
  assert.equal((await request("POST", url)).status, 400);
  assert.equal(suppressionCount(), 1);
});

test("a temporary authentication database failure is a server error, not an invalid session", async () => {
  const lock = new DatabaseSync(join(directory, "storage", "rentflow.db"));
  const bearer = token();
  const probeFailures = operations.snapshot().databaseProbeFailures;
  try {
    lock.exec("BEGIN EXCLUSIVE");
    assert.equal((await request("GET", "/health/live")).status, 200);
    const readiness = await request("GET", "/health/ready");
    assert.equal(readiness.status, 503);
    assert.deepEqual(readiness.data, { status: "not_ready" });
    assert.equal(operations.snapshot().databaseProbeFailures, probeFailures + 1);
    const result = await request("GET", "/auth/me", bearer);
    assert.equal(result.status, 500);
    assert.equal(result.data.error, "Internal server error");
  } finally {
    lock.close();
  }
  assert.equal((await request("GET", "/health/ready")).status, 200);
  assert.equal((await request("GET", "/auth/me", bearer)).status, 200);
});

test("metrics require the separate token and request errors are counted with bounded redacted logs", async () => {
  assert.equal((await request("GET", "/metrics")).status, 401);
  const bearer = token();
  assert.equal((await request("GET", "/metrics", bearer)).status, 401);
  const before = await request("GET", "/metrics", metricsToken);
  assert.equal(before.status, 200);
  assert.equal(before.headers.get("cache-control"), "no-store");
  now += 60000;
  const start = observabilityLines.length;
  const lock = new DatabaseSync(join(directory, "storage", "rentflow.db"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 14; i++) {
      const { status } = await request("POST", "/unsubscribe/synthetic-secret-in-path", bearer, {
        message: "synthetic customer email@example.test", providerKey: "synthetic-provider-key",
      });
      assert.equal(status, 500);
    }
  } finally {
    lock.close();
  }
  const afterMetrics = (await request("GET", "/metrics", metricsToken)).data;
  assert.equal(afterMetrics.requests.serverErrors - before.data.requests.serverErrors, 14);
  assert.equal(afterMetrics.errors.sqliteBusy - before.data.errors.sqliteBusy, 14);
  assert.equal(afterMetrics.errors.suppressedLogs - before.data.errors.suppressedLogs, 2);
  assert.equal(observabilityLines.length - start, 12);
  for (const line of observabilityLines.slice(start)) {
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["event", "reason", "time"]);
    assert.equal(JSON.parse(line).reason, "sqlite_busy");
  }
  assert.doesNotMatch(JSON.stringify({ observabilityLines, afterMetrics }),
    /synthetic-secret|synthetic-provider|email@example\.test|rentflow\.db|BEGIN IMMEDIATE/);
  assert.ok(!observabilityLines.some((line) => line.includes(bearer) || line.includes(metricsToken)));
});

test("readiness detects a stalled child, recovers after success and goes unready during shutdown", async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const scheduler = startDeliveryQueueScheduler({ operations, runJob: () => pending });
  t.after(() => scheduler.stop());
  const originalWrites = db.prepare("SELECT total_changes() AS count").get().count;
  assert.equal((await request("GET", "/health/ready")).status, 200);
  const check = scheduler.checkNow();
  now += 40000;
  assert.equal((await request("GET", "/health/live")).status, 200);
  assert.equal((await request("GET", "/health/ready")).status, 503);
  const metrics = (await request("GET", "/metrics", metricsToken)).data;
  assert.equal(metrics.workers.reconcile.status, "stalled");
  assert.equal(metrics.workers.reconcile.runs, 1);

  finish({ scanned: 0, healthy: 0, cancelled: 0, draftsCancelled: 0 });
  assert.equal(await check, true);
  assert.equal((await request("GET", "/health/ready")).status, 200);
  operations.beginShutdown();
  scheduler.stop();
  assert.equal((await request("GET", "/health/live")).status, 200);
  assert.equal((await request("GET", "/health/ready")).status, 503);
  assert.equal(await scheduler.checkNow(), false);
  assert.equal(db.prepare("SELECT total_changes() AS count").get().count, originalWrites);
});
