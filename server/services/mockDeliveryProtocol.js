export const MOCK_PROVIDER = "mock";
export const DEFAULT_MOCK_ACCOUNT = "mock-default";
export const MOCK_EVENT_TYPES = new Set(["delivered", "soft_bounce", "hard_bounce", "complaint"]);

export function isMockAccount(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export function isMockMessageId(value) {
  return typeof value === "string" && /^mock-[a-zA-Z0-9_-]{1,120}$/.test(value);
}
