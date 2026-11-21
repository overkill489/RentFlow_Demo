import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  installDeliveryPreflightAuditSchema,
  recordDeliveryPreflight,
  getDeliveryPreflightHistory,
} from "./deliveryPreflightAudit.js";

const NOW = "2026-12-02T16:00:00.000Z";
const LATER = "2026-12-03T16:00:00.000Z";

function setup() {
  const db = new DatabaseSync(":memory:");

  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL
    );

    CREATE TABLE outbound_messages (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL
    );

    CREATE TABLE delivery_queue (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL
    );
  `);

  installDeliveryPreflightAuditSchema(db);

  for (const id of ["company-a", "company-b"]) {
    db.prepare(
      `
      INSERT INTO companies (id)
      VALUES (?)
    `,
    ).run(id);
  }

  for (const [quoteId, companyId] of [
    ["quote-a", "company-a"],
    ["quote-b", "company-b"],
  ]) {
    db.prepare(
      `
      INSERT INTO quotes (id, company_id)
      VALUES (?, ?)
    `,
    ).run(quoteId, companyId);
  }

  for (const [messageId, quoteId] of [
    ["message-a", "quote-a"],
    ["message-b", "quote-b"],
  ]) {
    db.prepare(
      `
      INSERT INTO outbound_messages (id, quote_id)
      VALUES (?, ?)
    `,
    ).run(messageId, quoteId);
  }

  for (const [queueId, messageId] of [
    ["queue-a", "message-a"],
    ["queue-b", "message-b"],
  ]) {
    db.prepare(
      `
      INSERT INTO delivery_queue (id, message_id)
      VALUES (?, ?)
    `,
    ).run(queueId, messageId);
  }

  return db;
}

function fakePreflight(
  db,
  { companyId, queueId, currentTime, providerConfig },
) {
  const owned = db
    .prepare(
      `
    SELECT dq.id
    FROM delivery_queue dq
    JOIN outbound_messages m
      ON m.id = dq.message_id
    JOIN quotes q
      ON q.id = m.quote_id
    WHERE dq.id = ?
      AND q.company_id = ?
  `,
    )
    .get(queueId, companyId);

  if (!owned) {
    return null;
  }

  const technicalChecksPassed = providerConfig.eligible === true;

  return {
    queueId,
    companyId,
    checkedAt: currentTime,
    status: "blocked",
    technicalChecksPassed,
    unsubscribeValid: providerConfig.unsubscribeValid !== false,
    providerConfigurationValid: technicalChecksPassed,
    reasons: technicalChecksPassed
      ? [
          "PROVIDER_CONNECTION_NOT_VERIFIED",
          "SENDING_NOT_AUTHORIZED",
          "DELIVERY_DISABLED",
        ]
      : [
          "PROVIDER_CONFIGURATION_INCOMPLETE",
          "DOMAIN_NOT_VERIFIED",
          "DELIVERY_DISABLED",
        ],
    deliveryEnabled: false,
    emailsSent: 0,
  };
}

function record(db, overrides = {}) {
  return recordDeliveryPreflight(db, {
    companyId: "company-a",
    queueId: "queue-a",
    actorId: "admin-a",
    currentTime: NOW,
    providerConfig: {
      eligible: false,
    },
    evaluate: fakePreflight,
    ...overrides,
  });
}

function history(db, overrides = {}) {
  return getDeliveryPreflightHistory(db, {
    companyId: "company-a",
    queueId: "queue-a",
    ...overrides,
  });
}

function count(db) {
  return db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM delivery_preflight_audit
  `,
    )
    .get().total;
}

test("Audit schema creates the required table", () => {
  const db = setup();

  try {
    const table = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'delivery_preflight_audit'
    `,
      )
      .get();

    assert.equal(table.name, "delivery_preflight_audit");
  } finally {
    db.close();
  }
});

test("A preflight result is recorded successfully", () => {
  const db = setup();

  try {
    const result = record(db);

    assert.ok(result.id);
    assert.equal(result.queueId, "queue-a");
    assert.equal(result.status, "blocked");
    assert.equal(result.checkedAt, NOW);
    assert.equal(count(db), 1);
  } finally {
    db.close();
  }
});

test("Audit preserves the initiating administrator", () => {
  const db = setup();

  try {
    const result = record(db, {
      actorId: "admin-123",
    });

    assert.equal(result.actorId, "admin-123");
    assert.equal(history(db)[0].actorId, "admin-123");
  } finally {
    db.close();
  }
});

test("Blocked reasons are saved and retrieved", () => {
  const db = setup();

  try {
    record(db);

    const result = history(db)[0];

    assert.deepEqual(result.reasons, [
      "PROVIDER_CONFIGURATION_INCOMPLETE",
      "DOMAIN_NOT_VERIFIED",
      "DELIVERY_DISABLED",
    ]);

    assert.equal(result.technicalChecksPassed, false);
  } finally {
    db.close();
  }
});

test("Technical eligibility never enables delivery", () => {
  const db = setup();

  try {
    const result = record(db, {
      providerConfig: {
        eligible: true,
      },
    });

    assert.equal(result.technicalChecksPassed, true);
    assert.equal(result.providerConfigurationValid, true);
    assert.equal(result.deliveryEnabled, false);
    assert.equal(result.emailsSent, 0);
    assert.equal(result.status, "blocked");
  } finally {
    db.close();
  }
});

test("History records changes between checks", () => {
  const db = setup();

  try {
    record(db);

    record(db, {
      currentTime: LATER,
      providerConfig: {
        eligible: true,
      },
    });

    const results = history(db);

    assert.equal(results.length, 2);
    assert.equal(results[0].checkedAt, LATER);
    assert.equal(results[0].technicalChecksPassed, true);
    assert.equal(results[1].technicalChecksPassed, false);
  } finally {
    db.close();
  }
});

test("Repeated checks create separate historical events", () => {
  const db = setup();

  try {
    const first = record(db);
    const second = record(db);

    assert.notEqual(first.id, second.id);
    assert.equal(count(db), 2);
    assert.equal(history(db).length, 2);
  } finally {
    db.close();
  }
});

test("Another company cannot record a queue check", () => {
  const db = setup();

  try {
    const result = record(db, {
      companyId: "company-b",
    });

    assert.equal(result, null);
    assert.equal(count(db), 0);
  } finally {
    db.close();
  }
});

test("Another company cannot read queue history", () => {
  const db = setup();

  try {
    record(db);

    assert.equal(
      history(db, {
        companyId: "company-b",
      }),
      null,
    );

    assert.equal(count(db), 1);
  } finally {
    db.close();
  }
});

test("History limits are enforced", () => {
  const db = setup();

  try {
    for (let i = 0; i < 5; i += 1) {
      record(db);
    }

    assert.equal(history(db, { limit: 2 }).length, 2);
    assert.equal(history(db, { limit: 3 }).length, 3);
    assert.equal(count(db), 5);
  } finally {
    db.close();
  }
});

test("Failed insert rolls back the audit transaction", () => {
  const db = setup();

  try {
    db.exec(`
      CREATE TRIGGER reject_preflight_audit_insert
      BEFORE INSERT ON delivery_preflight_audit
      BEGIN
        SELECT RAISE(
          ABORT,
          'forced audit insert failure'
        );
      END;
    `);

    assert.throws(() => record(db), /forced audit insert failure/);

    assert.equal(count(db), 0);
    assert.equal(db.isTransaction, false);
  } finally {
    db.close();
  }
});

test("Audit records never contain message secrets", () => {
  const db = setup();

  try {
    record(db);

    const row = db
      .prepare(
        `
      SELECT *
      FROM delivery_preflight_audit
      LIMIT 1
    `,
      )
      .get();

    const columns = Object.keys(row);

    assert.equal(columns.includes("body"), false);
    assert.equal(columns.includes("token"), false);
    assert.equal(columns.includes("api_key"), false);

    assert.equal(
      JSON.stringify(row).includes("http://localhost:5000/api/unsubscribe/"),
      false,
    );

    assert.equal(history(db)[0].deliveryEnabled, false);
  } finally {
    db.close();
  }
});
