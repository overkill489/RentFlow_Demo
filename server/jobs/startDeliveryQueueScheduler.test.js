import test from "node:test";
import assert from "node:assert/strict";
import { startDeliveryQueueScheduler } from "./startDeliveryQueueScheduler.js";

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
    assert.match(logs.messages[0], /Checking every 60 seconds/);
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
    assert.ok(logs.messages.some((message) => message.includes("Scanned 1")));
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
    assert.match(logs.errors[0], /Test recovery failure/);
  } finally {
    scheduler.stop();
  }
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
        (message) =>
          message.includes("cancelled 2") &&
          message.includes("drafts cancelled 2"),
      ),
    );
  } finally {
    scheduler.stop();
  }
});
