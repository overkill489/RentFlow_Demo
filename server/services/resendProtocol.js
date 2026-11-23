export const RESEND_PROVIDER = "resend";
export const RESEND_CORRELATION_TAG = "rentflow_delivery";

export function isResendAccount(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export function isResendMessageId(value) {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}
