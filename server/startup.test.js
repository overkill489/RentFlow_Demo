import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
