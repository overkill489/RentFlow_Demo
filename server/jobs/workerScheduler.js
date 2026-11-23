import { execFile } from "node:child_process";
import process from "node:process";
import { createOperations, workerTimeoutMs } from "../operations.js";

const failures = new Set(["sqlite_busy", "sqlite_locked", "worker_timeout", "worker_output"]);

function workerError(code) {
  return Object.assign(new Error(code), { code });
}

export function runWorkerFile(path, args = []) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path, ...args], {
      timeout: workerTimeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        let code = "worker_exit";
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") code = "worker_output";
        else if (error.killed) code = "worker_timeout";
        else if (stderr.length < 256) {
          try {
            const reason = JSON.parse(stderr)?.reason;
            if (reason === "sqlite_busy" || reason === "sqlite_locked") code = reason;
          } catch {
            // Child output is never forwarded to the API logs.
          }
        }
        reject(workerError(code));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(workerError("worker_output"));
      }
    });
  });
}

export function startWorkerScheduler({
  name, intervalMs, runJob, countKeys, runImmediately = false,
  operations, logger = console,
}) {
  const monitor = (operations ?? createOperations({ logger })).addWorker(name, intervalMs);
  let running = false;
  let stopped = false;

  async function checkNow() {
    if (running || stopped) return false;
    running = true;
    monitor.start();

    try {
      const output = await runJob();
      const counts = Object.fromEntries(countKeys.map((key) => [key, output?.[key]]));
      if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw workerError("worker_output");
      }
      monitor.finish(true, { counts });
      return true;
    } catch (error) {
      monitor.finish(false, { reason: failures.has(error?.code) ? error.code : "worker_exit" });
      return false;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void checkNow(), intervalMs);
  if (runImmediately) void checkNow();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    monitor.stop();
  }

  return { checkNow, stop };
}
