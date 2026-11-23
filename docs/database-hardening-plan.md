# RentFlow SQLite hardening plan

Based on the [production-readiness audit](production-readiness-audit.md) and the current SQLite initialization, write paths and jobs. Ranks reflect data safety and operational impact. Any schema migration or potentially destructive operation requires explicit approval before execution.

| Risk rank | Finding and exact files | Action and acceptance criteria |
| --- | --- | --- |
| 1 · High · H1 | Import-time initialization combines file creation, demo seeding, DDL and backfill. See [db.js:12](../server/database/db.js#L12), [followups.js:10](../server/routes/followups.js#L10), [delivery.js:9](../server/routes/delivery.js#L9), [deliveryQueue.js:9](../server/routes/deliveryQueue.js#L9), [deliveryQueueAudit.js:1](../server/services/deliveryQueueAudit.js#L1) and [senderVerification.js:23](../server/services/senderVerification.js#L23). | Establish a configurable persistent database path, a SQLite-aware snapshot and restore runbook, an ordered migration ledger with a single writer, and explicit demo seeding. API and jobs should verify schema compatibility at startup. Test empty and legacy disposable files, concurrent initialization, fault injection and interrupted upgrades. A restored snapshot must pass integrity and FK checks and preserve tenant ownership, counts and suppression state within agreed recovery objectives. Confirm dry-run CLIs leave an existing fixture untouched and do not create a database for a missing path. |
| 2 · High · H2 | Quote, schedule and draft mutations read state before the write lock. See [quotes.js:182](../server/routes/quotes.js#L182), [followups.js:229](../server/routes/followups.js#L229), [followups.js:333](../server/routes/followups.js#L333) and [delivery.js:383](../server/routes/delivery.js#L383). [deliveryQueueLifecycle.js:97](../server/services/deliveryQueueLifecycle.js#L97) already takes the lock before validation. | Put state-dependent reads and writes inside the same short transaction or use guarded writes and check affected rows. Use two connections to a disposable file to verify accepted quotes stay accepted, each schedule is consumed once, one active draft survives a concurrent insert, and draft recipient and suppression checks reflect current state. Preserve tenant scoping and existing response contracts. |
| 3 · High · H3 | Due processing and reconciliation take an immediate writer lock before unbounded scans. See [dueFollowUpProcessor.js:125](../server/jobs/dueFollowUpProcessor.js#L125), [queueDueDrafts.js:72](../server/services/queueDueDrafts.js#L72), [deliveryQueueRecovery.js:120](../server/services/deliveryQueueRecovery.js#L120) and [deliveryReadiness.js:13](../server/services/deliveryReadiness.js#L13). The jobs set a busy timeout after bootstrap in [checkDueFollowUps.js:20](../server/jobs/checkDueFollowUps.js#L20) and [reconcileDeliveryQueue.js:4](../server/jobs/reconcileDeliveryQueue.js#L4). | Select actionable work in bounded batches and preserve deduplication. Establish worker ownership, a common connection policy, bounded contention handling and backlog health. Validate journal mode and checkpoint behavior on the intended storage before changing them. On a 100-tenant, 100,000-quote fixture with skew and concurrent API writes, measure lock hold time, busy failures and queue lag against agreed limits. Kill workers between batches and between draft and queue commits. Confirm replay makes progress without duplicates or starvation. |
| 4 · High · H4 · Implemented here | [startDeliveryQueueScheduler.js:8](../server/jobs/startDeliveryQueueScheduler.js#L8) buffers at most 1 MiB. [reconcileDeliveryQueue.js:4](../server/jobs/reconcileDeliveryQueue.js#L4) previously emitted per-entry JSON after committing. | The scheduler requests a summary and [deliveryQueueRecovery.js](../server/services/deliveryQueueRecovery.js) skips accumulating per-entry diagnostics in that mode. A disposable SQLite backlog whose detailed response exceeds 1 MiB must return a small summary with correct counts. Invalid entries must still be cancelled and a repeat sweep must preserve terminal state. Detailed operator and dry-run output remain available. This fix addresses output growth. Writer lock duration is tracked in rank 3. |
| 5 · Medium · M1/M2/M5 | [db.js:115](../server/database/db.js#L115) indexes company and company/status, [followups.js:32](../server/routes/followups.js#L32) indexes schedule time, and [delivery.js:9](../server/routes/delivery.js#L9) enforces active-draft uniqueness. [quotes.js:14](../server/routes/quotes.js#L14) sorts by a cast of the display ID and [quotes.js:40](../server/routes/quotes.js#L40) allocates IDs with a global expression. [deliveryQueue.js:130](../server/routes/deliveryQueue.js#L130) and [unsubscribeService.js:209](../server/services/unsubscribeService.js#L209) also have scale-sensitive reads or writes. | Capture `EXPLAIN QUERY PLAN` and timings for tenant lists, due scans, queue recovery and normalized suppression updates on realistic synthetic data. Apply targeted indexes only after review and approval. Plan pagination on stable indexed ordering and replace the global ID scan without changing existing IDs. Verify tenant isolation, stable ordering, suppression behavior, query latency and index write cost before rollout. |

The output-size fix in rank 4 was implemented first. The recovery change below partially addresses rank 3. Ranks 1–3 remain release risks.

## SQLite contention investigation · 2026-11-23

- **Connections and lock policy.** The API and each child or manual job open one synchronous connection per process through [db.js](../server/database/db.js). Bootstrap runs create, seed, schema installation and backfill work before the jobs can set their busy handler. The API uses the Node default. Node v24.22.3 reported a default busy timeout of 0 ms on the disposable fixture. The [due job](../server/jobs/checkDueFollowUps.js), [reconciler](../server/jobs/reconcileDeliveryQueue.js) and [manual recovery](../server/jobs/recoverDeliveryQueue.js) each set 5,000 ms after bootstrap. The application sets no journal mode or checkpoint policy. The fixture used SQLite's default DELETE journal mode.
- **Transactions.** Demo seeding uses a deferred transaction. Explicit request writes use immediate transactions for auth, quote and schedule mutation, contacts, draft and queue lifecycle, sender verification, preflight audit and unsubscribe confirmation. Sender settings and unsubscribe token insertion also have single-statement writes. Password hashing and DNS resolution run before the corresponding immediate write transactions. Quote, schedule and manual draft checks identified in rank 2 still need cross-connection validation. Recipient-wide suppression and trigger updates, auth revocation cleanup, and import-time schema/backfill work are additional potential sources of writer hold time.
- **Jobs and recovery.** The due worker records due events and drafts in one immediate transaction and queues drafts in a separate immediate transaction. Both materialize unbounded candidate lists. A restart can pick up committed drafts from a prior pass. Recovery runs synchronously before API listen, through a separate scheduled child, and through the operator CLI. The due scheduler fires immediately and then every 60 seconds, and reconciliation runs every 120 seconds. Each scheduler skips local self-overlap and gives its child 30 seconds. The two jobs and jobs from different API processes can overlap. CLI dry runs still import the write-capable bootstrap.

On a temporary on-disk database, one connection opened an immediate transaction and inserted an uncommitted suppression for company B while company A's healthy queue entry was pending. With a 0 ms timeout, baseline recovery failed at `BEGIN IMMEDIATE` with SQLite error 5 (`SQLITE_BUSY`). The same test now reports one healthy entry while the second connection still holds its writer reservation. After that connection commits, company A's entry remains healthy. A second test removes a company A suppression on the other connection between the read and write phases and verifies that recovery preserves the queue entry and draft.

The recovery service now inspects a consistent read snapshot first. If it encounters a possible cancellation, it ends that snapshot, obtains the writer lock and recomputes the pass from current state. Queue and draft cancellations still commit together, with the existing audit triggers and tenant-scoped readiness rules. A healthy pass takes no writer reservation. Recovery's detailed and summary counts come from the completed pass.

| Healthy fixture, 100 companies and 10,000 pending entries | Baseline | After |
| --- | ---: | ---: |
| Median transaction duration | 812.37 ms | 773.29 ms |
| Median writer reservation held by recovery | 812.37 ms | 0 ms |

Measurements used a disposable indexed file, one warm-up pass per version, then five alternating summary-mode passes per version. Transaction time ran from successful begin through commit. Before the change, measured writer holds ranged from 690.46 to 860.71 ms. The after-change read transactions ranged from 719.66 to 814.02 ms. The benchmark timed recovery itself. The two-connection regression separately verified actual contention and did not depend on elapsed time.

With DELETE journaling, the read snapshot can still delay another writer's exclusive commit. When cancellation is required, recovery can repeat part of the scan and still holds the writer lock for the full cancellation pass. Bounded batches, worker ownership, a common connection policy and measurements on intended deployment storage remain open. The due and draft-queue sweeps also remain open under rank 3.

Backend verification on Node v24.22.3 with `node --test --test-reporter=spec server/jobs/*.test.js server/services/*.test.js` yielded 179 passed, 0 failed, 0 skipped, and 0 cancelled.

## DELETE versus WAL · 2026-11-23

### Connection inventory

The [database module](../server/database/db.js) is the only application connection factory. API routes, auth middleware and startup recovery share one synchronous connection. The due worker, scheduled reconciler and manual recovery CLI each import the same module and open their own connection. Dry-run CLI invocations follow the same configuration path.

| Connection or phase | `journal_mode` | `busy_timeout` | `foreign_keys` | `synchronous` |
| --- | --- | ---: | --- | --- |
| API and startup recovery | Inherits file mode, DELETE on a fresh file | 0 ms | ON by Node default, also set in bootstrap and the follow-up router | Runtime default, FULL (2) on the fixture |
| Due worker, reconciler and manual recovery during import-time bootstrap | Inherits file mode | 0 ms | ON by Node default, also set in bootstrap | Runtime default, FULL (2) on the fixture |
| Those three CLI entry points after bootstrap | Inherits file mode | 5,000 ms | ON | Runtime default, FULL (2) on the fixture |

Settings were traced in source and verified on disposable connections using Node v24.22.3 and embedded SQLite 3.54.1. The checked-in code sets neither journal mode nor synchronous level. The application database's file mode was not queried. The isolated WAL connections also reported `wal_autocheckpoint=1000` pages, SQLite's default on this build. Existing unit-test connections use in-memory fixtures except the recovery file-backed restart and contention tests. The new journal tests open their own on-disk fixtures.

### Measured writer contention

Two independent Node processes shared each disposable database on the Windows host's local NTFS temporary directory. The reader ran the actual summary-mode recovery against 10,000 healthy pending entries across 100 companies, using the recovery fixture schema and the relevant queue and draft indexes. After the reader established its snapshot, a child began an immediate transaction and inserted one unrelated synthetic suppression. A pre-commit marker coordinated the overlap and a post-commit-attempt marker recorded whether the attempt returned before the reader released its snapshot. Each condition used one warm-up and five measured runs. The snapshots below include synchronization overhead. Commit timing covers the synchronous SQLite call only. Both modes used FULL durability and enabled foreign keys.

| File mode | Writer timeout | Median reader snapshot | Median writer begin | Median commit call (range) | Busy at commit | Successful commits before reader released its snapshot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DELETE | 0 ms | 759.43 ms | 0.142 ms | 0.042 ms (0.038–0.052 ms, failed) | 5/5 | 0/5 |
| WAL | 0 ms | 736.03 ms | 0.019 ms | 2.229 ms (1.951–3.107 ms) | 0/5 | 5/5 |
| DELETE | 5,000 ms | 667.81 ms | 0.115 ms | 778.074 ms (662.374–788.731 ms) | 0/5 | 0/5 |
| WAL | 5,000 ms | 737.28 ms | 0.019 ms | 2.899 ms (2.708–3.025 ms) | 0/5 | 5/5 |

Every `BEGIN IMMEDIATE` succeeded. DELETE's contention surfaced at `COMMIT`. At zero timeout the failed transaction was rolled back and the write was absent. All successful writes persisted. The isolated tests also verified that DELETE can retry the same commit after the reader releases its snapshot, WAL keeps the reader's view stable across a writer commit, and a second WAL writer still gets `SQLITE_BUSY` while a first writer owns the lock. These are controlled two-process measurements, with no HTTP traffic, checkpoint load or production volume validation.

### Deployment decision and remaining risks

- **Storage and workers.** The checked-in topology binds Express to loopback and runs both scheduler children with the API's Node executable. That topology is compatible with WAL on one host when all processes share the same local database directory and can access its `-wal` and `-shm` files. The workspace is under OneDrive and the benchmark ran in the local temporary directory. The repository has no production volume or replica configuration, so the actual production mount, synchronization behavior and single-host placement remain unverified. WAL requires same-host shared memory and a suitable local filesystem. [SQLite WAL documentation](https://sqlite.org/wal.html)
- **Runtime and durability.** The measured SQLite 3.54.1 includes the WAL-reset corruption fix introduced in 3.51.3. Verify the embedded SQLite version of the deployed Node build and any external process that opens the file. The repository currently pins neither. Keep FULL durability in any pilot and measure WAL growth, checkpoint progress and write latency while long snapshots are active. The immediate write sweeps still serialize with other writers. A longer API busy timeout would trade immediate errors for synchronous event-loop stalls. [SQLite WAL documentation](https://sqlite.org/wal.html) · [Node SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- **Backups and migrations.** The isolated online backup restored a write committed while an older WAL snapshot was open, passed integrity and foreign-key checks, and contained the expected row. Production still needs a SQLite-aware backup and restore drill on the target volume. A live main-file copy can omit committed WAL frames. Journal mode persists, so any approved conversion should be a controlled maintenance operation with API, scheduler and manual writers stopped, a verified backup, and mode and integrity checks before restart. Concurrent import-time DDL and backfills still need the single-writer migration strategy in rank 1. [SQLite Online Backup API](https://sqlite.org/backup.html) · [SQLite WAL documentation](https://sqlite.org/wal.html)

WAL materially reduced read/write contention on the fixture. This original investigation made no runtime PRAGMA changes. The later guarded configuration and load comparison appear below. Production adoption still requires verified deployment storage, backup and migration procedures, and approval.

On Node v24.22.3, `node --test --test-reporter=spec` from `server/` ran the full backend suite with **182 passed, 0 failed, 0 skipped and 0 cancelled**. A separate run of `server/database/journalContention.test.js` from the repository root had **3 passed, 0 failed, 0 skipped and 0 cancelled**.

## Online backup and isolated restore validation · 2026-11-23

[db.js](../server/database/db.js) opens `server/storage/rentflow.db` and performs initialization on import. The API and existing job scripts all use it. The two backup commands are explicit operator tasks and open only their supplied input paths. They never load application bootstrap or start jobs. The server's ignore rules already cover `storage/`, `*.db`, `*.db-wal` and `*.db-shm`. Keep backup files outside the checkout on restricted storage.

### Commands

From the repository root in PowerShell, use a pre-created backup directory and a unique destination. Replace the example path with the authorized backup location. The backup source below is the current application path, so run this only on the host where that path is the intended database.

```powershell
$rentflowSource = Join-Path (Get-Location).Path 'server/storage/rentflow.db'
$rentflowStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfff'Z'")
$rentflowBackup = Join-Path 'D:/RentFlowBackups' "rentflow-$rentflowStamp.db"
npm.cmd --prefix server run db:backup -- "$rentflowSource" "$rentflowBackup"
if ($LASTEXITCODE -ne 0) { throw 'RentFlow backup failed' }
npm.cmd --prefix server run db:validate-backup -- "$rentflowBackup"
if ($LASTEXITCODE -ne 0) { throw 'RentFlow backup validation failed' }
```

The [backup command](../server/database/backupDatabase.js) opens the existing source read-only and uses Node's SQLite Online Backup API. It captures committed state, including WAL frames SQLite has not checkpointed, and excludes uncommitted writes. It flushes the staged snapshot, then publishes it with a hard link that fails if the destination already exists, including if another process wins the race. The resulting backup is a standalone SQLite file. Use SQLite's backup command during active service. A plain copy of a live SQLite main file can miss committed WAL data or capture inconsistent pages. [Node SQLite backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackup-sourcedb-path-options) · [SQLite Online Backup API](https://sqlite.org/backup.html)

The [validation command](../server/database/validateBackup.js) expects a completed standalone snapshot. It copies the backup to a fresh private directory under the OS temporary directory, checks `integrity_check` and `foreign_key_check`, verifies the required RentFlow tables, counts rows and probes representative user, quote, follow-up, suppression and queue relationships. Empty tables are reported as empty, and historical tenantless demo quotes are allowed. The JSON contains counts and probe results without customer values. Compare counts and probe results against the expected history, especially if an initialized database is expected to contain tenant data. Validation removes only its temporary copy.

### Storage and recovery limits

- Run with the tested Node v24.22.3 and bundled SQLite 3.54.1 or verify the intended deployed version before relying on the workflow. Run on the database host. WAL reads rely on SQLite's normal sidecar access and locking, so keep the live database and its sidecars together on supported local storage. The source is opened read-only and the utility issues no source checkpoint, schema change or journal-mode switch.
- Use an existing, access-controlled backup directory on a filesystem that supports hard links, such as NTFS. Staging and publication occur on the same volume. Reserve free space for a full snapshot in the destination and another copy in the OS temporary directory. Use encrypted storage with restricted permissions for both directories. Backups contain customer data, password hashes and delivery metadata. Copy validated backups to encrypted off-host storage under the retention policy and verify that an off-host copy can be retrieved and validated. A local file alone does not protect against host or volume loss.
- The snapshot represents committed state during backup. Ongoing changes may restart the incremental copy and heavy contention can delay or fail the job. Set and monitor a scheduler deadline suited to database size. Failed runs exit nonzero and do not publish partial snapshots. Abrupt termination may leave a private `.rentflow-backup-*` or `rentflow-restore-*` directory. After an interrupted run, verify any published candidate before using it and handle abandoned work directories under the retention policy.
- Validation checks snapshot structure and representative relationships. It cannot prove the desired recovery point or cover all application workflows. A production cutover remains a separately approved maintenance action with writers stopped, the existing database preserved, and tenant counts and smoke tests verified against the chosen backup. Record measured recovery time and age of recovered data using a staging restore drill before changing production journaling.

Start with a daily off-peak backup followed immediately by validation. Run another before any approved migration or journal-mode change. Shorten the interval if the agreed recovery-point objective requires it, prevent scheduled overlap, and alert if a backup fails validation or the last verified off-host copy becomes stale. Schedule periodic restore drills from off-host media and record recovery time and recovered snapshot age.

Verification on Node v24.22.3 with `node --test --test-reporter=spec` from `server/` yielded **188 passed, 0 failed, 0 skipped, 0 cancelled**. The isolated backup workflow suite yielded **6 passed, 0 failed, 0 skipped, 0 cancelled** and covered WAL visibility, DELETE snapshots, no-overwrite behavior, concurrent publication, corrupt and incomplete snapshots, and foreign-key and path failures.

## Guarded WAL configuration and rollout · 2026-11-23

The current [load comparison](backend-load-test-report.md#journal-mode-comparison--2026-11-23) kept the API timeout at 0 ms and worker timeout at 5,000 ms. At 100,000 tenant quotes and 16 concurrent clients, two APIs went from 15.56% busy failures in DELETE to 4.25% in WAL. With the worker running, failures went from 18.81% to 6.63%. Recovery checks and queue audit counts passed in all cases. A separate WAL experiment at 250 ms API timeout reduced errors to 0 of 1,600 without the worker and 2 of 1,600 with it, but increased event-loop stalls and lowered successful throughput relative to WAL at 0 ms. The application does not apply the experimental timeout.

### Connection settings

The [shared opener](../server/database/openDatabase.js) runs before the existing schema bootstrap in [db.js](../server/database/db.js). The API and the due, reconcile and manual recovery entry points import that same module. The API loads dotenv before the app module, and its scheduler children inherit the process environment. Supply the same settings explicitly for manually invoked jobs. Backup and restore-validation continue to use their explicit CLI paths and standalone connections.

| Setting | Behavior |
| --- | --- |
| `RENTFLOW_SQLITE_PATH` unset | The existing `server/storage/rentflow.db` path and bootstrap behavior apply. |
| `RENTFLOW_SQLITE_PATH` set | Opens the specified absolute existing regular file. A missing path fails rather than seeding a new database at an unintended location. |
| `RENTFLOW_SQLITE_JOURNAL_MODE` unset | Leaves the file's journal mode unchanged. An existing WAL database remains in WAL mode. |
| `RENTFLOW_SQLITE_JOURNAL_MODE=wal` | Requires an explicit existing database path and `RENTFLOW_SQLITE_STORAGE=local-single-host`. Sets WAL if needed, verifies the selected mode and sets `synchronous=FULL` for that connection. It leaves foreign-key checks, busy timeouts and the SQLite automatic checkpoint policy in place. |

The opener rejects invalid modes, missing confirmation, relative paths, missing or zero-byte WAL sources, known network filesystem types on Linux, UNC paths, recognizable OneDrive paths, unwritable files or directories and existing sidecars that are not regular, accessible files. WAL requires SQLite 3.51.3 or later in this implementation. The tested Node v24.22.3 embeds SQLite 3.54.1. The detection is partial. Mapped drives, storage abstractions and sync tools can obscure their topology, and local checks cannot establish which other hosts might open the same file. [SQLite WAL documentation](https://sqlite.org/wal.html)

**Hosting status is unknown.** Checked-in startup binds to loopback and starts both worker children on the same host as their parent. There is no repository deployment manifest identifying a persistent volume, replica placement, runtime or backup service. The developer checkout is under OneDrive. The passing benchmarks used the separate local NTFS temporary directory. Before approving a pilot, verify that all API, worker and backup processes access the same persistent local volume from one host, that the service account can create and write the WAL and SHM sidecars, and that the directory is excluded from synchronization. Use a verified SQLite version across every process that opens the file. The test supports a staged single-host pilot, with multi-process contention still open.

### Approved pilot procedure

1. Verify the target storage and runtime above. Drain and stop the API and scheduler children, manual workers and any backup clients. Keep the original database intact. Take a new online backup, run `db:validate-backup` immediately, and verify an off-host copy as described in the backup runbook above.
2. Set the three variables together in the approved test service environment. The example path is a pre-existing staged copy on a verified local volume.

   ```powershell
   $env:RENTFLOW_SQLITE_PATH = 'D:/RentFlowPilot/rentflow.db'
   $env:RENTFLOW_SQLITE_JOURNAL_MODE = 'wal'
   $env:RENTFLOW_SQLITE_STORAGE = 'local-single-host'
   @'
   import { openRentFlowDatabase } from "./server/database/openDatabase.js";
   const db = openRentFlowDatabase(process.env.RENTFLOW_SQLITE_PATH);
   try {
     console.log(db.prepare("PRAGMA journal_mode").get());
     console.log(db.prepare("PRAGMA synchronous").get());
   } finally { db.close(); }
   '@ | node --input-type=module
   ```

3. Confirm `wal` and `synchronous=2` before starting one API process and its children. Exercise authenticated reads and writes and a due/reconciliation pass, verify the file survives a restart, then take and validate another online snapshot. Observe busy counts, tail latency, queue age, WAL size, checkpoint progress and free disk under representative traffic. Agree on acceptable thresholds before increasing traffic or starting more API processes.
4. If an approved rollback is needed, drain and stop every connection first and take and validate a fresh backup. Use the same absolute path, clear the WAL mode and storage confirmation variables in the service configuration, then run the following from the repository root with the approved path still set. Restart only after checkpoint and mode verification succeed. Preserve the WAL and SHM files as SQLite manages them.

   ```powershell
   @'
   import { openRentFlowDatabase } from "./server/database/openDatabase.js";
   const path = process.env.RENTFLOW_SQLITE_PATH;
   if (!path) throw new Error("An explicit approved database path is required");
   const db = openRentFlowDatabase(path, { RENTFLOW_SQLITE_PATH: path });
   try {
     if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
       throw new Error("Expected WAL in the rollback source");
     }
     const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
     if (checkpoint.busy !== 0) throw new Error("WAL checkpoint is busy");
     const result = db.prepare("PRAGMA journal_mode = DELETE").get();
     if (result.journal_mode !== "delete") throw new Error("DELETE mode was not established");
     console.log(result);
   } finally { db.close(); }
   '@ | node --input-type=module
   ```

The WAL backup test uses the shared opener and the actual backup and restore-validation commands. With automatic checkpoints disabled on the temporary writer, it verifies the main file stayed byte-for-byte unchanged after the insert. The validated backup contained the committed WAL row and excluded the uncommitted row. The connection tests also exercised persisted WAL and explicit rollback to DELETE. Production storage, monitoring and off-host restore drills remain unverified.

On Node v24.22.3, the full backend suite returned **207 passed, 0 failed, 0 skipped, 0 cancelled**. The separate configuration, contention and backup suite returned **14 passed, 0 failed, 0 skipped, 0 cancelled**. No production mode change or deployment was performed.

## Bounded SQLite lock waiting · 2026-11-23

The shared [connection opener](../server/database/openDatabase.js) accepts `RENTFLOW_SQLITE_BUSY_TIMEOUT_MS` as a whole number from 0 through 100. Unset or `0` preserves the previous fail-fast default. Invalid values fail before opening the file. This setting is independent of journal mode. It applies when the connection opens, including API bootstrap and synchronous startup recovery. Scheduled children inherit it for their shared bootstrap, and manual workers use it when supplied in their environment. The due, reconcile and manual recovery CLIs still replace it with 5,000 ms after bootstrap. Their 30-second scheduler deadline is unchanged. Moving worker lock policy ahead of all import-time DDL remains open.

Start at **25 ms on an approved, already-WAL staging instance**. It was the shortest nonzero wait tested and cut worker-overlap busy errors from 174 to 11 in the initial sweep. Longer waits traded tail latency for fewer errors. DELETE at 50 ms also substantially reduced errors, but successful throughput and p99 were worse. These results support opting in by environment after measuring on the intended host. Leave the setting unset until a pilot is approved. Undo a pilot wait by unsetting the setting or setting `0` and restarting the affected processes. Changing only this setting does not convert or roll back journal mode. [Load measurements and commands](backend-load-test-report.md#bounded-busy-timeout-sweep--2026-11-23)

The setting uses SQLite's native busy handler. It waits inside the current SQLite operation for qualifying lock conflicts and can still return `SQLITE_BUSY`. This is a per-lock wait, not a request deadline. The synchronous handler blocks the connection's Node event loop. No application SQL statement, transaction callback, or HTTP request is replayed. Existing transactions still roll back on caught failures. [SQLite busy timeout](https://sqlite.org/c3ref/busy_timeout.html) · [SQLite transaction behavior](https://sqlite.org/lang_transaction.html)

### Retry boundaries

| Operation or boundary | Replay decision |
| --- | --- |
| `BEGIN IMMEDIATE` returns busy before the transaction starts | The transaction body has not run. A future bounded retry could reacquire and revalidate from current state, provided no preceding side effects occurred. The current implementation returns the failure when native waiting expires. |
| SQL fails inside a transaction or DELETE-mode commit is blocked by a reader | Do not rerun a statement from the middle of the operation. Existing code rolls back when the native wait expires. Any future transaction rerun must start after confirmed rollback and repeat all state checks. A blocked commit can be retried on the same live transaction by SQLite without rerunning the body, but the application adds no extra commit loop. |
| Due event/draft, queue insertion and recovery | The scheduler may run a new pass on a later tick after lock failure or process death. Due-event, active-draft and queue-message uniqueness constrain replay. Recovery opens a new snapshot and revalidates cancellations inside its write transaction. Queue and audit transitions commit together. |
| Manual draft, approval, simulation and unsubscribe | An existing active draft can be returned. Approval and simulation enforce state transitions. Public unsubscribe uses one transaction to consume the token, suppress recipients in the owning company and cancel the associated drafts and queue rows. A replay can return a conflict or an already-used result. Tests verify these paths do not produce a second transition or audit row. |
| Quote creation, scheduling, unsubscribe-link minting and preflight checks | A lost response can follow a successful commit. Quote creation has no request key, scheduling records another activity event on a repeat, link minting can create another token, and preflight checking appends audit. Do not automatically retry these requests when the outcome is uncertain. |

Remaining risks include startup contention before workers install their 5,000 ms wait, long write sweeps, duplicated scheduler ownership across API processes, and the need for a durable policy for ambiguous non-idempotent requests. The experiment did not qualify the production host or establish service-level targets.

## Bounded worker commits · 2026-11-23

The [instrumented load test](backend-load-test-report.md#worker-writer-lock-profiling-and-batching--2026-11-23) reproduced 10 busy errors in 1,600 requests with two WAL API processes and a worker. All ten were at API writer acquisition and overlapped the due or queueing stage. Healthy reconciliation used no writer transaction. The unbatched longest due and queueing writes were 316.19 ms and 424.72 ms. The 50-row batches reduced them to 27.41 ms and 19.18 ms, with zero observed busy errors in the comparable run. The final due stage spent more total time because it waited for writers between its commits. All three worker stages completed in about 4.18 seconds versus 1.22 seconds at baseline, below the current 30-second child timeout for this fixture.

The [scheduled follow-up job](../server/jobs/checkDueFollowUps.js) now collects candidates before taking writer locks. Each due or queueing batch looks up current rows by ID and checks current state under `BEGIN IMMEDIATE`. The due-event ledger avoids writing again for an already recorded schedule. Queueing inspects already-queued drafts outside the writer transaction. An eligible draft selected for a write is checked again under the lock, including ownership, declared schedule, current recipient eligibility and queue existence. No new scheduler coordination was added because one worker was sufficient to reproduce the contention.

Each batch commits its queue rows and audit attribution together, or its due events, activity, drafts and unsubscribe tokens together. Earlier successful batches remain durable if a later batch fails. The next scheduled pass starts from current data and deduplicates successful work through the existing keys and status checks. A candidate that becomes newly eligible after the read pass may wait for the next normal tick. The worker retries on the existing scheduler cadence only. It does not replay a failed statement or transaction in place. Dry-run output and its read-only service behavior are preserved.

The independent-process tests stop workers after committed draft and queue batches, restart them, and verify exactly one queue row and audit per draft. They also exercise suppression committed between selection and write acquisition, same-address isolation across companies, and a settled pass while another connection owns the writer slot. These local results leave cancellation-heavy reconciliation, duplicate scheduler ownership, import-time DDL, storage latency and production-scale backlog age open. No production configuration was changed.

Backend verification returned **212 passed, 0 failed, 0 skipped, 0 cancelled**. The focused crash, due, queue and recovery run returned **47 passed, 0 failed, 0 skipped, 0 cancelled**.
