import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  installSenderIdentitySchema,
  saveSenderIdentity,
} from "./senderIdentity.js";
import {
  installSenderVerificationSchema,
  prepareSenderDomainVerification,
} from "./senderVerification.js";
import { getProviderReadiness } from "./providerReadiness.js";

const NOW = "2026-12-02T16:00:00.000Z";
const VERIFIED_AT = "2026-12-03T16:00:00.000Z";

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

  for (const companyId of ["company-a", "company-b"]) {
    db.prepare(
      `
      INSERT INTO companies (id)
      VALUES (?)
    `,
    ).run(companyId);
  }

  return db;
}

function configure(db, companyId = "company-a", email = "office@rentalco.com") {
  const result = saveSenderIdentity(
    db,
    companyId,
    {
      displayName: "Rental Company",
      replyToEmail: email,
    },
    NOW,
  );

  assert.equal(result.success, true);
}

function markVerified(db, companyId = "company-a") {
  const result = prepareSenderDomainVerification(db, companyId, NOW);

  assert.equal(result.success, true);

  db.prepare(
    `
    UPDATE sender_domain_verifications
    SET
      verified_at = ?,
      last_checked_at = ?,
      last_check_result = 'TXT_MATCH'
    WHERE company_id = ?
  `,
  ).run(VERIFIED_AT, VERIFIED_AT, companyId);
}

function config(overrides = {}) {
  return {
    provider: "resend",
    fromEmail: "notifications@rentalco.com",
    ...overrides,
  };
}

function check(db, overrides = {}, companyId = "company-a") {
  return getProviderReadiness(db, companyId, config(overrides));
}

test("Unconfigured sender is not ready", () => {
  const db = setup();

  try {
    const result = check(db);

    assert.equal(result.status, "configuration_incomplete");

    assert.ok(result.reasons.includes("SENDER_IDENTITY_NOT_CONFIGURED"));

    assert.equal(result.deliveryEnabled, false);
  } finally {
    db.close();
  }
});

test("Disabled provider is rejected", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db, {
      provider: "disabled",
    });

    assert.ok(result.reasons.includes("PROVIDER_NOT_CONFIGURED"));

    assert.equal(result.configurationValid, false);
  } finally {
    db.close();
  }
});

test("Unsupported provider is rejected", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db, {
      provider: "unknown-provider",
    });

    assert.ok(result.reasons.includes("PROVIDER_NOT_CONFIGURED"));
  } finally {
    db.close();
  }
});

test("Invalid sender email is rejected", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db, {
      fromEmail: "not-an-email",
    });

    assert.ok(result.reasons.includes("INVALID_FROM_EMAIL"));
  } finally {
    db.close();
  }
});

test("Email header injection is rejected", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db, {
      fromEmail: "notifications@rentalco.com\r\nBcc: victim@example.com",
    });

    assert.ok(result.reasons.includes("INVALID_FROM_EMAIL"));
  } finally {
    db.close();
  }
});

test("Reserved sender domain is rejected", () => {
  const db = setup();

  try {
    configure(db, "company-a", "office@example.test");

    const result = check(db, {
      fromEmail: "notifications@example.test",
    });

    assert.ok(result.reasons.includes("RESERVED_SENDER_DOMAIN"));

    assert.equal(result.deliveryEnabled, false);
  } finally {
    db.close();
  }
});

test("Sender and reply-to domains must match", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db, {
      fromEmail: "notifications@anotherdomain.com",
    });

    assert.ok(result.reasons.includes("SENDER_DOMAIN_MISMATCH"));

    assert.ok(result.reasons.includes("VERIFIED_DOMAIN_MISMATCH"));
  } finally {
    db.close();
  }
});

test("Pending DNS verification blocks readiness", () => {
  const db = setup();

  try {
    configure(db);

    prepareSenderDomainVerification(db, "company-a", NOW);

    const result = check(db);

    assert.ok(result.reasons.includes("DOMAIN_NOT_VERIFIED"));

    assert.equal(result.configurationValid, false);
  } finally {
    db.close();
  }
});

test("Verified matching domain passes metadata checks", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db);

    assert.equal(result.configurationValid, true);
    assert.equal(result.status, "configuration_ready");
    assert.deepEqual(result.reasons, []);
    assert.equal(result.domainVerified, true);
    assert.equal(result.fromDomain, "rentalco.com");
  } finally {
    db.close();
  }
});

test("Postmark is recognized as a provider option", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db, {
      provider: "postmark",
    });

    assert.equal(result.provider, "postmark");
    assert.equal(result.configurationValid, true);
  } finally {
    db.close();
  }
});

test("Company settings remain isolated", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const companyA = check(db);

    const companyB = check(
      db,
      {
        fromEmail: "notifications@rentalco.com",
      },
      "company-b",
    );

    assert.equal(companyA.configurationValid, true);
    assert.equal(companyB.configurationValid, false);

    assert.ok(companyB.reasons.includes("SENDER_IDENTITY_NOT_CONFIGURED"));

    assert.equal(getProviderReadiness(db, "unknown-company", config()), null);
  } finally {
    db.close();
  }
});

test("Valid configuration never enables email delivery", () => {
  const db = setup();

  try {
    configure(db);
    markVerified(db);

    const result = check(db);

    assert.equal(result.configurationValid, true);
    assert.equal(result.providerConnectionVerified, false);
    assert.equal(result.sendingAuthorized, false);
    assert.equal(result.deliveryEnabled, false);
    assert.equal(result.emailsSent, 0);
  } finally {
    db.close();
  }
});
