import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const jobPath = fileURLToPath(
  new URL("./checkDueFollowUps.js", import.meta.url),
);

export function startFollowUpScheduler() {
  const intervalMs = 60 * 1000;

  let running = false;
  let stopped = false;

  function runCheck() {
    if (running || stopped) {
      return;
    }

    running = true;

    execFile(
      process.execPath,
      [jobPath],
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        running = false;

        if (stopped) {
          return;
        }

        if (error) {
          console.error("[RentFlow Scheduler] Check failed:", error.message);

          if (stderr.trim()) {
            console.error(stderr.trim());
          }

          return;
        }

        try {
          const result = JSON.parse(stdout);

          console.log(
            `[RentFlow Scheduler] Checked ${result.detected} due follow-up(s), recorded ${result.recorded}, sent ${result.emailsSent} emails.`,
          );
        } catch {
          console.error("[RentFlow Scheduler] Invalid processor response");

          if (stdout.trim()) {
            console.error(stdout.trim());
          }
        }
      },
    );
  }

  console.log("[RentFlow Scheduler] Started. Checking every 60 seconds.");

  const interval = setInterval(runCheck, intervalMs);

  runCheck();

  return function stopFollowUpScheduler() {
    stopped = true;
    clearInterval(interval);
  };
}
