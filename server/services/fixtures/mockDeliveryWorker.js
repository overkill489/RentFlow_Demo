import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { attemptDelivery } from "../mockDelivery.js";
import { createMockDeliveryWebhook } from "../mockDeliveryWebhook.js";

const db = new DatabaseSync(process.argv[2]);
const currentTime = "2026-11-23T12:01:00Z";
if (process.argv[3] === "replay") {
  const [event] = await once(process, "message");
  const ingest = createMockDeliveryWebhook({ secret: Buffer.alloc(32, 7), clock: () => Date.parse(currentTime) });
  process.send(ingest(db, event), () => process.disconnect());
} else {
  await attemptDelivery(db, {
    mode: "mock",
    companyId: "a",
    queueId: "queue-a",
    providerConfig: { provider: "resend", fromEmail: "quotes@sender-a.rentflow.invalid-domain.com" },
    currentTime,
    mock: {
      timeoutMs: 30_000,
      respond: ({ idempotencyKey }) => {
        process.send({ idempotencyKey, providerMessageId: "mock-worker-accepted" });
        return new Promise(() => {});
      },
    },
  });
}
db.close();
