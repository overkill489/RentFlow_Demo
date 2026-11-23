import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism, cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const stageArgs = args.filter((arg) => ["--quick", "--full-only", "--two-only"].includes(arg));
const journalArgs = args.filter((arg) => /^--journal=(delete|wal)$/.test(arg));
const timeoutArgs = args.filter((arg) => /^--api-timeout=(0|25|50|100|250)$/.test(arg));
const workerTimeoutArgs = args.filter((arg) => /^--worker-timeout=(0|500|5000)$/.test(arg));
if (stageArgs.length > 1 || journalArgs.length > 1 || timeoutArgs.length > 1 ||
    workerTimeoutArgs.length > 1 ||
    args.length !== stageArgs.length + journalArgs.length + timeoutArgs.length + workerTimeoutArgs.length) {
  throw new Error("Usage: node server/performance/backendLoad.js [--quick|--full-only|--two-only] [--journal=delete|wal] [--api-timeout=0|25|50|100|250] [--worker-timeout=0|500|5000]");
}
const quick = args.includes("--quick");
const twoOnly = args.includes("--two-only");
const full = args.includes("--full-only") || twoOnly;
const journal = journalArgs[0]?.split("=")[1] ?? "delete";
const apiTimeout = timeoutArgs[0]?.split("=")[1] ?? "0";
const workerTimeout = workerTimeoutArgs[0]?.split("=")[1] ?? "5000";
const stages = [
  { quotes: 1000, companies: 10, concurrency: 4, requests: 400 },
  { quotes: 10000, companies: 50, concurrency: 8, requests: 800 },
  { quotes: 100000, companies: 100, concurrency: 16, requests: 1600 },
];
const entry = fileURLToPath(new URL("./loadServer.js", import.meta.url));
const bootstrap = new URL("../database/db.js", import.meta.url);
const secret = randomBytes(48).toString("hex");
const mib = (bytes) => +(bytes / 1048576).toFixed(2);
const round = (value) => +value.toFixed(2);
const print = (value) => console.log(JSON.stringify(value));

function start(directory, mode, { quotes, companies }) {
  const child = fork(entry, [directory, mode, String(quotes), String(companies)], {
    env: {
      ...process.env,
      JWT_SECRET: secret,
      RENTFLOW_SQLITE_JOURNAL_MODE: journal === "wal" ? "wal" : "",
      RENTFLOW_SQLITE_PATH: journal === "wal" ? join(directory, "storage", "rentflow.db") : "",
      RENTFLOW_SQLITE_STORAGE: journal === "wal" ? "local-single-host" : "",
      RENTFLOW_SQLITE_BUSY_TIMEOUT_MS: mode === "http" && Number(apiTimeout) <= 100 ? apiTimeout : "0",
      RENTFLOW_LOAD_JOURNAL: journal,
      RENTFLOW_LOAD_API_TIMEOUT: apiTimeout,
      RENTFLOW_LOAD_WORKER_TIMEOUT: workerTimeout,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
    timeout: 120000,
  });
  const closed = once(child, "close");
  const receive = () => Promise.race([
    once(child, "message").then(([value]) => value),
    closed.then(([status, signal]) => {
      throw new Error(`${mode} exited before replying (${status ?? signal})`);
    }),
  ]);
  return {
    ready: receive(),
    async ask(command) {
      const reply = receive();
      child.send(command);
      return reply;
    },
    async done() {
      const [code, signal] = await closed;
      assert.equal(code, 0, `${mode} exited with ${code ?? signal}`);
    },
    async stop(graceful = false) {
      if (child.exitCode === null && child.signalCode === null) {
        if (graceful && child.connected) child.send("stop");
        else if (!graceful) child.kill();
      }
      await closed;
    },
  };
}

function percentiles(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map((p) =>
    [`p${p}`, round(sorted[Math.ceil(sorted.length * p / 100) - 1])]));
}

function operation(index, { companies, quotes }) {
  const hot = Math.floor(quotes / 5);
  const cycle = Math.floor(index / 20);
  const company = cycle % 4 === 0 ? 1 : 2 + (cycle % (companies - 1));
  let n = company === 1 ? 1 + ((index * 17) % hot) : hot + company - 1;
  const slot = index % 20;
  const step = company === 1 ? 1 : companies - 1;
  const quote = () => `QT-${1000000 + n}`;
  const request = (name, path, method = "GET", body) => ({ company, name, path, method, body });
  if (slot < 7) return request("quoteList", "/quotes");
  if (slot < 9) return request("quoteCreate", "/quotes", "POST", {
    customer: "Fictional load customer", equipment: "Scissor lift", amount: 110,
  });
  if (slot < 12) {
    while (n % 100 < 41) n += step;
    return request("schedule", `/followups/quotes/${quote()}`, "PUT", { scheduledAt: "2099-01-05T16:00:00.000Z" });
  }
  if (slot < 16) return request("readiness", `/delivery-readiness/quotes/${quote()}/readiness`);
  if (slot < 19) return request("queueList", "/delivery-queue");
  while (n % 100 >= 10) n += step;
  return request("queueAudit", `/delivery-queue/queue-${n}/audit`);
}

async function runRequests(stage, servers, requests, offset = 0) {
  let next = 0;
  const samples = [];
  const startTime = performance.now();
  await Promise.all(Array.from({ length: stage.concurrency }, async () => {
    while (next < requests) {
      const index = next++;
      const op = operation(index + offset, stage);
      const replica = (index + Math.floor(index / 20)) % servers.length;
      const { port, tokens } = servers[replica];
      const start = performance.now();
      let status, bytes = 0;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api${op.path}`, {
          method: op.method,
          headers: {
            Authorization: `Bearer ${tokens[op.company - 1]}`,
            ...(op.body && { "Content-Type": "application/json" }),
          },
          body: op.body ? JSON.stringify(op.body) : undefined,
          signal: AbortSignal.timeout(15000),
        });
        status = response.status;
        bytes = (await response.arrayBuffer()).byteLength;
      } catch (error) {
        status = error.name;
      }
      samples.push({ ...op, status, bytes, ms: performance.now() - start });
    }
  }));
  const seconds = (performance.now() - startTime) / 1000;
  const summarize = (rows) => ({
    count: rows.length,
    status: Object.fromEntries([...new Set(rows.map(({ status }) => status))].sort().map((status) =>
      [status, rows.filter((row) => row.status === status).length])),
    ...percentiles(rows.map(({ ms }) => ms)),
    bytesP95: percentiles(rows.map(({ bytes }) => bytes)).p95,
  });
  const errors = samples.filter(({ status }) => !(status >= 200 && status < 300)).length;
  return {
    seconds: round(seconds), rps: round(samples.length / seconds), errors,
    errorPct: round(100 * errors / samples.length), overall: summarize(samples),
    hotQuoteList: summarize(samples.filter(({ name, company }) => name === "quoteList" && company === 1)),
    coldQuoteList: summarize(samples.filter(({ name, company }) => name === "quoteList" && company !== 1)),
    endpoints: Object.fromEntries([...new Set(samples.map(({ name }) => name))].map((name) =>
      [name, summarize(samples.filter((row) => row.name === name))])),
  };
}

async function queryPlans(directory) {
  const db = new DatabaseSync(join(directory, "storage", "rentflow.db"), { readOnly: true });
  const targets = [
    ["quoteList", "../routes/quotes.js", "getAllQuotes", ["c1"]],
    ["quoteId", "../routes/quotes.js", "getNextId", []],
    ["followupList", "../routes/followups.js", "getQueue", ["c1"]],
    ["queueList", "../routes/deliveryQueue.js", "findAllQueue", ["c1"]],
    ["dueScan", "../jobs/dueFollowUpProcessor.js", "findDueSql", [new Date().toISOString()], "follow_ups f"],
    ["queueCandidates", "../services/queueDueDrafts.js", "findCandidatesSql", [new Date().toISOString()], "outbound_messages m"],
    ["recovery", "../services/deliveryQueueRecovery.js", "findActiveEntries", []],
  ];
  try {
    for (const [name, path, variable, bindings, source] of targets) {
      const text = await readFile(new URL(path, import.meta.url), "utf8");
      const prefix = source ? `const ${variable} = (source) => \`` : `const ${variable} = db.prepare(\``;
      assert.ok(text.includes(prefix), variable);
      const sql = text.split(prefix)[1].split("`")[0].replace("${source}", source);
      const statement = db.prepare(sql);
      statement.all(...bindings);
      const timings = Array.from({ length: 5 }, () => {
        const start = performance.now();
        statement.all(...bindings);
        return performance.now() - start;
      });
      print({ plan: name, medianMs: percentiles(timings).p50,
        details: db.prepare("EXPLAIN QUERY PLAN " + sql).all(...bindings).map(({ detail }) => detail) });
    }
  } finally {
    db.close();
  }
}

function verifyFixture(directory, successfulCreates, successfulSchedules) {
  const db = new DatabaseSync(join(directory, "storage", "rentflow.db"), { readOnly: true });
  try {
    const scalar = (sql) => Object.values(db.prepare(sql).get())[0];
    const result = {
      integrity: scalar("PRAGMA integrity_check"),
      foreignKeyErrors: db.prepare("PRAGMA foreign_key_check").all().length,
      detected: scalar("SELECT COUNT(*) FROM followup_due_events"),
      drafts: scalar("SELECT COUNT(*) FROM outbound_messages WHERE status = 'draft'"),
      activeQueue: scalar("SELECT COUNT(*) FROM delivery_queue WHERE status = 'pending_review'"),
      queuedAudit: scalar("SELECT COUNT(*) FROM delivery_queue_audit WHERE event_type = 'queued'"),
      attempts: scalar("SELECT COUNT(*) FROM delivery_attempts"),
      createdViaHttp: scalar("SELECT COUNT(*) FROM quotes WHERE customer = 'Fictional load customer'"),
      scheduledViaHttp: scalar(`SELECT COUNT(*) FROM activity_logs WHERE type = 'scheduling'
        AND description IN ('Follow-up scheduled.', 'Follow-up rescheduled.')`),
    };
    print({ verification: result });
    assert.deepEqual(result, {
      integrity: "ok", foreignKeyErrors: 0, detected: 5000, drafts: 11000,
      activeQueue: 11000, queuedAudit: 11000, attempts: 0,
      createdViaHttp: successfulCreates, scheduledViaHttp: successfulSchedules,
    });
  } finally {
    db.close();
  }
}

async function load(directory, stage, name, replicas, withWorkers) {
  const children = [];
  let workers;
  try {
    const servers = [];
    for (let i = 0; i < replicas; i++) {
      const child = start(directory, "http", stage);
      children.push(child);
      servers.push(await child.ready);
    }
    if (withWorkers) {
      workers = start(directory, "workers", stage);
      await workers.ready;
    }
    const warmup = await runRequests(stage, servers, 40);
    print({ workload: name, warmupErrors: warmup.errors });
    await Promise.all(children.map((child) => child.ask("reset")));
    const background = workers?.ask("run");
    const result = await runRequests(stage, servers, stage.requests, 40);
    const metrics = await Promise.all(children.map((child) => child.ask("metrics")));
    const workerResults = await background;
    if (workers) await workers.done();
    print({ workload: name, replicas, ...result, metrics: metrics.map(({ peakRss, peakHeap, ...m }) =>
      ({ ...m, rssMiB: mib(peakRss), heapMiB: mib(peakHeap) })), workers: workerResults });
    return {
      creates: (warmup.endpoints.quoteCreate.status[201] ?? 0) + (result.endpoints.quoteCreate.status[201] ?? 0),
      schedules: (warmup.endpoints.schedule.status[200] ?? 0) + (result.endpoints.schedule.status[200] ?? 0),
    };
  } finally {
    await Promise.all(children.map((child) => child.stop(true)));
    if (workers) await workers.stop();
  }
}

print({ node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  availableParallelism: availableParallelism(), memoryMiB: mib(totalmem()),
  journal, apiTimeout: Number(apiTimeout), workerTimeout: Number(workerTimeout) });
for (const stage of quick ? stages.slice(0, 1) : full ? stages.slice(2) : stages) {
  const directory = await mkdtemp(join(tmpdir(), "rentflow-backend-load-"));
  try {
    await mkdir(join(directory, "database"));
    await copyFile(bootstrap, join(directory, "database", "db.mjs"));
    if (journal === "wal") {
      await mkdir(join(directory, "storage"));
      const db = new DatabaseSync(join(directory, "storage", "rentflow.db"));
      try {
        db.exec("PRAGMA user_version = 0");
      } finally {
        db.close();
      }
    }
    const seeder = start(directory, "seed", stage);
    print({ stage, fixture: await seeder.ready });
    await seeder.done();
    if (stage.quotes === 100000 && !twoOnly) {
      await queryPlans(directory);
      const recovery = start(directory, "recovery", stage);
      await recovery.ready;
      print({ idleRecovery: await recovery.ask("run") });
      await recovery.done();
    }
    const single = twoOnly ? { creates: 0, schedules: 0 } : await load(directory, stage, "single-api", 1, false);
    if (stage.quotes === 100000) {
      const pair = await load(directory, stage, "two-api", 2, false);
      const overlap = await load(directory, stage, "two-api-with-workers", 2, true);
      verifyFixture(directory, single.creates + pair.creates + overlap.creates,
        single.schedules + pair.schedules + overlap.schedules);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
