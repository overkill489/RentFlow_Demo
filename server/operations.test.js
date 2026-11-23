import assert from "node:assert/strict";
import test from "node:test";
import { createOperations } from "./operations.js";

test("worker grace expires and repeated failures clear only after a successful run", () => {
  const lines = [];
  let now = 0;
  const operations = createOperations({
    clock: () => now,
    logger: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  const worker = operations.addWorker("reconcile", 120000);
  now = 164999;
  assert.equal(operations.ready(), true);
  now++;
  assert.equal(operations.ready(), false);
  assert.equal(operations.snapshot().workers.reconcile.status, "overdue");

  for (let attempt = 0; attempt < 2; attempt++) {
    worker.start();
    worker.finish(false, { reason: "sqlite_busy" });
  }
  const failed = operations.snapshot();
  assert.equal(failed.workers.reconcile.status, "failing");
  assert.equal(failed.workers.reconcile.failures, 2);
  assert.equal(failed.errors.sqliteBusy, 2);
  assert.equal(operations.ready(), false);

  worker.start();
  worker.finish(true, { counts: { scanned: 2 } });
  assert.equal(operations.ready(), true);
  assert.equal(operations.snapshot().workers.reconcile.consecutiveFailures, 0);
  now += 285000;
  assert.equal(operations.snapshot().workers.reconcile.status, "overdue");
  assert.equal(operations.ready(), false);
  assert.equal(lines.map(JSON.parse).filter(({ event }) => event === "worker_failed").length, 2);
});
