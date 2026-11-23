import "dotenv/config";
import { once } from "node:events";
import process from "node:process";
import { startFollowUpScheduler } from "./jobs/startFollowUpScheduler.js";
import { recoverDeliveryQueue } from "./services/deliveryQueueRecovery.js";
import { startDeliveryQueueScheduler } from "./jobs/startDeliveryQueueScheduler.js";
import { createOperations, errorKind } from "./operations.js";

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

const metricsToken = process.env.RENTFLOW_METRICS_TOKEN ?? "";
if (metricsToken && (!/^[A-Za-z0-9_-]{32,128}$/.test(metricsToken) || metricsToken === process.env.JWT_SECRET)) {
  throw new Error("RENTFLOW_METRICS_TOKEN must be a separate 32–128 character URL-safe token");
}

async function start() {
  // The app imports write-capable schema bootstrap. Validate process settings first.
  const { createApp } = await import("./app.js");
  const { db } = await import("./database/db.js");
  const app = createApp({ trustLoopbackProxy: proxySetting === "1", metricsToken });
  const operations = app.locals.operations;

  const recovery = recoverDeliveryQueue(db, { includeEntries: false });

  operations.log("startup_recovery", {
    scanned: recovery.scanned, cancelled: recovery.cancelled, healthy: recovery.healthy,
  });

  const server = app.listen(Number(portSetting), "127.0.0.1");
  await once(server, "listening");

  const stopFollowUpScheduler = startFollowUpScheduler({ operations });

  const deliveryQueueScheduler = startDeliveryQueueScheduler({ operations });

  function stopSchedulers() {
    stopFollowUpScheduler();
    deliveryQueueScheduler.stop();
  }

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    operations.beginShutdown();
    operations.log("shutdown_started");
    stopSchedulers();
    server.close();
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.once("close", () => {
    stopSchedulers();
    db.close();
    operations.log("http_drain_complete");
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  });

  operations.log("api_listening", { port: server.address().port });
}

try {
  await start();
} catch (error) {
  createOperations().log("startup_failed", { reason: errorKind(error) }, "error");
  process.exitCode = 1;
}
