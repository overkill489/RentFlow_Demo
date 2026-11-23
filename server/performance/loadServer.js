import { once } from "node:events";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import { processDueFollowUps } from "../jobs/dueFollowUpProcessor.js";
import { queueDueDrafts } from "../services/queueDueDrafts.js";
import { recoverDeliveryQueue } from "../services/deliveryQueueRecovery.js";

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

function seed(quotes, companies) {
  const started = performance.now();
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
    sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
  };
}

if (mode === "seed") {
  process.send(seed(Number(sizeArg), Number(companiesArg)));
  db.close();
  process.disconnect();
} else if (mode === "workers" || mode === "recovery") {
  db.exec("PRAGMA busy_timeout = 5000");
  const exec = db.exec.bind(db);
  let began;
  let holdMs = 0;
  db.exec = (sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") began = performance.now();
    if (began !== undefined && (sql === "COMMIT" || sql === "ROLLBACK")) {
      holdMs += performance.now() - began;
      began = undefined;
    }
    return result;
  };
  const measure = (run) => {
    holdMs = 0;
    const start = performance.now();
    const result = run();
    return { elapsedMs: performance.now() - start, writerHoldMs: holdMs, result };
  };
  process.send({ ready: true });
  await once(process, "message");
  try {
    if (mode === "recovery") {
      process.send(Array.from({ length: 6 }, () =>
        measure(() => recoverDeliveryQueue(db, { includeEntries: false }))));
    } else {
      process.send({
        due: measure(() => processDueFollowUps(db, new Date().toISOString())),
        queue: measure(() => queueDueDrafts(db)),
        recovery: measure(() => recoverDeliveryQueue(db, { includeEntries: false })),
      });
    }
  } catch (error) {
    process.send({ workerError: error.errcode ?? error.message });
  } finally {
    db.close();
    process.disconnect();
  }
} else if (mode === "http") {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let busy = 0;
  let peakRss = 0;
  let peakHeap = 0;
  let unexpected = 0;
  console.error = (error) => {
    if ([5, 6].includes(error?.errcode & 255)) busy++;
    else unexpected++;
  };
  const sampleMemory = () => {
    const { rss, heapUsed } = process.memoryUsage();
    peakRss = Math.max(peakRss, rss);
    peakHeap = Math.max(peakHeap, heapUsed);
  };
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const tokens = Array.from({ length: Number(companiesArg) }, (_, i) =>
    jwt.sign({ companyId: `c${i + 1}` }, process.env.JWT_SECRET, {
      subject: `u${i + 1}`, jwtid: `load-${i + 1}`, expiresIn: 3600,
      issuer: "rentflow-api", audience: "rentflow-app",
    }));
  const timer = setInterval(sampleMemory, 50);

  process.on("message", (command) => {
    if (command === "reset") {
      busy = unexpected = peakRss = peakHeap = 0;
      delay.enable();
      delay.reset();
      sampleMemory();
      process.send(true);
    } else if (command === "metrics") {
      sampleMemory();
      delay.disable();
      process.send({
        busy, unexpected, peakRss, peakHeap, samples: delay.count,
        lagP95: delay.percentile(95) / 1e6, lagP99: delay.percentile(99) / 1e6,
        lagMax: delay.max / 1e6,
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
