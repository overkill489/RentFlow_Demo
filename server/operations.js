import { performance } from "node:perf_hooks";

export const workerTimeoutMs = 30000;
const startupMarginMs = 15000;
const stallMs = workerTimeoutMs + 10000;
const requestLogLimit = 12;

export function errorKind(error) {
  if (error?.type === "entity.parse.failed") return "invalid_json";
  if ((error?.errcode & 255) === 5) return "sqlite_busy";
  if ((error?.errcode & 255) === 6) return "sqlite_locked";
  return "internal_error";
}

export function createOperations({
  probe = () => {},
  clock = () => performance.now(),
  logger = console,
} = {}) {
  const workers = new Map();
  const requests = { completed: 0, clientErrors: 0, serverErrors: 0, aborted: 0 };
  const errors = { sqliteBusy: 0, sqliteLocked: 0, suppressedLogs: 0 };
  let databaseProbeFailures = 0;
  let stopping = false;
  let windowStart = clock();
  let logged = 0;

  function log(event, fields = {}, level = "log") {
    logger[level](JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
  }

  function recordSqliteError(kind) {
    if (kind === "sqlite_busy") errors.sqliteBusy++;
    if (kind === "sqlite_locked") errors.sqliteLocked++;
  }

  function requestError(kind) {
    recordSqliteError(kind);
    if (kind === "invalid_json") return;
    const now = clock();
    if (now - windowStart >= 60000) {
      windowStart = now;
      logged = 0;
    }
    if (logged >= requestLogLimit) {
      errors.suppressedLogs++;
      return;
    }
    logged++;
    log("http_error", { reason: kind }, "error");
  }

  function status(worker, now) {
    if (worker.stopped) return "stopped";
    if (worker.activeAt !== null && now - worker.activeAt >= stallMs) return "stalled";
    if (worker.consecutiveFailures >= 2) return "failing";
    const graceMs = worker.intervalMs + workerTimeoutMs + startupMarginMs;
    if (worker.lastSuccessAt === null) {
      return now - worker.startedAt >= graceMs ? "overdue" : "starting";
    }
    return now - worker.lastSuccessAt >= graceMs + worker.intervalMs ? "overdue" : "healthy";
  }

  function addWorker(name, intervalMs) {
    const worker = {
      intervalMs, startedAt: clock(), activeAt: null, lastSuccessAt: null,
      runs: 0, failures: 0, consecutiveFailures: 0, stopped: false,
    };
    workers.set(name, worker);
    log("worker_scheduled", { worker: name, intervalMs });
    return {
      start() {
        worker.runs++;
        worker.activeAt = clock();
      },
      finish(ok, details) {
        const now = clock();
        const durationMs = Math.round(now - worker.activeAt);
        worker.activeAt = null;
        if (ok) {
          worker.lastSuccessAt = now;
          worker.consecutiveFailures = 0;
          log("worker_succeeded", { worker: name, durationMs, ...details });
        } else {
          worker.failures++;
          worker.consecutiveFailures++;
          recordSqliteError(details.reason);
          log("worker_failed", { worker: name, durationMs, reason: details.reason }, "error");
        }
      },
      stop() {
        worker.stopped = true;
      },
    };
  }

  return {
    log,
    addWorker,
    requestError,
    observeResponse(res) {
      res.once("finish", () => {
        requests.completed++;
        if (res.statusCode >= 500) requests.serverErrors++;
        else if (res.statusCode >= 400) requests.clientErrors++;
      });
      res.once("close", () => {
        if (!res.writableFinished) requests.aborted++;
      });
    },
    beginShutdown() {
      stopping = true;
    },
    ready() {
      if (stopping) return false;
      const now = clock();
      for (const worker of workers.values()) {
        if (!["starting", "healthy"].includes(status(worker, now))) return false;
      }
      try {
        probe();
        return true;
      } catch (error) {
        databaseProbeFailures++;
        recordSqliteError(errorKind(error));
        return false;
      }
    },
    snapshot() {
      const now = clock();
      return {
        requests: { ...requests },
        errors: { ...errors },
        databaseProbeFailures,
        workers: Object.fromEntries(Array.from(workers, ([name, worker]) => [name, {
          status: status(worker, now),
          runs: worker.runs,
          failures: worker.failures,
          consecutiveFailures: worker.consecutiveFailures,
          lastSuccessAgeMs: worker.lastSuccessAt === null ? null : Math.round(now - worker.lastSuccessAt),
        }])),
      };
    },
  };
}
