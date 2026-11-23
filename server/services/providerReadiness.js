import { getSenderIdentity } from "./senderIdentity.js";
import { isRealDeliveryEnabled } from "./deliveryGate.js";
import { getSenderDomainReadiness } from "./senderVerification.js";

const SUPPORTED_PROVIDERS = new Set(["resend", "postmark"]);

function normalizeEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    // eslint-disable-next-line no-control-regex -- reject control characters in mail headers
    /[\x00-\x20\x7f<>]/.test(value) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  ) {
    return null;
  }

  const email = value.toLowerCase();
  const [local, domain] = email.split("@");

  if (!local || local.length > 64 || !domain || domain.length > 253) {
    return null;
  }

  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    return null;
  }

  return email;
}

function isReservedDomain(domain) {
  if (!domain) {
    return true;
  }

  if (
    ["example.com", "example.net", "example.org"].some(
      (value) => domain === value || domain.endsWith(`.${value}`),
    )
  ) {
    return true;
  }

  return /(?:^|\.)(?:test|invalid|localhost|local|internal)$/.test(domain);
}

export function getProviderReadiness(db, companyId, config = {}) {
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
  const verification = getSenderDomainReadiness(db, companyId);

  const provider =
    typeof config.provider === "string"
      ? config.provider.trim().toLowerCase()
      : "disabled";

  const fromEmail =
    typeof config.fromEmail === "string"
      ? normalizeEmail(config.fromEmail.trim())
      : null;

  const fromDomain = fromEmail ? fromEmail.split("@").at(-1) : null;

  const replyToDomain = sender.replyToEmail
    ? sender.replyToEmail.split("@").at(-1)
    : null;

  const reasons = [];

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    reasons.push("PROVIDER_NOT_CONFIGURED");
  }

  if (typeof config.fromEmail !== "string" || !fromEmail) {
    reasons.push("INVALID_FROM_EMAIL");
  }

  if (!sender.configured) {
    reasons.push("SENDER_IDENTITY_NOT_CONFIGURED");
  }

  if (fromDomain && isReservedDomain(fromDomain)) {
    reasons.push("RESERVED_SENDER_DOMAIN");
  }

  if (fromDomain && replyToDomain && fromDomain !== replyToDomain) {
    reasons.push("SENDER_DOMAIN_MISMATCH");
  }

  if (
    !verification ||
    !verification.domainVerified ||
    verification.lastCheckResult !== "TXT_MATCH"
  ) {
    reasons.push("DOMAIN_NOT_VERIFIED");
  }

  if (
    verification?.domainVerified &&
    fromDomain &&
    verification.domain !== fromDomain
  ) {
    reasons.push("VERIFIED_DOMAIN_MISMATCH");
  }

  if (verification?.domainVerified && isReservedDomain(verification.domain)) {
    reasons.push("RESERVED_VERIFIED_DOMAIN");
  }

  const configurationValid = reasons.length === 0;

  return {
    companyId,
    provider,
    fromEmail,
    fromDomain,
    senderDisplayName: sender.displayName,
    replyToEmail: sender.replyToEmail,
    senderConfigured: sender.configured,
    domain: verification?.domain ?? null,
    domainVerified: verification?.domainVerified ?? false,
    domainLastCheckedAt: verification?.lastCheckedAt ?? null,
    configurationValid,
    status: configurationValid
      ? "configuration_ready"
      : "configuration_incomplete",
    reasons,
    providerConnectionVerified: false,
    sendingAuthorized: false,
    deliveryEnabled: isRealDeliveryEnabled(),
    emailsSent: 0,
  };
}
