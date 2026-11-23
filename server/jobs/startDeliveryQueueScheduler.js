import { fileURLToPath } from "node:url";
import { runWorkerFile, startWorkerScheduler } from "./workerScheduler.js";

const jobPath = fileURLToPath(new URL("./reconcileDeliveryQueue.js", import.meta.url));

export function startDeliveryQueueScheduler({
  intervalMs = 120000,
  runJob = () => runWorkerFile(jobPath, ["--summary"]),
  logger = console,
  operations,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Invalid reconciliation interval");
  }

  return startWorkerScheduler({
    name: "reconcile",
    intervalMs,
    runJob,
    countKeys: ["scanned", "healthy", "cancelled", "draftsCancelled"],
    operations,
    logger,
  });
}
