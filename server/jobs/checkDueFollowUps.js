import process from "node:process";
import { errorKind } from "../operations.js";
import { processDueFollowUps, processDueFollowUpsInBatches } from "./dueFollowUpProcessor.js";
import { queueDueDrafts, queueDueDraftsInBatches } from "../services/queueDueDrafts.js";

const args = process.argv.slice(2);

const dryRun = args.includes("--dry-run");

const atArgument = args.find((arg) => arg.startsWith("--at="));

if (atArgument && !dryRun) {
  console.error("--at requires --dry-run");
  process.exit(1);
}

const processingTime = atArgument
  ? atArgument.slice(5)
  : new Date().toISOString();

let db;
try {
  ({ db } = await import("../database/db.js"));
  db.exec("PRAGMA busy_timeout = 5000");

  const followUps = dryRun
    ? processDueFollowUps(db, processingTime, true)
    : await processDueFollowUpsInBatches(db, processingTime);

  const queue = dryRun
    ? queueDueDrafts(db, { currentTime: processingTime, dryRun: true })
    : await queueDueDraftsInBatches(db, { currentTime: processingTime });

  const result = {
    ...followUps,
    queue: {
      scanned: queue.scanned,
      eligible: queue.eligible,
      queued: queue.queued,
      alreadyQueued: queue.alreadyQueued,
      blocked: queue.blocked,
    },
    emailsSent: 0,
  };

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: "worker_error", reason: errorKind(error) }));
  process.exitCode = 1;
} finally {
  db?.close();
}
