# RentFlow backend load test · 2026-11-23

The 100-company, 100,000-quote workload completed on one API process with zero HTTP errors. Two API processes sharing the same SQLite file returned lock errors even without the worker. Reusing delivery-readiness statements shortened the idle 10,000-entry recovery scan from **802.47 ms to 336.83 ms** at the median. The shared-file deployment remains gated on contention and tail latency.

## Reproduce

Run from the repository root with the existing backend dependencies installed. The harness prints JSON lines containing fixture metadata, request results, per-process metrics, worker results and query plans.

```powershell
node server/performance/backendLoad.js --quick
node server/performance/backendLoad.js
node server/performance/backendLoad.js --full-only
Push-Location server
node --test --test-reporter=spec
Pop-Location
```

`--quick` runs the smallest stage. The default ramps through all three stages. `--full-only` repeats the largest stage and its three topologies. Run one harness at a time for comparable timings. The harness generates a random signing key per run, redirects the real database bootstrap before importing the production Express app, and creates a new OS temporary directory per stage. The databases and test servers are isolated from the application database. The load generator uses an ephemeral loopback port and never prints credentials or response bodies. The harness removes its own temporary directory after the processes stop. An interrupted run may leave an isolated `rentflow-backend-load-*` directory. [Load driver](../server/performance/backendLoad.js) · [Fixture and instrumentation](../server/performance/loadServer.js)

## Setup and workload

- Windows workstation with AMD Ryzen 5 3600, 12 available logical processors, 15.9 GiB RAM and local NTFS temporary storage. Node v24.22.3 embedded SQLite 3.54.1. The harness kept DELETE journal mode and the application's default API busy timeout of 0 ms. The worker used 5,000 ms.
- Seed stages were 10 companies and 1,000 quotes and contacts, 50 and 10,000, and 100 and 100,000. The largest tenant owned 20% of the tenant quotes. The bootstrap also supplies its usual tenantless demo rows, which are excluded from authenticated tenant lists. The 100,000-row stage started with 26,000 schedules, 5,000 due, two historical activity rows per schedule and 10,000 active queue entries. The 1,000 due quotes without drafts formed a processing burst.
- Closed-loop concurrency was 4, 8 and 16, with 400, 800 and 1,600 measured requests per phase after a separate 40-request warm-up. Mix was 35% quote list, 10% quote creation, 15% scheduling, 20% readiness, 15% queue list and 5% queue audit. One quarter of traffic targeted the largest tenant. Two API processes alternated requests, rotating the assignment across request batches.
- The last phase started a separate Node worker against the same temporary database while both API processes handled requests. The worker ran the production due processor, draft queueing and reconciliation once in that order. This exercises actual service transactions and same-host file locks with controlled overlap. It excludes production startup recovery, steady-state timer behavior, TLS, browser rendering, reverse proxy and remote storage.
- Timing runs were sequential on the same host and each full run started with a fresh fixture. The three topologies within a run used the same file, so successful requests from earlier phases added quotes and schedules. Latency includes consuming the response body and includes failed attempts. API lag uses `monitorEventLoopDelay` with 10 ms resolution. RSS and V8 heap values are sampled peaks at 50 ms and can miss transient peaks. Worker hold time runs from successful `BEGIN IMMEDIATE` through commit or rollback. HTTP busy counts come from the app's error handler and distinguish SQLite errors from other logged exceptions.

## Query plans and confirmed bottlenecks

The harness ran `EXPLAIN QUERY PLAN` on the actual SQL extracted from each source declaration. The timings below are baseline medians of five warm executions, including SQLite row materialization, on the largest fixture without HTTP traffic.

| Query | Median | Plan and implication |
| --- | ---: | --- |
| Hot-tenant quote list | 33.28 ms | `idx_quotes_company` narrows by tenant, then a temp B-tree sorts the display-ID expression. JSON serialization and transport add to database time. |
| Quote ID allocation | 10.57 ms | The covering quote primary-key index supplies a global scan for `MAX(CAST(SUBSTR(...)))`. This work runs inside the creation writer transaction. |
| Follow-up list | 13.65 ms | Tenant index and schedule primary-key lookups, then a temp sort on scheduled time. |
| Queue list | 12.17 ms | Tenant quote index → message quote index → unique queue message key. A temp B-tree sorts by creation time and row ID. |
| Due selection | 30.26 ms | The schedule-time index bounds candidate schedules. Quote/contact keys and covering suppression, due-event and active-draft indexes serve the lookups. SQLite sorts the trailing ordering term. |
| Draft queue candidates | 22.01 ms | The active-draft index is scanned, with keyed quote and schedule joins and a temp sort. Existing queued drafts still enter the candidate set. |
| Active recovery candidates | 29.02 ms | Queue status index and keyed message/quote joins, with a temp B-tree for ordering. This is only the initial candidate query. |

The quote-list response p95 for the largest tenant was 3,140,177 bytes versus 127,299 bytes for the remaining tenants in the baseline single-process run. Queue-list response p95 was 532,690 bytes. Broad pagination or internal ID changes would affect application contracts and require a separate decision.

The recovery candidate query alone took about 29 ms while the entire pass took about 802 ms. Each subsequent readiness check prepared up to five SQL statements, even during one sweep. [deliveryReadiness.js](../server/services/deliveryReadiness.js) now caches these fixed statements per connection and still reads current rows with the same query parameters, ownership checks and transactions. The new regression test verifies reads after a suppression change, between two connections and for another tenant. No schema, index or journal configuration changed. [Readiness regression test](../server/services/deliveryReadiness.test.js)

The five measured idle recovery passes ranged from 752.55–851.09 ms before and 333.17–352.54 ms after, excluding one warm-up per run. The median fell 58%. Both runs reported 10,000 healthy entries, zero cancellations and zero writer reservation. Shortening this snapshot reduces how long that scan can delay a DELETE-mode writer's commit.

## HTTP results

All latencies are milliseconds. RPS counts all completed attempts, including failures. Every measured HTTP failure was a 500 associated with a SQLite busy error. No non-SQLite error was logged. The two-process lag and memory columns show the higher observed value across API processes for each metric.

| Run | Requests / concurrency | RPS | p50 / p95 / p99 | Errors / busy | Lag p95 / p99 / max | RSS / heap MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline, 1,000 quotes, one API | 400 / 4 | 313.42 | 3.95 / 46.52 / 47.73 | 0 / 0 | 36.50 / 37.95 / 48.89 | 73.78 / 15.87 |
| Baseline, 10,000 quotes, one API | 800 / 8 | 307.95 | 23.56 / 50.55 / 57.97 | 0 / 0 | 52.00 / 53.97 / 55.44 | 120.68 / 41.40 |
| Baseline, 100,000 quotes, one API | 1,600 / 16 | 94.31 | 106.66 / 438.21 / 467.49 | 0 / 0 | 431.23 / 441.45 / 449.31 | 278.73 / 106.47 |
| Baseline, 100,000 quotes, two APIs | 1,600 / 16 | 167.79 | 72.75 / 264.19 / 303.48 | 260 (16.25%) / 260 | 277.61 / 299.37 / 392.43 | 279.44 / 123.39 |
| Baseline, 100,000 quotes, two APIs + worker | 1,600 / 16 | 176.84 | 68.21 / 261.20 / 288.61 | 324 (20.25%) / 324 | 270.27 / 279.97 / 281.80 | 275.80 / 125.92 |
| After, 100,000 quotes, one API | 1,600 / 16 | 93.16 | 108.36 / 439.12 / 456.45 | 0 / 0 | 433.59 / 444.07 / 478.67 | 271.15 / 106.51 |
| After, 100,000 quotes, two APIs | 1,600 / 16 | 175.65 | 69.42 / 250.99 / 278.40 | 251 (15.69%) / 251 | 259.00 / 261.10 / 271.32 | 278.55 / 123.45 |
| After, 100,000 quotes, two APIs + worker | 1,600 / 16 | 176.11 | 68.45 / 250.63 / 281.87 | 292 (18.25%) / 292 | 259.92 / 271.58 / 272.11 | 274.79 / 125.83 |

Baseline successful throughput at full scale was 94.31 RPS for one API, approximately 140.52 RPS for two APIs and 141.03 RPS for two APIs plus the worker. After the change the same figures were 93.16, 148.09 and 143.97. Each mixed phase is one measured run. The repeatable speedup was in recovery, and this experiment does not establish a sustained API throughput or error-rate improvement.

| Operation at 100,000 quotes | Baseline one API p50 / p95 / p99 | After one API p50 / p95 / p99 | Baseline two APIs + worker errors / attempts | After two APIs + worker errors / attempts |
| --- | ---: | ---: | ---: | ---: |
| Quote listing | 101.27 / 348.98 / 398.72 | 103.19 / 355.84 / 404.96 | 5 / 560 | 10 / 560 |
| Quote creation | 105.64 / 432.24 / 465.95 | 108.88 / 428.03 / 444.77 | 120 / 160 | 108 / 160 |
| Follow-up scheduling | 124.88 / 453.74 / 512.13 | 134.57 / 451.94 / 468.12 | 194 / 240 | 170 / 240 |
| Delivery readiness | 108.58 / 451.38 / 516.65 | 111.07 / 448.19 / 471.59 | 4 / 320 | 4 / 320 |
| Queue listing | 102.55 / 396.74 / 440.92 | 104.89 / 396.86 / 412.87 | 1 / 240 | 0 / 240 |
| Queue audit | 97.34 / 278.92 / 361.84 | 99.40 / 277.93 / 299.29 | 0 / 80 | 0 / 80 |

At baseline, the largest tenant's quote-list p95 was 395.82 ms versus 221.26 ms for the other tenants in the same single-process phase. The payload and event-loop delay are consistent with synchronous database work and serialization contributing to head-of-line blocking. The global quote ID scan and queue sweep also hold the writer reservation, increasing the opportunity for concurrent writes to fail. The two-API run produced busy errors even without a worker. Those results apply to the tested DELETE configuration.

## Worker overlap and documented targets

| Worker stage during two-API traffic | Before elapsed / writer hold | After elapsed / writer hold | Observed result in both runs |
| --- | ---: | ---: | --- |
| Due detection and drafting | 361.37 / 359.02 ms | 369.31 / 367.23 ms | 5,000 due events and 1,000 new drafts |
| Queueing | 673.20 / 672.75 ms | 447.46 / 446.96 ms | 1,000 new queue entries and 4,000 existing |
| Reconciliation | 1,065.70 / 0 ms | 494.67 / 0 ms | 11,000 healthy entries, zero cancellations |

The [production audit](production-readiness-audit.md#crash-recovery-and-scale) calls for 100 companies, 100,000 quotes, tenant skew, a mostly future schedule, an overdue burst, 10,000 active queue entries and concurrent API and worker work. This harness covered that fixture and same-host overlap. All worker stages finished below the current 30-second child timeout with zero emails sent. The [database hardening plan](database-hardening-plan.md) calls for agreed launch limits on latency, busy errors and queue lag, but neither document defines numeric HTTP latency, RPS, error or memory SLOs. There is no basis for an SLO pass. The observed shared-file error rates are a reliability blocker for that topology. Worker completion time here covers a single deliberate burst, so sustained queue lag and production storage behavior remain unmeasured.

**Regression verification.** Node v24.22.3 ran the complete backend suite from `server/` with **202 passed, 0 failed, 0 skipped, 0 cancelled**. The changed JavaScript files passed lint. No live database, schema migration, React UI or real email path was used.

## Journal-mode comparison · 2026-11-23

The current code was rerun on the same local NTFS host with a fresh 100-company, 100,000-quote fixture per configuration. Each phase kept the same request mix, 40-request warm-up, 1,600 measured requests and 16 concurrent clients. API processes used FULL synchronous durability and enabled foreign keys. All workers used a 5,000 ms busy timeout. The primary DELETE/WAL comparison kept the API busy timeout at 0 ms. The 250 ms WAL run is a separate test-only wait experiment.

```powershell
node server/performance/backendLoad.js --full-only --journal=delete
node server/performance/backendLoad.js --full-only --journal=wal
node server/performance/backendLoad.js --full-only --journal=wal --api-timeout=250
```

The harness uses the application WAL opener for every WAL fixture process and sets that process's path to the temporary database. It prints the post-run database checks alongside timing and error metrics. Run cases sequentially. Each row below is one measured phase, so small differences should be treated as run-to-run variation.

| Journal / API timeout | Topology | Attempt / successful RPS | p50 / p95 / p99 (ms) | SQLite busy / 1,600 |
| --- | --- | ---: | ---: | ---: |
| DELETE / 0 ms | One API | 92.41 / 92.41 | 109.88 / 446.61 / 459.57 | 0 |
| WAL / 0 ms | One API | 110.76 / 110.76 | 82.20 / 409.08 / 427.77 | 0 |
| DELETE / 0 ms | Two APIs | 157.65 / 133.12 | 73.94 / 276.53 / 403.28 | 249 (15.56%) |
| WAL / 0 ms | Two APIs | 205.24 / 196.52 | 55.70 / 234.96 / 254.18 | 68 (4.25%) |
| DELETE / 0 ms | Two APIs + worker | 175.05 / 142.12 | 73.90 / 256.13 / 280.22 | 301 (18.81%) |
| WAL / 0 ms | Two APIs + worker | 204.08 / 190.56 | 56.18 / 234.20 / 256.85 | 106 (6.63%) |
| WAL / 250 ms | One API | 108.27 / 108.27 | 82.52 / 420.89 / 463.87 | 0 |
| WAL / 250 ms | Two APIs | 178.91 / 178.91 | 87.58 / 250.05 / 270.04 | 0 |
| WAL / 250 ms | Two APIs + worker | 167.72 / 167.51 | 90.07 / 252.81 / 385.60 | 2 (0.13%) |

Each HTTP failure was a 500 associated with a busy error. WAL at 0 ms eliminated the read failures seen under DELETE. The 68 remaining failures without the worker were 30 quote creations and 38 schedule writes. With the worker, the 106 failures were 45 creations and 61 schedule writes. The wait experiment avoided most of those failures and lowered successful throughput in both two-API phases. With the worker, p99 rose from 256.85 ms to 385.60 ms and the highest sampled event-loop lag increased from 250.35 to 419.17 ms. The API timeout remains unchanged in the application.

| Worker operation | DELETE / 0 ms elapsed / writer hold | WAL / 0 ms elapsed / writer hold | WAL / 250 ms elapsed / writer hold |
| --- | ---: | ---: | ---: |
| Due processing | 374.05 / 372.21 ms | 315.46 / 313.65 ms | 331.64 / 329.52 ms |
| Queueing | 524.04 / 523.52 ms | 422.20 / 421.51 ms | 452.25 / 451.69 ms |
| Healthy recovery | 486.41 / 0 ms | 488.34 / 0 ms | 463.70 / 0 ms |

Every worker run recorded 5,000 due events, added 1,000 drafts and 1,000 queue entries, and reconciled 11,000 healthy entries without cancellations or email sends. Final integrity and foreign-key checks passed in all three configurations. Each fixture contained 11,000 active drafts, 11,000 pending queue entries, 11,000 queued audit events and zero attempts. A separate process test verified that a WAL reader can proceed while a writer owns the lock and that a second writer still receives `SQLITE_BUSY` at zero timeout. [Connection and process tests](../server/database/openDatabase.test.js)

The results support a guarded single-host WAL pilot on verified local storage. They do not qualify the two-API topology for production, which still needs a contention strategy and agreed latency targets. See the [rollout and rollback procedure](database-hardening-plan.md#guarded-wal-configuration-and-rollout--2026-11-23).

## Bounded busy-timeout sweep · 2026-11-23

The current harness can skip the single-API phase with `--two-only`. Each case starts from a fresh local NTFS fixture with 100 companies, 100,000 tenant quotes and contacts, and 10,000 initial queue entries. The two phases use the same request mix, 16 concurrent clients and 1,600 measured requests each. The worker starts with the second phase. FULL synchronous durability, foreign keys and the existing transaction logic stay in place. The shared connection opener applies waits through 100 ms to the HTTP test processes. The worker override is for the harness only.

```powershell
foreach ($rentflowWait in 0, 25, 50, 100) {
  node server/performance/backendLoad.js --two-only --journal=wal "--api-timeout=$rentflowWait" --worker-timeout=5000
}
foreach ($rentflowWait in 0, 50) {
  node server/performance/backendLoad.js --two-only --journal=delete "--api-timeout=$rentflowWait" --worker-timeout=5000
}
node server/performance/backendLoad.js --two-only --journal=wal --api-timeout=50 --worker-timeout=500
# Diagnostic run. The final assertion fails if the non-waiting worker leaves work pending.
node server/performance/backendLoad.js --two-only --journal=wal --api-timeout=50 --worker-timeout=0
```

| Journal / API wait / worker wait (ms) | Without worker busy / 1,600 | Without worker attempt / successful RPS | Without worker p95 / p99 (ms) | With worker busy / 1,600 | With worker attempt / successful RPS | With worker p95 / p99 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| WAL / 0 / 5,000 | 162 (10.13%) | 179.87 / 161.66 | 245.50 / 302.79 | 174 (10.88%) | 178.07 / 158.70 | 251.32 / 298.98 |
| WAL / 25 / 5,000 | 0 | 183.21 / 183.21 | 248.16 / 267.25 | 11 (0.69%) | 173.15 / 171.96 | 254.13 / 280.45 |
| WAL / 50 / 5,000 | 0 | 181.35 / 181.35 | 250.06 / 272.32 | 9 (0.56%) | 172.52 / 171.55 | 252.03 / 294.16 |
| WAL / 100 / 5,000 | 0 | 177.68 / 177.68 | 252.26 / 275.98 | 5 (0.31%) | 167.37 / 166.85 | 255.44 / 380.29 |
| DELETE / 0 / 5,000 | 246 (15.38%) | 175.72 / 148.70 | 251.64 / 289.92 | 303 (18.94%) | 176.13 / 142.78 | 257.75 / 286.15 |
| DELETE / 50 / 5,000 | 0 | 124.43 / 124.43 | 295.20 / 374.77 | 10 (0.63%) | 118.39 / 117.65 | 313.41 / 499.76 |
| WAL / 50 / 500 | 0 | 183.42 / 183.42 | 244.76 / 262.96 | 9 (0.56%) | 168.13 / 167.18 | 257.85 / 306.94 |
| WAL / 50 / 0, diagnostic rerun | 0 | 180.99 / 180.99 | 246.64 / 269.65 | 4 (0.25%) | 175.72 / 175.28 | 247.26 / 277.87 |

On the final application setting, repeating WAL at 25 ms produced **0 busy errors without the worker** at 181.85 RPS and p95/p99 of 249.44/269.52 ms. With the worker it produced **10 of 1,600 busy errors** at 176.51 attempted and approximately 175.41 successful RPS, with p95/p99 of 245.47/269.30 ms. SQLite integrity and foreign-key checks passed. The database contained all 11,000 expected active drafts, queue items and queue audits. The stored 323 quote creations and 487 scheduling activities matched successful HTTP responses including warm-up. The harness reports busy and locked errors separately. The confirmation logged zero `SQLITE_LOCKED` errors.

A second confirmation again produced 0 busy errors without the worker and 10 with it. Attempted throughput was 180.20 and 167.78 RPS, respectively. The p95/p99 pairs were 248.78/274.61 ms and 255.57/312.14 ms. The stored counts matched the first confirmation.

The 25 ms wait is the first candidate for a WAL staging pilot because it substantially reduced failures with similar p95 and stronger goodput in the measured mix. The 50 ms and 100 ms cases traded additional synchronous waiting for smaller reductions in errors. DELETE waiting also reduced busy errors, with lower goodput and materially higher tail latency. These are local runs. Worker and API timing varies with scheduling, and the measurements do not establish a production latency or reliability guarantee.

With the 500 ms worker wait, all three worker stages completed in that run. With zero wait, `SQLITE_BUSY` interrupted the worker between its draft and queue commits. Integrity passed and 1,000 new drafts were durable, while the 1,000 associated queue items and audit events were still absent. The harness correctly returned nonzero for the incomplete pass. The API error count alone would have missed that outcome. The application retains the existing 5,000 ms worker wait and the later scheduler tick can replay the eligible draft-to-queue phase. The independent-process regression suite also covers approval, draft creation, unsubscribe, recovery and crash replay without duplicate transition or audit rows. [Worker tests](../server/jobs/workerReliability.test.js) · [Configuration tests](../server/database/openDatabase.test.js)

Production timeouts, journal mode and deployment were not changed. The [bounded wait and retry policy](database-hardening-plan.md#bounded-sqlite-lock-waiting--2026-11-23) documents the opt-in, safe boundaries and remaining risks.

Backend verification on Node v24.22.3 from `server/` with `node --test --test-reporter=spec` yielded **210 passed, 0 failed, 0 skipped, 0 cancelled**. The focused connection and independent-process suites yielded **14 passed, 0 failed, 0 skipped, 0 cancelled**.
