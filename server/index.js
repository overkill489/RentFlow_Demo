import "dotenv/config";
import process from "node:process";
import { createApp } from "./app.js";
import { db } from "./database/db.js";
import { startFollowUpScheduler } from "./jobs/startFollowUpScheduler.js";
import { recoverDeliveryQueue } from "./services/deliveryQueueRecovery.js";
import { startDeliveryQueueScheduler } from "./jobs/startDeliveryQueueScheduler.js";

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 64) {
  throw new Error("JWT_SECRET must contain a strong random secret");
}

const PORT = process.env.PORT || 5000;


const app = createApp();

const recovery = recoverDeliveryQueue(db);

console.log(
  `[RentFlow Recovery] Scanned ${recovery.scanned}, cancelled ${recovery.cancelled}, healthy ${recovery.healthy}.`,
);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`RentFlow API running on http://localhost:${PORT}`);
});

const stopFollowUpScheduler = startFollowUpScheduler();

const deliveryQueueScheduler = startDeliveryQueueScheduler();

server.on("close", () => {
  stopFollowUpScheduler();
  deliveryQueueScheduler.stop();
});
