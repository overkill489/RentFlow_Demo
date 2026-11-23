import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getDeliveryReadiness } from "./deliveryReadiness.js";

const NOW = "2026-12-02T16:00:00.000Z";
const PAST = "2026-12-01T16:00:00.000Z";
const FUTURE = "2026-12-10T16:00:00.000Z";

function setup(options = {}) {
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      customer TEXT NOT NULL,
      equipment TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE quote_contacts (
      quote_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      opted_out INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE follow_ups (
      quote_id TEXT PRIMARY KEY,
      scheduled_at TEXT NOT NULL
    );

    CREATE TABLE outbound_messages (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE recipient_suppressions (
      company_id TEXT NOT NULL,
      email TEXT NOT NULL,
      PRIMARY KEY (company_id, email)
    );
  `);

  db.prepare(
    `
    INSERT INTO quotes (
      id, company_id, customer, equipment, status
    )
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    "QT-TEST",
    "company-a",
    "Test Construction",
    "CAT Excavator",
    options.status ?? "Follow-up Scheduled",
  );

  if (!options.noSchedule) {
    db.prepare(
      `
      INSERT INTO follow_ups (quote_id, scheduled_at)
      VALUES (?, ?)
    `,
    ).run("QT-TEST", options.future ? FUTURE : PAST);
  }

  if (!options.noContact) {
    db.prepare(
      `
      INSERT INTO quote_contacts (
        quote_id, email, opted_out
      )
      VALUES (?, ?, ?)
    `,
    ).run("QT-TEST", "customer@example.test", options.optedOut ? 1 : 0);
  }

  if (!options.noDraft) {
    db.prepare(
      `
      INSERT INTO outbound_messages (
        id, quote_id, recipient_email,
        subject, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "draft-1",
      "QT-TEST",
      options.wrongRecipient ? "wrong@example.test" : "customer@example.test",
      "Follow-up test",
      "draft",
      NOW,
    );
  }

  if (options.suppressed) {
    db.prepare(
      `
      INSERT INTO recipient_suppressions (
        company_id, email
      )
      VALUES (?, ?)
    `,
    ).run("company-a", "customer@example.test");
  }

  return db;
}

function check(db, company = "company-a") {
  return getDeliveryReadiness(db, company, "QT-TEST", NOW);
}

test("Eligible due reminder requires delivery review", () => {
  const db = setup();

  try {
    const result = check(db);

    assert.equal(result.status, "needs_review");
    assert.equal(result.technicallyEligible, true);
    assert.equal(result.due, true);
    assert.equal(result.reviewRequired, true);
    assert.equal(result.deliveryEnabled, false);
    assert.equal(result.emailsSent, 0);
  } finally {
    db.close();
  }
});

test("Future reminder remains scheduled", () => {
  const db = setup({ future: true });

  try {
    const result = check(db);

    assert.equal(result.status, "scheduled");
    assert.equal(result.due, false);
    assert.equal(result.technicallyEligible, true);
  } finally {
    db.close();
  }
});

test("Accepted quote is blocked", () => {
  const db = setup({ status: "Accepted" });

  try {
    const result = check(db);

    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.includes("QUOTE_ACCEPTED"));
  } finally {
    db.close();
  }
});

test("Missing contact blocks readiness", () => {
  const db = setup({ noContact: true });

  try {
    const result = check(db);

    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.includes("CONTACT_MISSING"));
  } finally {
    db.close();
  }
});

test("Quote-level opt-out blocks readiness", () => {
  const db = setup({ optedOut: true });

  try {
    const result = check(db);

    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.includes("RECIPIENT_OPTED_OUT"));
  } finally {
    db.close();
  }
});

test("Recipient-level suppression blocks readiness", () => {
  const db = setup({ suppressed: true });

  try {
    const result = check(db);

    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.includes("RECIPIENT_OPTED_OUT"));
  } finally {
    db.close();
  }
});

test("Missing draft blocks readiness", () => {
  const db = setup({ noDraft: true });

  try {
    const result = check(db);

    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.includes("ACTIVE_DRAFT_MISSING"));
  } finally {
    db.close();
  }
});

test("Draft recipient mismatch blocks readiness", () => {
  const db = setup({ wrongRecipient: true });

  try {
    const result = check(db);

    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.includes("DRAFT_RECIPIENT_MISMATCH"));
  } finally {
    db.close();
  }
});

test("Another company cannot access readiness", () => {
  const db = setup();

  try {
    assert.equal(check(db, "company-b"), null);
  } finally {
    db.close();
  }
});

test("Readiness checks never modify database data", () => {
  const db = setup();

  try {
    const before = db.prepare("SELECT * FROM outbound_messages").all();

    check(db);
    check(db);

    const after = db.prepare("SELECT * FROM outbound_messages").all();

    assert.deepEqual(after, before);
  } finally {
    db.close();
  }
});

test("Repeated readiness checks see current records on the correct connection", (t) => {
  const first = setup();
  const second = setup();
  t.after(() => {
    first.close();
    second.close();
  });

  assert.equal(check(first).status, "needs_review");
  assert.equal(check(second).status, "needs_review");
  first.exec("INSERT INTO recipient_suppressions VALUES ('company-a', 'customer@example.test')");

  assert.ok(check(first).reasons.includes("RECIPIENT_OPTED_OUT"));
  assert.equal(check(second).status, "needs_review");
  assert.equal(check(first, "company-b"), null);
});
