import { isRealDeliveryEnabled } from "./deliveryGate.js";
import { isSingleMailbox, runDeliveryHandoff } from "./deliveryHandoff.js";
import { isResendAccount, isResendMessageId, RESEND_CORRELATION_TAG, RESEND_PROVIDER } from "./resendProtocol.js";

const RESEND_URL = "https://api.resend.com/emails";
const FIXTURE_URL = "https://resend.invalid/emails";
const FIXTURE_KEY = "re_rentflow_fixture_only";
const REJECTIONS = new Map([
  [400, new Set(["validation_error", "invalid_idempotency_key"])],
  [401, new Set(["missing_api_key", "restricted_api_key", "validation_error"])],
  [403, new Set(["validation_error", "invalid_permission", "restricted_api_key", "suspended_api_key"])],
  [422, new Set(["invalid_parameter", "missing_required_field", "missing_required_parameter"])],
  [429, new Set(["daily_quota_exceeded", "monthly_quota_exceeded"])],
]);

function format({ idempotencyKey, envelope }) {
  const displayName = envelope.from.name.replace(/["\\]/g, "\\$&");
  return {
    idempotencyKey,
    body: JSON.stringify({
      from: `"${displayName}" <${envelope.from.address}>`,
      to: [envelope.to],
      reply_to: envelope.replyTo,
      subject: envelope.subject,
      text: envelope.text,
      tags: [{ name: RESEND_CORRELATION_TAG, value: idempotencyKey }],
    }),
  };
}

async function readOutcome(response) {
  const ambiguous = { state: "ambiguous", code: "UNCONFIRMED_RESPONSE" };
  if (response.status >= 500 || !Number.isInteger(response.status)) return ambiguous;
  const body = await response.json();
  if (response.status === 200 && isResendMessageId(body?.id)) {
    return { state: "accepted", providerMessageId: body.id.toLowerCase() };
  }
  const name = body?.name;
  if (response.status === 409 && (name === "concurrent_idempotent_requests" || name === "invalid_idempotent_request")) {
    return { state: "ambiguous", code: "IDEMPOTENCY_CONFLICT" };
  }
  if (response.status === 429 && name === "rate_limit_exceeded") return { state: "rejected", code: "RATE_LIMITED" };
  if (REJECTIONS.get(response.status)?.has(name)) return { state: "rejected", code: "PROVIDER_REJECTED" };
  return ambiguous;
}

async function submit(request, url, apiKey, timeoutMs, { idempotencyKey, body }) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve({ state: "ambiguous", code: "TIMEOUT" });
          controller.abort();
        }, timeoutMs);
      }),
      Promise.resolve().then(async () => readOutcome(await request(url, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body,
        signal: controller.signal,
      }))),
    ]);
  } catch {
    return { state: "ambiguous", code: "UNCONFIRMED_RESPONSE" };
  } finally {
    clearTimeout(timer);
  }
}

function createDelivery({ companyId, account, fromEmail, timeoutMs = 5000, request, apiKey }, fixture) {
  if (typeof companyId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(companyId) ||
      !isResendAccount(account) || !isSingleMailbox(fromEmail) || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 30_000 || typeof request !== "function") {
    throw new Error("Invalid Resend delivery configuration");
  }
  if (fixture ? apiKey !== undefined :
    typeof apiKey !== "string" || !/^re_[a-zA-Z0-9_-]{8,200}$/.test(apiKey) || apiKey === FIXTURE_KEY) {
    throw new Error("Invalid Resend credential configuration");
  }

  return async (db, { queueId, currentTime } = {}) => {
    if (!fixture && !isRealDeliveryEnabled()) return { state: "disabled" };
    return runDeliveryHandoff(db, {
      provider: RESEND_PROVIDER, account, maxAttempts: 1, format, requireAuthorized: !fixture,
      submit: (message) => {
        if (!fixture && !isRealDeliveryEnabled()) throw new Error("Resend delivery gate closed");
        return submit(request, fixture ? FIXTURE_URL : RESEND_URL, fixture ? FIXTURE_KEY : apiKey, timeoutMs, message);
      },
    }, { companyId, queueId, currentTime, providerConfig: { provider: RESEND_PROVIDER, fromEmail } });
  };
}

export function createResendDelivery(config) {
  return createDelivery(config, false);
}

// Explicit construction for isolated fixtures with an injected HTTP responder and a reserved host.
export function createResendFixtureDelivery(config) {
  return createDelivery(config, true);
}
