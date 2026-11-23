import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFollowUpEmailTemplate } from "./services/followUpEmailTemplate.js";
import { saveSenderIdentity } from "./services/senderIdentity.js";
import { prepareSenderDomainVerification } from "./services/senderVerification.js";

const entry = new URL("./index.js", import.meta.url);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-startup-"));
  const database = join(directory, "rentflow.db");
  writeFileSync(database, "", { flag: "wx" });
  return {
    directory,
    database,
    env: {
      ...process.env,
      NODE_ENV: "production",
      JWT_SECRET: randomBytes(48).toString("hex"),
      RENTFLOW_SQLITE_PATH: database,
      RENTFLOW_SQLITE_JOURNAL_MODE: "",
      RENTFLOW_SQLITE_BUSY_TIMEOUT_MS: "0",
      RENTFLOW_TRUST_LOOPBACK_PROXY: "0",
      RENTFLOW_METRICS_TOKEN: "",
      PORT: "0",
      DOTENV_CONFIG_PATH: join(directory, "no-env-file"),
    },
  };
}

function rejectStartup(directory, env, beforeImport = "") {
  const runner = `${beforeImport}\nawait import(${JSON.stringify(entry.href)});`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: directory, env, encoding: "utf8", windowsHide: true, timeout: 10000,
  });
}

test("invalid startup settings leave the SQLite fixture byte-for-byte empty", () => {
  const { directory, database, env } = fixture();
  for (const [settings, message] of [
    [{ JWT_SECRET: "invalid" }, /JWT_SECRET must contain/],
    [{ PORT: "invalid" }, /PORT must be an integer/],
    [{ RENTFLOW_TRUST_LOOPBACK_PROXY: "true" }, /must be 0 or 1/],
    [{ RENTFLOW_METRICS_TOKEN: "invalid" }, /must be a separate/],
  ]) {
    const result = rejectStartup(directory, { ...env, ...settings });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(statSync(database).size, 0);
  }
});

test("production requires an explicit database path before resolving the app", () => {
  const { directory, env } = fixture();
  const forbidDatabase = `
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (["./app.js", "./database/db.js"].includes(specifier)) {
          throw new Error("Unexpected startup app or database import");
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  delete env.RENTFLOW_SQLITE_PATH;
  const result = rejectStartup(directory, env, forbidDatabase);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Production requires an explicit RENTFLOW_SQLITE_PATH/);
});

async function boot(t, directory, env) {
  // Deliver the Node signal event via IPC so this also exercises the handler on Windows.
  const runner = `
    import process from "node:process";
    process.on("message", () => {
      process.disconnect();
      process.emit("SIGTERM");
    });
    await import(${JSON.stringify(entry.href)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: directory, env, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"], timeout: 20000,
  });
  const exit = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  const listening = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/"event":"api_listening","port":(\d+)/);
      if (match && stdout.includes('"event":"worker_succeeded","worker":"due"')) {
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
  const url = await Promise.race([
    listening,
    exit.then(([code]) => assert.fail(`Startup exited with ${code}: ${stderr}`)),
  ]);
  return {
    url,
    async stop() {
      child.send("stop");
      assert.deepEqual(await exit, [0, null], stderr);
      assert.doesNotMatch(stderr, /"event":"worker_failed"/);
      assert.match(stdout, /"event":"shutdown_started"/);
      assert.match(stdout, /"event":"http_drain_complete"/);
    },
  };
}

test("production stops cleanly and restarts with persisted rows through the guarded WAL path", async (t) => {
  const { directory, database, env } = fixture();
  const first = await boot(t, directory, env);
  assert.equal((await fetch(first.url + "/api/health")).status, 200);
  assert.equal((await fetch(first.url + "/api/health/live")).status, 200);
  assert.equal((await fetch(first.url + "/api/health/ready")).status, 200);
  assert.equal((await fetch(first.url + "/api/metrics")).status, 404);
  const registration = await fetch(first.url + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyName: "Temporary startup fixture",
      email: "startup@example.test",
      password: randomBytes(18).toString("hex"),
    }),
  });
  assert.equal(registration.status, 201);
  const { token } = await registration.json();
  await first.stop();

  const second = await boot(t, directory, {
    ...env,
    RENTFLOW_SQLITE_JOURNAL_MODE: "wal",
    RENTFLOW_SQLITE_STORAGE: "local-single-host",
    RENTFLOW_SQLITE_BUSY_TIMEOUT_MS: "25",
  });
  const session = await fetch(second.url + "/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.email, "startup@example.test");
  await second.stop();

  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  } finally {
    db.close();
  }
});

test("the opt-in one-hop proxy gives different clients separate login rate limits", async (t) => {
  const { directory, env } = fixture();
  const app = await boot(t, directory, { ...env, RENTFLOW_TRUST_LOOPBACK_PROXY: "1" });
  async function login(ip) {
    const result = await fetch(app.url + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: "{}",
    });
    await result.text();
    return result.status;
  }
  for (let i = 0; i < 5; i++) assert.equal(await login("192.0.2.20"), 400);
  assert.equal(await login("192.0.2.20"), 429);
  assert.equal(await login("192.0.2.21"), 400);
  await app.stop();
});

test("production API and workers cannot dispatch eligible email even with provider-like environment values", async (t) => {
  const { directory, database, env } = fixture();
  const egress = join(directory, "unexpected-http");
  const trap = `
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import http from 'node:http';
    import https from 'node:https';
    const forbidden = () => {
      appendFileSync(${JSON.stringify(egress)}, 'attempt');
      throw new Error('Unexpected outbound HTTP');
    };
    globalThis.fetch = http.request = http.get = https.request = https.get = forbidden;
    syncBuiltinESMExports();
  `;
  const settings = {
    ...env,
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(trap)}`,
    RENTFLOW_EMAIL_PROVIDER: "resend",
    RENTFLOW_FROM_EMAIL: "quotes@sender-a.rentflow.invalid-domain.com",
    RESEND_API_KEY: "re_synthetic_startup_fixture_key",
    RENTFLOW_EMAIL_DELIVERY_ENABLED: "1",
  };
  const app = await boot(t, directory, settings);
  const registration = await fetch(app.url + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyName: "Synthetic mail fixture", email: "admin@example.test", password: randomBytes(18).toString("hex") }),
  });
  assert.equal(registration.status, 201);
  const { token, user } = await registration.json();
  const { companyId } = user;
  const db = new DatabaseSync(database);
  try {
    const now = new Date(Date.now() - 60_000).toISOString();
    saveSenderIdentity(db, companyId, {
      displayName: "Staging Rental", replyToEmail: "office@sender-a.rentflow.invalid-domain.com",
    }, now);
    prepareSenderDomainVerification(db, companyId, now);
    db.prepare(`
      UPDATE sender_domain_verifications SET verified_at = ?, last_checked_at = ?, last_check_result = 'TXT_MATCH'
      WHERE company_id = ?
    `).run(now, now, companyId);
    db.prepare(`
      INSERT INTO quotes (id, company_id, customer, equipment, amount, date, status)
      VALUES ('email-fixture', ?, 'Fictional customer', 'Lift', 25, ?, 'Follow-up Scheduled')
    `).run(companyId, now);
    db.prepare("INSERT INTO follow_ups VALUES ('email-fixture', ?, ?, ?)").run(now, now, now);
    db.prepare("INSERT INTO quote_contacts VALUES ('email-fixture', 'recipient@example.test', 0, ?, ?)").run(now, now);
    const message = createFollowUpEmailTemplate(db, {
      companyId, quoteId: "email-fixture", customer: "Fictional customer", equipment: "Lift", currentTime: now,
      baseUrl: "https://staging.example.test",
    });
    db.prepare(`
      INSERT INTO outbound_messages VALUES ('email-draft', 'email-fixture', 'recipient@example.test', ?, ?, 'draft', ?)
    `).run(message.subject, message.body, now);
    db.prepare("INSERT INTO delivery_queue (id, message_id, created_at, updated_at) VALUES ('email-queue', 'email-draft', ?, ?)")
      .run(now, now);
  } finally {
    db.close();
  }

  const headers = { Authorization: `Bearer ${token}` };
  const api = (path, method = "GET") => fetch(`${app.url}/api${path}`, { method, headers });
  assert.equal((await api("/delivery-queue/email-queue/approve", "POST")).status, 200);
  const preflight = await api("/delivery-preflight/email-queue");
  assert.equal(preflight.status, 200);
  const { data } = await preflight.json();
  assert.equal(data.technicalChecksPassed, true);
  for (const flag of ["providerConnectionVerified", "sendingAuthorized", "deliveryEnabled"]) assert.equal(data[flag], false);
  assert.equal(data.emailsSent, 0);
  assert.equal((await api("/delivery-preflight-audit/email-queue/check", "POST")).status, 201);
  assert.equal((await api("/delivery-queue/email-queue/send", "POST")).status, 404);
  assert.equal((await api("/webhooks/resend", "POST")).status, 404);

  for (const job of ["checkDueFollowUps.js", "reconcileDeliveryQueue.js"]) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL(`./jobs/${job}`, import.meta.url))], {
      cwd: directory, env: settings, encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).emailsSent, 0);
  }
  const simulation = await api("/delivery-queue/email-queue/simulate", "POST");
  assert.equal(simulation.status, 200);
  assert.equal((await simulation.json()).emailsSent, 0);
  await app.stop();
  assert.equal(existsSync(egress), false);
  const persisted = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(persisted.prepare("SELECT result FROM delivery_attempts WHERE queue_id = 'email-queue'").get().result, "simulated");
    assert.equal(persisted.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'email_deliveries'").get(), undefined);
  } finally {
    persisted.close();
  }
});
