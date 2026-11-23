import { once } from "node:events";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import { processDueFollowUpsInBatches } from "../jobs/dueFollowUpProcessor.js";
import { queueDueDraftsInBatches } from "../services/queueDueDrafts.js";
import { recoverDeliveryQueue } from "../services/deliveryQueueRecovery.js";
import { profileTransactions } from "./transactionProfile.js";

const [directory, mode, sizeArg, companiesArg] = process.argv.slice(2);
if (!process.send || !directory) throw new Error("Start through backendLoad.js");
const originalDb = new URL("../database/db.js", import.meta.url).href;
const fixtureDb = pathToFileURL(join(directory, "database", "db.mjs")).href;
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
const { createApp } = await import("../app.js").finally(() => hooks.deregister());
const { db } = await import(fixtureDb);

// No application scheduler timers, provider configuration, or production startup.
process.env.RENTFLOW_UNSUBSCRIBE_BASE_URL = "http://localhost:5000";
const past = "2025-01-06T16:00:00.000Z";
const future = "2099-01-05T16:00:00.000Z";
const journalMode = process.env.RENTFLOW_LOAD_JOURNAL;
const apiTimeout = Number(process.env.RENTFLOW_LOAD_API_TIMEOUT);
const workerTimeout = Number(process.env.RENTFLOW_LOAD_WORKER_TIMEOUT);
assert.ok(["delete", "wal"].includes(journalMode));
assert.ok([0, 25, 50, 100, 250].includes(apiTimeout));
assert.ok([0, 500, 5000].includes(workerTimeout));

function seed(quotes, companies) {
  const started = performance.now();
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, journalMode);
  const hot = Math.floor(quotes / 5);
  db.exec("BEGIN IMMEDIATE");
  for (let i = 1; i <= companies; i++) {
    db.prepare("INSERT INTO companies VALUES (?, ?, ?)").run(`c${i}`, `Fictional company ${i}`, past);
    db.prepare("INSERT INTO users VALUES (?, ?, ?, 'unused', 'admin', ?)")
      .run(`u${i}`, `c${i}`, `admin${i}@example.test`, past);
  }
  db.prepare(`
    CREATE TEMP TABLE load_rows AS
    WITH RECURSIVE series(n) AS (
      VALUES(1) UNION ALL SELECT n + 1 FROM series WHERE n < ?
    )
    SELECT n, 'QT-' || (1000000+n) AS id,
      'c' || CAST(CASE WHEN n <= ? THEN 1 ELSE 2 + ((n - ? - 1) % ?) END AS INTEGER) AS company,
      'recipient' || n || '@example.test' AS email,
      CASE WHEN n % 100 < 4 OR n % 100 = 10 THEN ? ELSE ? END AS scheduled
    FROM series
  `).run(quotes, hot, hot, companies - 1, past, future);
  const seedStatements = `
    INSERT INTO quotes (id, customer, equipment, amount, date, status, company_id)
    SELECT id, 'Fictional customer '||n, 'Scissor lift', 249.95, '${past}',
      CASE WHEN n % 100 < 26 THEN 'Follow-up Scheduled'
           WHEN n % 100 < 41 THEN 'Accepted' ELSE 'Pending' END, company
    FROM load_rows;
    INSERT INTO quote_contacts (quote_id, email, opted_out, created_at, updated_at)
    SELECT id, email, 0, '${past}', '${past}' FROM load_rows;
    INSERT INTO follow_ups
    SELECT id, scheduled, '${past}', '${past}' FROM load_rows WHERE n % 100 < 26;
    INSERT INTO activity_logs
    SELECT 'activity-'||n||'-'||history, id, 'scheduling', 'Synthetic history', '${past}'
    FROM load_rows JOIN (SELECT 1 AS history UNION ALL SELECT 2) WHERE n % 100 < 26;
    INSERT INTO outbound_messages
    SELECT 'draft-'||n, id, email, 'Rental follow-up', 'Synthetic draft only', 'draft', '${past}'
    FROM load_rows WHERE n % 100 < 10;
    INSERT INTO delivery_queue (id, message_id, status, created_at, updated_at)
    SELECT 'queue-'||n, 'draft-'||n, 'pending_review', '${past}', '${past}'
    FROM load_rows WHERE n % 100 < 10;
    COMMIT;
    DROP TABLE load_rows;
  `;
  for (const sql of seedStatements.trim().split(/;\s*/).filter(Boolean)) {
    try {
      db.exec(sql);
    } catch (error) {
      throw new Error(`Fixture seed failed at ${sql.split("\n")[0]}`, { cause: error });
    }
  }
  return {
    seedMs: performance.now() - started,
    seeded: { quotes, contacts: quotes, companies, queue: quotes / 10 },
    journal: db.prepare("PRAGMA journal_mode").get().journal_mode,
    timeout: db.prepare("PRAGMA busy_timeout").get().timeout,
    synchronous: db.prepare("PRAGMA synchronous").get().synchronous,
    foreignKeys: db.prepare("PRAGMA foreign_keys").get().foreign_keys,
    sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
  };
}

if (mode === "seed") {
  process.send(seed(Number(sizeArg), Number(companiesArg)));
  db.close();
  process.disconnect();
} else if (mode === "workers" || mode === "recovery") {
  db.exec(`PRAGMA busy_timeout = ${workerTimeout}`);
  let phase = "idleRecovery";
  const takeProfile = profileTransactions(db, () => phase);
  const measure = async (run) => {
    const start = performance.now();
    const result = await run();
    const profile = takeProfile(true);
    return { elapsedMs: performance.now() - start,
      writerHoldMs: profile.writes[phase]?.holdTotalMs ?? 0, profile, result };
  };
  process.send({ ready: true });
  await once(process, "message");
  const results = {};
  try {
    if (mode === "recovery") {
      const samples = [];
      for (let i = 0; i < 6; i++) {
        samples.push(await measure(() => recoverDeliveryQueue(db, { includeEntries: false })));
      }
      process.send(samples);
    } else {
      phase = "due";
      const currentTime = new Date().toISOString();
      results.due = await measure(() => processDueFollowUpsInBatches(db, currentTime));
      phase = "queue";
      results.queue = await measure(() => queueDueDraftsInBatches(db, { currentTime }));
      phase = "recovery";
      results.recovery = await measure(() => recoverDeliveryQueue(db, { includeEntries: false }));
      process.send(results);
    }
  } catch (error) {
    process.send({ ...results, workerPhase: phase, workerError: error.errcode ?? error.message });
  } finally {
    db.close();
    process.disconnect();
  }
} else if (mode === "http") {
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, journalMode);
  assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 2);
  if (apiTimeout === 250) db.exec("PRAGMA busy_timeout = 250");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, apiTimeout);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let busy = 0;
  let locked = 0;
  let peakRss = 0;
  let peakHeap = 0;
  let unexpected = 0;
  const requests = new AsyncLocalStorage();
  const takeProfile = profileTransactions(db, () => requests.getStore() ?? "outside HTTP");
  console.error = (error) => {
    if ((error?.errcode & 255) === 5) busy++;
    else if ((error?.errcode & 255) === 6) locked++;
    else unexpected++;
  };
  const sampleMemory = () => {
    const { rss, heapUsed } = process.memoryUsage();
    peakRss = Math.max(peakRss, rss);
    peakHeap = Math.max(peakHeap, heapUsed);
  };
  const app = createApp();
  const server = createServer((req, res) => {
    const route = req.url.replace(/QT-\d+/g, ":id");
    requests.run(`${req.method} ${route}`, () => app(req, res));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const tokens = Array.from({ length: Number(companiesArg) }, (_, i) =>
    jwt.sign({ companyId: `c${i + 1}` }, process.env.JWT_SECRET, {
      subject: `u${i + 1}`, jwtid: `load-${i + 1}`, expiresIn: 3600,
      issuer: "rentflow-api", audience: "rentflow-app",
    }));
  const timer = setInterval(sampleMemory, 50);

  process.on("message", (command) => {
    if (command === "reset") {
      busy = locked = unexpected = peakRss = peakHeap = 0;
      delay.enable();
      delay.reset();
      takeProfile();
      sampleMemory();
      process.send(true);
    } else if (command === "metrics") {
      sampleMemory();
      delay.disable();
      process.send({
        busy, locked, unexpected, peakRss, peakHeap, samples: delay.count,
        lagP95: delay.percentile(95) / 1e6, lagP99: delay.percentile(99) / 1e6,
        lagMax: delay.max / 1e6, transactions: takeProfile(),
      });
    } else if (command === "stop") {
      clearInterval(timer);
      server.close(() => {
        db.close();
        process.disconnect();
      });
    }
  });
  process.send({ port: server.address().port, tokens });
} else {
  throw new Error("Unknown fixture command");
}
