import process from "node:process";
import { errorKind } from "../operations.js";
import { recoverDeliveryQueue } from "../services/deliveryQueueRecovery.js";

const dryRun = process.argv.includes("--dry-run");

let db;
try {
  ({ db } = await import("../database/db.js"));
  db.exec("PRAGMA busy_timeout = 5000");

  const result = recoverDeliveryQueue(db, {
    dryRun,
  });

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: "worker_error", reason: errorKind(error) }));
  process.exitCode = 1;
} finally {
  db?.close();
}
