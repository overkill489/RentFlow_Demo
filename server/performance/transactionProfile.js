import { performance } from "node:perf_hooks";

export function profileTransactions(db, getContext) {
  const exec = db.exec.bind(db);
  const clock = () => performance.timeOrigin + performance.now();
  let active;
  let transactions = [];
  let busy = [];

  db.exec = (sql) => {
    const begin = sql === "BEGIN IMMEDIATE";
    const end = sql === "COMMIT" || sql === "ROLLBACK";
    if (!begin && !end) return exec(sql);

    const started = clock();
    try {
      const result = exec(sql);
      const finished = clock();
      if (begin) active = { context: getContext(), started, acquired: finished };
      else if (active) {
        transactions.push({ ...active, finished, outcome: sql });
        active = undefined;
      }
      return result;
    } catch (error) {
      if ((error.errcode & 255) === 5) {
        busy.push({ context: getContext(), operation: sql, started, finished: clock() });
      }
      throw error;
    }
  };

  return function takeProfile(includeWindows = false) {
    const groups = Object.groupBy(transactions, ({ context }) => context);
    const writes = Object.fromEntries(Object.entries(groups).map(([name, rows]) => {
      const holds = rows.map(({ acquired, finished }) => finished - acquired).sort((a, b) => a - b);
      return [name, {
        count: rows.length, rollbacks: rows.filter(({ outcome }) => outcome === "ROLLBACK").length,
        holdP95Ms: holds[Math.ceil(holds.length * 0.95) - 1], holdMaxMs: holds.at(-1),
        holdTotalMs: holds.reduce((sum, value) => sum + value, 0),
        beginWaitMaxMs: Math.max(...rows.map(({ started, acquired }) => acquired - started)),
      }];
    }));
    const profile = { writes, busy, ...(includeWindows && { windows: transactions }) };
    transactions = [];
    busy = [];
    return profile;
  };
}
