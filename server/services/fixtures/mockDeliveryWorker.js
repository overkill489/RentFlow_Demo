import { DatabaseSync } from "node:sqlite";
import { attemptDelivery } from "../mockDelivery.js";

const db = new DatabaseSync(process.argv[2]);
await attemptDelivery(db, {
  mode: "mock",
  companyId: "a",
  queueId: "queue-a",
  providerConfig: { provider: "resend", fromEmail: "quotes@sender-a.rentflow.invalid-domain.com" },
  currentTime: "2026-11-23T12:01:00Z",
  mock: {
    timeoutMs: 30_000,
    respond: () => {
      process.send("claimed");
      return new Promise(() => {});
    },
  },
});
db.close();
