import { once } from "node:events";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import { processDueFollowUpsInBatches } from "../dueFollowUpProcessor.js";
import { queueDueDraftsInBatches } from "../../services/queueDueDrafts.js";
import { runDeliveryQueueAction } from "../../services/deliveryQueueLifecycle.js";
import { recoverDeliveryQueue } from "../../services/deliveryQueueRecovery.js";
import { confirmUnsubscribe } from "../../services/unsubscribeService.js";

const [directory, mode, checkpoint, gate, token] = process.argv.slice(2);
const now = "2025-02-01T00:00:00.000Z";
const due = "2025-01-01T00:00:00.000Z";
const secret = "rentflow-http-fixture-secret-only-for-this-temporary-database";
process.env.JWT_SECRET = secret;
process.env.RENTFLOW_UNSUBSCRIBE_BASE_URL = "http://localhost:5000";
delete process.env.RENTFLOW_SQLITE_PATH;
delete process.env.RENTFLOW_SQLITE_JOURNAL_MODE;
delete process.env.RENTFLOW_SQLITE_BUSY_TIMEOUT_MS;

async function loadApp() {
  const originalDb = new URL("../../database/db.js", import.meta.url).href;
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
  try {
    const { createApp } = await import("../../app.js");
    const { db } = await import(fixtureDb);
    return { createApp, db };
  } finally {
    hooks.deregister();
  }
}

function pauseAt(name) {
  if (checkpoint !== name) return;
  process.send(name);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 10000;
  while (!gate || !existsSync(gate)) {
    if (performance.now() > deadline) throw new Error(`Timed out at ${name}`);
    Atomics.wait(wait, 0, 0, 5);
  }
}

function instrument(db) {
  const exec = db.exec.bind(db);
  let commits = 0;
  let writing = false;
  let writeCommits = 0;
  db.exec = (sql) => {
    if (sql === "BEGIN IMMEDIATE") pauseAt("before-begin");
    if (sql === "COMMIT") {
      if (++commits === 1) pauseAt("before-commit");
      const result = exec(sql);
      if (writing && ++writeCommits === 1) pauseAt("after-write-commit");
      if (commits === 1) pauseAt("after-commit");
      writing = false;
      return result;
    }
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") writing = true;
    if (sql === "ROLLBACK") writing = false;
    return result;
  };
}

if (mode === "setup" || mode === "manual") {
  const { createApp, db } = await loadApp();
  if (mode === "setup") {
    for (const company of ["a", "b"]) {
      db.prepare("INSERT INTO companies VALUES (?, ?, ?)").run(company, company, due);
      db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, 'admin', ?)")
        .run(`admin-${company}`, company, `admin-${company}@example.test`, "unused", due);
      db.prepare(`INSERT INTO quotes (id, company_id, customer, equipment, amount, date, status)
                   VALUES (?, ?, ?, 'Lift', 100, ?, 'Follow-up Scheduled')`)
        .run(`quote-${company}`, company, `Customer ${company}`, due);
      db.prepare("INSERT INTO follow_ups VALUES (?, ?, ?, ?)").run(`quote-${company}`, due, due, due);
      db.prepare("INSERT INTO quote_contacts VALUES (?, 'shared@example.test', 0, ?, ?)")
        .run(`quote-${company}`, due, due);
    }
  } else {
    instrument(db);
    const server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const bearer = jwt.sign({ companyId: "a" }, secret, {
        subject: "admin-a", jwtid: "manual-test", expiresIn: 60,
        issuer: "rentflow-api", audience: "rentflow-app",
      });
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/delivery/quotes/quote-a/draft`,
        { method: "POST", headers: { Authorization: `Bearer ${bearer}` } },
      );
      process.send({ status: response.status, body: await response.json() });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  db.close();
} else {
  const db = new DatabaseSync(join(directory, "storage", "rentflow.db"), {
    timeout: mode === "due-no-wait" ? 0 : 5000,
  });
  try {
    instrument(db);
    let result;
    if (mode.startsWith("due")) {
      const drafts = await processDueFollowUpsInBatches(db, now);
      const queue = await queueDueDraftsInBatches(db, { currentTime: now });
      result = { drafts, queue };
    } else if (mode === "queue") {
      result = await queueDueDraftsInBatches(db, { currentTime: now });
    } else if (mode === "reconcile") {
      result = recoverDeliveryQueue(db, { currentTime: now, includeEntries: false });
    } else if (mode === "unsubscribe") {
      result = confirmUnsubscribe(db, token, now);
    } else {
      const queueId = db.prepare(`SELECT dq.id FROM delivery_queue dq
                                 JOIN outbound_messages m ON m.id = dq.message_id
                                 WHERE m.quote_id = 'quote-a'`).get().id;
      result = runDeliveryQueueAction(db, { companyId: "a", queueId, action: mode, actorId: "admin-a", currentTime: now });
    }
    process.send(result);
  } catch (error) {
    if (mode !== "due-no-wait" || error.errcode !== 5) throw error;
    process.send({ sqliteBusy: true });
  } finally {
    db.close();
  }
}
process.disconnect();
