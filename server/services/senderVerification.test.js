import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  installSenderIdentitySchema,
  saveSenderIdentity,
} from "./senderIdentity.js";
import {
  installSenderVerificationSchema,
  getSenderDomainReadiness,
  prepareSenderDomainVerification,
} from "./senderVerification.js";

const NOW = "2026-12-02T16:00:00.000Z";

function setup() {
  const db = new DatabaseSync(":memory:");

  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY
    );
  `);

  installSenderIdentitySchema(db);
  installSenderVerificationSchema(db);

  db.prepare(
    `
    INSERT INTO companies (id)
    VALUES (?)
  `,
  ).run("company-a");

  db.prepare(
    `
    INSERT INTO companies (id)
    VALUES (?)
  `,
  ).run("company-b");

  return db;
}

function configure(db, companyId = "company-a", email = "Office@Example.Test") {
  const result = saveSenderIdentity(
    db,
    companyId,
    {
      displayName: "Company Equipment Rentals",
      replyToEmail: email,
    },
    NOW,
  );

  assert.equal(result.success, true);
}

function prepare(db, companyId = "company-a") {
  return prepareSenderDomainVerification(db, companyId, NOW);
}

function readiness(db, companyId = "company-a") {
  return getSenderDomainReadiness(db, companyId);
}

function count(db) {
  return db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM sender_domain_verifications
  `,
    )
    .get().total;
}

test("Schema creates the verification table", () => {
  const db = setup();

  try {
    const table = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'sender_domain_verifications'
    `,
      )
      .get();

    assert.equal(table.name, "sender_domain_verifications");
  } finally {
    db.close();
  }
});

test("Unconfigured company is not ready", () => {
  const db = setup();

  try {
    const result = readiness(db);

    assert.equal(result.status, "not_configured");
    assert.equal(result.domainVerified, false);
    assert.equal(result.deliveryEnabled, false);
  } finally {
    db.close();
  }
});

test("Preparing without sender settings is rejected", () => {
  const db = setup();

  try {
    const result = prepare(db);

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    assert.equal(count(db), 0);
  } finally {
    db.close();
  }
});

test("Configured sender domain is extracted correctly", () => {
  const db = setup();

  try {
    configure(db);

    const result = readiness(db);

    assert.equal(result.domain, "example.test");
    assert.equal(result.status, "not_requested");
    assert.equal(result.domainVerified, false);
  } finally {
    db.close();
  }
});

test("Preparing verification creates a pending request", () => {
  const db = setup();

  try {
    configure(db);

    const result = prepare(db);

    assert.equal(result.success, true);
    assert.equal(result.statusCode, 201);
    assert.equal(result.data.status, "pending_verification");
    assert.equal(count(db), 1);
  } finally {
    db.close();
  }
});

test("Verification request contains a unique TXT value", () => {
  const db = setup();

  try {
    configure(db);

    const result = prepare(db);
    const record = result.data.dnsRecord;

    assert.equal(record.type, "TXT");
    assert.equal(record.name, "_rentflow-verify.example.test");
    assert.match(record.value, /^rentflow-verification=[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test("Repeated preparation returns the same request", () => {
  const db = setup();

  try {
    configure(db);

    const first = prepare(db);
    const second = prepare(db);

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);

    assert.deepEqual(first.data.dnsRecord, second.data.dnsRecord);

    assert.equal(count(db), 1);
  } finally {
    db.close();
  }
});

test("Changing the sender domain invalidates the old request", () => {
  const db = setup();

  try {
    configure(db);

    const first = prepare(db);

    configure(db, "company-a", "office@newdomain.test");

    const afterChange = readiness(db);

    assert.equal(afterChange.status, "not_requested");
    assert.equal(afterChange.dnsRecord, null);

    const second = prepare(db);

    assert.equal(second.statusCode, 201);
    assert.equal(second.data.domain, "newdomain.test");

    assert.notEqual(first.data.dnsRecord.value, second.data.dnsRecord.value);

    assert.equal(count(db), 1);
  } finally {
    db.close();
  }
});

test("Company A and B requests are isolated", () => {
  const db = setup();

  try {
    configure(db, "company-a", "a@company-a.test");
    configure(db, "company-b", "b@company-b.test");

    const companyA = prepare(db, "company-a");
    const companyB = prepare(db, "company-b");

    assert.equal(count(db), 2);

    assert.equal(companyA.data.domain, "company-a.test");

    assert.equal(companyB.data.domain, "company-b.test");

    assert.notEqual(
      companyA.data.dnsRecord.value,
      companyB.data.dnsRecord.value,
    );
  } finally {
    db.close();
  }
});

test("Unknown company cannot prepare verification", () => {
  const db = setup();

  try {
    const result = prepare(db, "unknown-company");

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
    assert.equal(count(db), 0);
  } finally {
    db.close();
  }
});

test("Pending verification never enables delivery", () => {
  const db = setup();

  try {
    configure(db);

    const result = prepare(db);

    assert.equal(result.data.domainVerified, false);
    assert.equal(result.data.deliveryEnabled, false);
    assert.ok(result.data.reasons.includes("DNS_VERIFICATION_PENDING"));
  } finally {
    db.close();
  }
});

test("Repeated schema initialization preserves requests", () => {
  const db = setup();

  try {
    configure(db);

    const first = prepare(db);

    installSenderVerificationSchema(db);
    installSenderVerificationSchema(db);

    const second = readiness(db);

    assert.equal(count(db), 1);
    assert.deepEqual(first.data.dnsRecord, second.dnsRecord);
  } finally {
    db.close();
  }
});
