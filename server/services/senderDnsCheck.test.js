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
import { checkSenderDnsVerification } from "./senderDnsCheck.js";

const NOW = "2026-12-02T16:00:00.000Z";
const LATER = "2026-12-03T16:00:00.000Z";

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

  for (const id of ["company-a", "company-b"]) {
    db.prepare(
      `
      INSERT INTO companies (id)
      VALUES (?)
    `,
    ).run(id);
  }

  return db;
}

function configure(
  db,
  companyId = "company-a",
  email = "office@rentflow-demo-company.com",
) {
  const result = saveSenderIdentity(
    db,
    companyId,
    {
      displayName: "RentFlow Demo Rentals",
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

async function check(
  db,
  resolveTxt,
  companyId = "company-a",
  currentTime = LATER,
) {
  return checkSenderDnsVerification(db, {
    companyId,
    currentTime,
    resolveTxt,
  });
}

function exactRecord(db, companyId = "company-a") {
  return [readiness(db, companyId).dnsRecord.value];
}

test("Pending request has no verified timestamp", () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const result = readiness(db);

    assert.equal(result.status, "pending_verification");
    assert.equal(result.verifiedAt, null);
    assert.equal(result.domainVerified, false);
  } finally {
    db.close();
  }
});

test("Exact matching TXT record verifies domain ownership", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const result = await check(db, async () => [exactRecord(db)]);

    assert.equal(result.success, true);
    assert.equal(result.dnsMatched, true);
    assert.equal(result.checkResult, "TXT_MATCH");
    assert.equal(result.data.status, "verified");
    assert.equal(result.data.domainVerified, true);
    assert.equal(result.data.verifiedAt, LATER);
    assert.equal(result.data.deliveryEnabled, false);
  } finally {
    db.close();
  }
});

test("Lookup uses the correct TXT record name", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    let requestedName = null;

    await check(db, async (name) => {
      requestedName = name;
      return [exactRecord(db)];
    });

    assert.equal(requestedName, "_rentflow-verify.rentflow-demo-company.com");
  } finally {
    db.close();
  }
});

test("Incorrect TXT value does not verify the domain", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const result = await check(db, async () => [
      ["rentflow-verification=wrong"],
    ]);

    assert.equal(result.success, true);
    assert.equal(result.dnsMatched, false);
    assert.equal(result.data.domainVerified, false);
    assert.equal(result.data.status, "pending_verification");
    assert.equal(result.checkResult, "TXT_NOT_FOUND");
  } finally {
    db.close();
  }
});

test("TXT matching requires the complete exact value", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const expected = readiness(db).dnsRecord.value;

    const result = await check(db, async () => [[`${expected}-extra`]]);

    assert.equal(result.dnsMatched, false);
    assert.equal(result.data.domainVerified, false);
  } finally {
    db.close();
  }
});

test("Split DNS TXT chunks can be verified", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const value = readiness(db).dnsRecord.value;

    const result = await check(db, async () => [
      [value.slice(0, 20), value.slice(20)],
    ]);

    assert.equal(result.dnsMatched, true);
    assert.equal(result.data.domainVerified, true);
  } finally {
    db.close();
  }
});

test("Missing DNS record keeps verification pending", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const result = await check(db, async () => []);

    assert.equal(result.dnsMatched, false);
    assert.equal(result.data.verifiedAt, null);
    assert.equal(result.data.lastCheckResult, "TXT_NOT_FOUND");
  } finally {
    db.close();
  }
});

test("DNS lookup failure does not verify ownership", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const result = await check(db, async () => {
      throw new Error("DNS unavailable");
    });

    assert.equal(result.success, true);
    assert.equal(result.dnsMatched, false);
    assert.equal(result.checkResult, "DNS_LOOKUP_FAILED");
    assert.equal(result.data.domainVerified, false);
  } finally {
    db.close();
  }
});

test("A failed recheck clears previous verification", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const first = await check(db, async () => [exactRecord(db)]);

    assert.equal(first.data.domainVerified, true);

    const second = await check(
      db,
      async () => [],
      "company-a",
      "2026-12-04T16:00:00.000Z",
    );

    assert.equal(second.data.domainVerified, false);
    assert.equal(second.data.verifiedAt, null);
    assert.equal(second.data.status, "pending_verification");
  } finally {
    db.close();
  }
});

test("Reserved testing domains cannot be verified", async () => {
  const db = setup();

  try {
    configure(db, "company-a", "office@example.test");
    prepare(db);

    let called = false;

    const result = await check(db, async () => {
      called = true;
      return [];
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    assert.equal(called, false);
    assert.equal(readiness(db).domainVerified, false);
  } finally {
    db.close();
  }
});

test("Company verification remains isolated", async () => {
  const db = setup();

  try {
    configure(db, "company-a", "office@company-a-rentals.com");
    configure(db, "company-b", "office@company-b-rentals.com");

    prepare(db, "company-a");
    prepare(db, "company-b");

    const result = await check(
      db,
      async () => [exactRecord(db, "company-a")],
      "company-a",
    );

    assert.equal(result.data.domainVerified, true);

    assert.equal(readiness(db, "company-b").domainVerified, false);
  } finally {
    db.close();
  }
});

test("Domain change during lookup prevents stale verification", async () => {
  const db = setup();

  try {
    configure(db);
    prepare(db);

    const originalValue = readiness(db).dnsRecord.value;

    const result = await check(db, async () => {
      configure(db, "company-a", "office@new-rentflow-domain.com");

      prepare(db);

      return [[originalValue]];
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    assert.equal(readiness(db).domainVerified, false);
    assert.equal(readiness(db).domain, "new-rentflow-domain.com");
  } finally {
    db.close();
  }
});
