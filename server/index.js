import "dotenv/config";
import { once } from "node:events";
import process from "node:process";
import { startFollowUpScheduler } from "./jobs/startFollowUpScheduler.js";
import { recoverDeliveryQueue } from "./services/deliveryQueueRecovery.js";
import { startDeliveryQueueScheduler } from "./jobs/startDeliveryQueueScheduler.js";

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 64) {
  throw new Error("JWT_SECRET must contain a strong random secret");
}

if (process.env.NODE_ENV === "production" && !process.env.RENTFLOW_SQLITE_PATH) {
  throw new Error("Production requires an explicit RENTFLOW_SQLITE_PATH");
}

const portSetting = process.env.PORT ?? "5000";
if (!/^\d{1,5}$/.test(portSetting) || Number(portSetting) > 65535) {
  throw new Error("PORT must be an integer from 0 to 65535");
}

const proxySetting = process.env.RENTFLOW_TRUST_LOOPBACK_PROXY ?? "0";
if (!["0", "1"].includes(proxySetting)) {
  throw new Error("RENTFLOW_TRUST_LOOPBACK_PROXY must be 0 or 1");
}

// The app imports write-capable schema bootstrap. Validate process settings first.
const { createApp } = await import("./app.js");
const { db } = await import("./database/db.js");
const app = createApp({ trustLoopbackProxy: proxySetting === "1" });

const recovery = recoverDeliveryQueue(db);

console.log(
  `[RentFlow Recovery] Scanned ${recovery.scanned}, cancelled ${recovery.cancelled}, healthy ${recovery.healthy}.`,
);

const server = app.listen(Number(portSetting), "127.0.0.1");
await once(server, "listening");

const stopFollowUpScheduler = startFollowUpScheduler();

const deliveryQueueScheduler = startDeliveryQueueScheduler();

function stopSchedulers() {
  stopFollowUpScheduler();
  deliveryQueueScheduler.stop();
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  stopSchedulers();
  server.close();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.once("close", () => {
  stopSchedulers();
  db.close();
  process.off("SIGTERM", shutdown);
  process.off("SIGINT", shutdown);
});

console.log(`RentFlow API running on http://127.0.0.1:${server.address().port}`);
