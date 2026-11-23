import { createHash } from "node:crypto";

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
            resolve({ state: "uncertain" });
            controller.abort();
          }, timeoutMs);
        }),
        Promise.resolve().then(async () => {
          const response = await respond(request, controller.signal);
          // The fake contract defines this as rejection before acceptance.
          if (response.status === 429) return { state: "retryable" };
          if (!response.ok) return { state: "uncertain" };
          const { id } = await response.json();
          if (typeof id !== "string" || !/^mock-[a-zA-Z0-9_-]{1,120}$/.test(id)) {
            return { state: "uncertain" };
          }
          return { state: "accepted", providerMessageId: id };
        }),
      ]);
    } catch {
      return { state: "uncertain" };
    } finally {
      clearTimeout(timer);
    }
  };
}
