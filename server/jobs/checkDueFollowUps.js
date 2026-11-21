import { db } from "../database/db.js";
import { processDueFollowUps } from "./dueFollowUpProcessor.js";
import { queueDueDrafts } from "../services/queueDueDrafts.js";

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

try {
  db.exec("PRAGMA busy_timeout = 5000");

  const followUps = processDueFollowUps(db, processingTime, dryRun);

  const queue = queueDueDrafts(db, {
    currentTime: processingTime,
    dryRun,
  });

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
  console.error(error);
  process.exitCode = 1;
} finally {
  db.close();
}
