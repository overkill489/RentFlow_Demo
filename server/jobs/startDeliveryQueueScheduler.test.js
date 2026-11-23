import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeliveryQueueScheduler } from "./startDeliveryQueueScheduler.js";
import { runWorkerFile } from "./workerScheduler.js";

function createLogger() {
  const messages = [];
  const errors = [];

  return {
    messages,
    errors,
    logger: {
      log(message) {
        messages.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
  };
}

function successResult(overrides = {}) {
  return {
    scanned: 1,
    healthy: 1,
    cancelled: 0,
    draftsCancelled: 0,
    ...overrides,
  };
}

function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

test("Scheduler starts with the configured interval", () => {
  const logs = createLogger();

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () => successResult(),
    logger: logs.logger,
  });

  try {
    assert.equal(logs.messages.length, 1);
    assert.equal(JSON.parse(logs.messages[0]).intervalMs, 60000);
  } finally {
    scheduler.stop();
  }
});

test("Manual check executes one reconciliation", async () => {
  const logs = createLogger();
  let calls = 0;

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () => {
      calls += 1;
      return successResult();
    },
    logger: logs.logger,
  });

  try {
    const result = await scheduler.checkNow();

    assert.equal(result, true);
    assert.equal(calls, 1);
    assert.ok(logs.messages.some((message) => JSON.parse(message).counts?.scanned === 1));
  } finally {
    scheduler.stop();
  }
});

test("Overlapping checks are prevented", async () => {
  const logs = createLogger();
  const deferred = createDeferred();
  let calls = 0;

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: () => {
      calls += 1;
      return deferred.promise;
    },
    logger: logs.logger,
  });

  try {
    const first = scheduler.checkNow();
    const second = await scheduler.checkNow();

    assert.equal(second, false);
    assert.equal(calls, 1);

    deferred.resolve(successResult());

    assert.equal(await first, true);
  } finally {
    scheduler.stop();
  }
});

test("A completed check allows another check", async () => {
  const logs = createLogger();
  let calls = 0;

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () => {
      calls += 1;
      return successResult();
    },
    logger: logs.logger,
  });

  try {
    assert.equal(await scheduler.checkNow(), true);
    assert.equal(await scheduler.checkNow(), true);
    assert.equal(calls, 2);
  } finally {
    scheduler.stop();
  }
});

test("Failed reconciliation is logged", async () => {
  const logs = createLogger();

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () => {
      throw new Error("Test recovery failure");
    },
    logger: logs.logger,
  });

  try {
    const result = await scheduler.checkNow();

    assert.equal(result, false);
    assert.equal(logs.errors.length, 1);
    assert.equal(JSON.parse(logs.errors[0]).reason, "worker_exit");
    assert.doesNotMatch(logs.errors[0], /Test recovery failure/);
  } finally {
    scheduler.stop();
  }
});

test("worker process output is reduced to safe failure codes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rentflow-worker-logs-"));
  const file = join(directory, "worker.cjs");
  writeFileSync(file, 'console.log("synthetic-body"); console.error("synthetic-token"); process.exitCode = 1;');
  await assert.rejects(runWorkerFile(file), { code: "worker_exit", message: "worker_exit" });

  writeFileSync(file, 'console.error(JSON.stringify({ reason: "sqlite_busy" })); process.exitCode = 1;');
  await assert.rejects(runWorkerFile(file), { code: "sqlite_busy", message: "sqlite_busy" });

  writeFileSync(file, 'console.log("synthetic-provider-secret");');
  await assert.rejects(runWorkerFile(file), { code: "worker_output", message: "worker_output" });
});

test("Scheduler recovers after a failed check", async () => {
  const logs = createLogger();
  let calls = 0;

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error("Temporary error");
      }

      return successResult();
    },
    logger: logs.logger,
  });

  try {
    assert.equal(await scheduler.checkNow(), false);
    assert.equal(await scheduler.checkNow(), true);
    assert.equal(calls, 2);
  } finally {
    scheduler.stop();
  }
});

test("Stopping prevents future manual checks", async () => {
  const logs = createLogger();
  let calls = 0;

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () => {
      calls += 1;
      return successResult();
    },
    logger: logs.logger,
  });

  scheduler.stop();

  const result = await scheduler.checkNow();

  assert.equal(result, false);
  assert.equal(calls, 0);
});

test("Stopping twice is safe", () => {
  const logs = createLogger();

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () => successResult(),
    logger: logs.logger,
  });

  scheduler.stop();
  scheduler.stop();

  assert.equal(logs.errors.length, 0);
});

test("Invalid intervals are rejected", () => {
  assert.throws(
    () =>
      startDeliveryQueueScheduler({
        intervalMs: 0,
      }),
    /Invalid reconciliation interval/,
  );

  assert.throws(
    () =>
      startDeliveryQueueScheduler({
        intervalMs: -1000,
      }),
    /Invalid reconciliation interval/,
  );
});

test("Scheduler reports cancellation counts", async () => {
  const logs = createLogger();

  const scheduler = startDeliveryQueueScheduler({
    intervalMs: 60000,
    runJob: async () =>
      successResult({
        scanned: 4,
        healthy: 2,
        cancelled: 2,
        draftsCancelled: 2,
      }),
    logger: logs.logger,
  });

  try {
    assert.equal(await scheduler.checkNow(), true);

    assert.ok(
      logs.messages.some(
        (message) => {
          const { counts } = JSON.parse(message);
          return counts?.cancelled === 2 && counts.draftsCancelled === 2;
        },
      ),
    );
  } finally {
    scheduler.stop();
  }
});
