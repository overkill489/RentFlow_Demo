import { setTimeout } from "node:timers/promises";

const batchSize = 50;

export async function forEachWorkerBatch(ids, processBatch) {
  for (let start = 0; start < ids.length; start += batchSize) {
    processBatch(ids.slice(start, start + batchSize));
    if (start + batchSize < ids.length) {
      // Give other processes a chance to acquire the writer lock between commits.
      await setTimeout(2);
    }
  }
}
