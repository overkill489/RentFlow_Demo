import { Resolver } from "node:dns/promises";
import { getSenderDomainReadiness } from "./senderVerification.js";

function isReservedDomain(domain) {
  const value = domain.toLowerCase();

  if (
    ["example.com", "example.net", "example.org"].some(
      (reserved) => value === reserved || value.endsWith(`.${reserved}`),
    )
  ) {
    return true;
  }

  return /(?:^|\.)(?:test|invalid|localhost|local|internal)$/.test(value);
}

async function defaultResolveTxt(name) {
  const resolver = new Resolver({
    timeout: 3000,
    tries: 1,
  });

  return resolver.resolveTxt(name);
}

export async function checkSenderDnsVerification(
  db,
  {
    companyId,
    currentTime = new Date().toISOString(),
    resolveTxt = defaultResolveTxt,
  },
) {
  const date = new Date(currentTime);

  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid verification timestamp");
  }

  const now = date.toISOString();

  const readiness = getSenderDomainReadiness(db, companyId);

  if (!readiness) {
    return {
      success: false,
      statusCode: 404,
      error: "Company not found",
    };
  }

  if (!readiness.dnsRecord) {
    return {
      success: false,
      statusCode: 409,
      error: "Prepare sender domain verification first",
    };
  }

  if (isReservedDomain(readiness.domain)) {
    return {
      success: false,
      statusCode: 409,
      error: "Reserved testing domains cannot be verified",
    };
  }

  const expectedName = readiness.dnsRecord.name;
  const expectedValue = readiness.dnsRecord.value;

  let matched = false;
  let checkResult;

  try {
    const records = await resolveTxt(expectedName);

    if (!Array.isArray(records)) {
      throw new Error("Invalid DNS response");
    }

    matched = records.some(
      (record) =>
        Array.isArray(record) &&
        record.every((part) => typeof part === "string") &&
        record.join("") === expectedValue,
    );

    checkResult = matched ? "TXT_MATCH" : "TXT_NOT_FOUND";
  } catch {
    checkResult = "DNS_LOOKUP_FAILED";
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    const latest = getSenderDomainReadiness(db, companyId);

    if (
      !latest ||
      latest.domain !== readiness.domain ||
      latest.dnsRecord?.name !== expectedName ||
      latest.dnsRecord?.value !== expectedValue
    ) {
      db.exec("COMMIT");

      return {
        success: false,
        statusCode: 409,
        error: "Verification request changed during DNS lookup",
      };
    }

    const update = db
      .prepare(
        `
      UPDATE sender_domain_verifications
      SET
        verified_at = CASE
          WHEN ? = 1 THEN COALESCE(verified_at, ?)
          ELSE NULL
        END,
        last_checked_at = ?,
        last_check_result = ?,
        updated_at = ?
      WHERE company_id = ?
        AND domain = ?
        AND txt_name = ?
        AND txt_value = ?
    `,
      )
      .run(
        matched ? 1 : 0,
        now,
        now,
        checkResult,
        now,
        companyId,
        readiness.domain,
        expectedName,
        expectedValue,
      );

    if (update.changes !== 1) {
      throw new Error("Verification record update failed");
    }

    const result = getSenderDomainReadiness(db, companyId);

    db.exec("COMMIT");

    return {
      success: true,
      statusCode: 200,
      message: matched
        ? "DNS ownership record verified"
        : "DNS ownership record not verified",
      dnsMatched: matched,
      checkResult,
      data: result,
      emailsSent: 0,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
