import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { migrateEmailDeliveryLedger } from "../emailDeliveryMigration.js";
import { runDeliveryQueueAction } from "../../services/deliveryQueueLifecycle.js";
import { saveSenderIdentity } from "../../services/senderIdentity.js";
import { prepareSenderDomainVerification } from "../../services/senderVerification.js";
import { createUnsubscribeToken } from "../../services/unsubscribeService.js";
import { DUE, NOW, RECIPIENT, senderDomain } from "../../services/fixtures/mockDeliveryDatabase.js";

const [mode, path] = process.argv.slice(2);
const parent = dirname(resolve(path));
if (!basename(parent).startsWith("rentflow-email-release-") ||
    realpathSync(parent) !== join(realpathSync(tmpdir()), basename(parent)) ||
    realpathSync(path) !== join(realpathSync(parent), basename(path))) {
  throw new Error("Expected an on-disk temporary email release fixture");
}

if (mode === "seed") {
  process.env.RENTFLOW_SQLITE_PATH = path;
  process.env.RENTFLOW_SQLITE_JOURNAL_MODE = "";
  process.env.RENTFLOW_SQLITE_BUSY_TIMEOUT_MS = "0";
  await import("../../app.js");
  const { db } = await import("../db.js");
  try {
    for (const company of ["a", "b"]) {
      db.prepare("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)").run(company, `Fixture ${company}`, DUE);
      saveSenderIdentity(db, company, { displayName: "Equipment Rental", replyToEmail: `office@${senderDomain(company)}` }, DUE);
      prepareSenderDomainVerification(db, company, DUE);
      db.prepare(`
        UPDATE sender_domain_verifications SET verified_at = ?, last_checked_at = ?, last_check_result = 'TXT_MATCH'
        WHERE company_id = ?
      `).run(DUE, DUE, company);
    }
    for (const [name, company] of [["a", "a"], ["b", "b"], ["history", "a"]]) {
      const quote = `fixture-${name}`;
      const message = `message-${name}`;
      const queue = `queue-${name}`;
      db.prepare(`
        INSERT INTO quotes (id, company_id, customer, equipment, amount, date, status)
        VALUES (?, ?, 'Fictional customer', 'Lift', 25, ?, 'Follow-up Scheduled')
      `).run(quote, company, DUE);
      db.prepare("INSERT INTO follow_ups VALUES (?, ?, ?, ?)").run(quote, DUE, DUE, DUE);
      db.prepare("INSERT INTO quote_contacts VALUES (?, ?, 0, ?, ?)").run(quote, RECIPIENT, DUE, DUE);
      const { token } = createUnsubscribeToken(db, { companyId: company, quoteId: quote, email: RECIPIENT, currentTime: DUE });
      db.prepare("INSERT INTO outbound_messages VALUES (?, ?, ?, 'Follow-up', ?, 'draft', ?)")
        .run(message, quote, RECIPIENT, `https://staging.example.test/api/unsubscribe/${token}`, DUE);
      db.prepare("INSERT INTO delivery_queue (id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(queue, message, DUE, DUE);
      const action = { companyId: company, queueId: queue, actorId: "fixture-admin", currentTime: NOW };
      if (!runDeliveryQueueAction(db, { ...action, action: "approve" }).success ||
          (name === "history" && !runDeliveryQueueAction(db, { ...action, action: "simulate" }).success)) {
        throw new Error("Fixture queue transition failed");
      }
    }
  } finally {
    db.close();
  }
} else {
  const db = new DatabaseSync(path);
  try {
    if (mode === "migrate") {
      process.stdout.write(JSON.stringify(migrateEmailDeliveryLedger(db)));
    } else if (mode === "interrupt" && process.send) {
      migrateEmailDeliveryLedger({
        exec: db.exec.bind(db),
        get isTransaction() { return db.isTransaction; },
        prepare(sql) {
          if (sql.startsWith("INSERT INTO email_delivery_schema")) {
            process.send({ transaction: db.isTransaction, rebuilt: !db.prepare(`
              SELECT 1 FROM sqlite_schema WHERE name = 'email_delivery_attempts_v1'
            `).get(), sql: db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'email_delivery_attempts'").get().sql });
            // Hold the real migration's write transaction before the marker and COMMIT.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
            throw new Error("Expected the test to kill this process before commit");
          }
          return db.prepare(sql);
        },
      });
    } else {
      throw new Error("Unknown email release fixture mode");
    }
  } finally {
    db.close();
  }
}
