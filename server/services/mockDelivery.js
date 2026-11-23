import { isRealDeliveryEnabled } from "./deliveryGate.js";
import { runDeliveryHandoff } from "./deliveryHandoff.js";
import { DEFAULT_MOCK_ACCOUNT, isMockAccount, MOCK_PROVIDER } from "./mockDeliveryProtocol.js";
import { createMockDeliveryTransport } from "./mockDeliveryTransport.js";

// The application does not install the ledger or invoke this mock workflow.
export async function attemptDelivery(db, { mode, mock, account = DEFAULT_MOCK_ACCOUNT, ...options } = {}) {
  if (mode !== "mock" && !isRealDeliveryEnabled()) return { state: "disabled" };
  if (mode !== "mock") return { state: "unsupported" };
  if (!isMockAccount(account)) throw new Error("Invalid mock delivery account");

  return runDeliveryHandoff(db, {
    provider: MOCK_PROVIDER, account, maxAttempts: 3,
    format: (message) => message,
    submit: createMockDeliveryTransport(mock),
  }, options);
}
