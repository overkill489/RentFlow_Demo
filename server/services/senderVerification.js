import { randomBytes } from "node:crypto";
import { getSenderIdentity } from "./senderIdentity.js";

function normalizeDomain(value) {
  if (typeof value !== "string") {
    return null;
  }

  const domain = value.trim().toLowerCase();

  if (
    domain.length > 253 ||
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    return null;
  }

  return domain;
}

export function installSenderVerificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sender_domain_verifications (
      company_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      txt_name TEXT NOT NULL,
      txt_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status = 'pending'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified_at TEXT,
      last_checked_at TEXT,
      last_check_result TEXT,
      FOREIGN KEY (company_id)
        REFERENCES companies(id)
        ON DELETE CASCADE
    );
  `);

  const columns = new Set(
    db
      .prepare(
        `
      PRAGMA table_info(sender_domain_verifications)
    `,
      )
      .all()
      .map((column) => column.name),
  );

  const migrations = [
    ["verified_at", "TEXT"],
    ["last_checked_at", "TEXT"],
    ["last_check_result", "TEXT"],
  ];

  for (const [name, type] of migrations) {
    if (!columns.has(name)) {
      db.exec(`
        ALTER TABLE sender_domain_verifications
        ADD COLUMN ${name} ${type}
      `);
    }
  }
}

export function getSenderDomainReadiness(db, companyId) {
  const company = db
    .prepare(
      `
    SELECT id
    FROM companies
    WHERE id = ?
  `,
    )
    .get(companyId);

  if (!company) {
    return null;
  }

  const sender = getSenderIdentity(db, companyId);

  const domain = sender.replyToEmail
    ? normalizeDomain(sender.replyToEmail.split("@").at(-1))
    : null;

  const request = db
    .prepare(
      `
    SELECT
      domain,
      txt_name AS txtName,
      txt_value AS txtValue,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt,
      verified_at AS verifiedAt,
      last_checked_at AS lastCheckedAt,
      last_check_result AS lastCheckResult
    FROM sender_domain_verifications
    WHERE company_id = ?
  `,
    )
    .get(companyId);

  const activeRequest =
    request && domain && request.domain === domain ? request : null;

  const verified = Boolean(activeRequest?.verifiedAt);

  const reasons = [];

  if (!sender.configured) {
    reasons.push("SENDER_NOT_CONFIGURED");
  }

  if (sender.configured && !domain) {
    reasons.push("INVALID_SENDER_DOMAIN");
  }

  if (domain && !activeRequest) {
    reasons.push("VERIFICATION_NOT_REQUESTED");
  }

  if (activeRequest && !verified) {
    reasons.push("DNS_VERIFICATION_PENDING");
  }

  if (verified) {
    reasons.push("EMAIL_PROVIDER_NOT_CONFIGURED");
  }

  return {
    companyId,
    senderConfigured: sender.configured,
    senderDisplayName: sender.displayName,
    replyToEmail: sender.replyToEmail,
    domain,
    status: verified
      ? "verified"
      : activeRequest
        ? "pending_verification"
        : sender.configured && domain
          ? "not_requested"
          : "not_configured",
    dnsRecord: activeRequest
      ? {
          type: "TXT",
          name: activeRequest.txtName,
          value: activeRequest.txtValue,
        }
      : null,
    requestedAt: activeRequest?.createdAt ?? null,
    verifiedAt: activeRequest?.verifiedAt ?? null,
    lastCheckedAt: activeRequest?.lastCheckedAt ?? null,
    lastCheckResult: activeRequest?.lastCheckResult ?? null,
    reasons,
    domainVerified: verified,
    deliveryEnabled: false,
  };
}

export function prepareSenderDomainVerification(
  db,
  companyId,
  currentTime = new Date().toISOString(),
) {
  const date = new Date(currentTime);

  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid verification timestamp");
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    const readiness = getSenderDomainReadiness(db, companyId);

    if (!readiness) {
      db.exec("COMMIT");

      return {
        success: false,
        statusCode: 404,
        error: "Company not found",
      };
    }

    if (!readiness.senderConfigured || !readiness.domain) {
      db.exec("COMMIT");

      return {
        success: false,
        statusCode: 409,
        error: "Configure a valid sender identity first",
      };
    }

    if (
      readiness.status === "pending_verification" ||
      readiness.status === "verified"
    ) {
      db.exec("COMMIT");

      return {
        success: true,
        statusCode: 200,
        message: "Existing verification request returned",
        data: readiness,
      };
    }

    const now = date.toISOString();
    const token = randomBytes(32).toString("hex");
    const txtName = `_rentflow-verify.${readiness.domain}`;
    const txtValue = `rentflow-verification=${token}`;

    db.prepare(
      `
      INSERT INTO sender_domain_verifications (
        company_id,
        domain,
        txt_name,
        txt_value,
        status,
        created_at,
        updated_at,
        verified_at,
        last_checked_at,
        last_check_result
      )
      VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL)
      ON CONFLICT(company_id)
      DO UPDATE SET
        domain = excluded.domain,
        txt_name = excluded.txt_name,
        txt_value = excluded.txt_value,
        status = 'pending',
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        verified_at = NULL,
        last_checked_at = NULL,
        last_check_result = NULL
    `,
    ).run(companyId, readiness.domain, txtName, txtValue, now, now);

    const result = getSenderDomainReadiness(db, companyId);

    db.exec("COMMIT");

    return {
      success: true,
      statusCode: 201,
      message: "Sender domain verification prepared",
      data: result,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
