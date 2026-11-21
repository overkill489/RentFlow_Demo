import { db } from "../database/db.js";
import { recoverDeliveryQueue } from "../services/deliveryQueueRecovery.js";

const dryRun = process.argv.includes("--dry-run");

try {
  db.exec("PRAGMA busy_timeout = 5000");

  const result = recoverDeliveryQueue(db, {
    dryRun,
  });

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  db.close();
}
