import { fileURLToPath } from "node:url";
import { runWorkerFile, startWorkerScheduler } from "./workerScheduler.js";

const jobPath = fileURLToPath(new URL("./checkDueFollowUps.js", import.meta.url));

export function startFollowUpScheduler({ operations } = {}) {
  return startWorkerScheduler({
    name: "due",
    intervalMs: 60000,
    runJob: () => runWorkerFile(jobPath),
    runImmediately: true,
    countKeys: ["detected", "recorded", "draftsPrepared", "emailsSent"],
    operations,
  }).stop;
}
