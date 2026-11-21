import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const jobPath = fileURLToPath(
  new URL("./reconcileDeliveryQueue.js", import.meta.url),
);

function executeRecoveryJob() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [jobPath, "--summary"],
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));

          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid recovery response"));
        }
      },
    );
  });
}

export function startDeliveryQueueScheduler({
  intervalMs = 120000,
  runJob = executeRecoveryJob,
  logger = console,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Invalid reconciliation interval");
  }

  let running = false;
  let stopped = false;

  async function checkNow() {
    if (running || stopped) {
      return false;
    }

    running = true;

    try {
      const result = await runJob();

      if (!stopped) {
        logger.log(
          `[RentFlow Queue] Scanned ${result.scanned}, healthy ${result.healthy}, cancelled ${result.cancelled}, drafts cancelled ${result.draftsCancelled}.`,
        );
      }

      return true;
    } catch (error) {
      if (!stopped) {
        logger.error(
          `[RentFlow Queue] Reconciliation failed: ${error.message}`,
        );
      }

      return false;
    } finally {
      running = false;
    }
  }

  logger.log(
    `[RentFlow Queue] Scheduler started. Checking every ${intervalMs / 1000} seconds.`,
  );

  const interval = setInterval(() => {
    void checkNow();
  }, intervalMs);

  function stop() {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(interval);
  }

  return {
    checkNow,
    stop,
  };
}
