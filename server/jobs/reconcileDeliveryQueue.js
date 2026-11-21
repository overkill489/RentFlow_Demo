import process from "node:process";
import { db } from "../database/db.js";
import { recoverDeliveryQueue } from "../services/deliveryQueueRecovery.js";

try {
  db.exec("PRAGMA busy_timeout = 5000");

  const result = recoverDeliveryQueue(db, {
    includeEntries: !process.argv.includes("--summary"),
  });

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  db.close();
}
