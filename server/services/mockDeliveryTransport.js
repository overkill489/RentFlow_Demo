import { createHash } from "node:crypto";
import { isMockMessageId } from "./mockDeliveryProtocol.js";

export function createMockDeliveryTransport({
  respond = ({ idempotencyKey }) => Response.json({
    id: `mock-${createHash("sha256").update(idempotencyKey).digest("hex")}`,
  }),
  timeoutMs = 1000,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Invalid mock delivery timeout");
  }

  return async function submit(request) {
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
        Promise.resolve().then(async () => {
          const response = await respond(request, controller.signal);
          // The fake contract defines this as rejection before acceptance.
          if (response.status === 429) return { state: "rejected", code: "RATE_LIMITED" };
          if (!response.ok) return { state: "ambiguous", code: "UNCONFIRMED_RESPONSE" };
          const { id } = await response.json();
          if (!isMockMessageId(id)) {
            return { state: "ambiguous", code: "UNCONFIRMED_RESPONSE" };
          }
          return { state: "accepted", providerMessageId: id };
        }),
      ]);
    } catch {
      return { state: "ambiguous", code: "UNCONFIRMED_RESPONSE" };
    } finally {
      clearTimeout(timer);
    }
  };
}
