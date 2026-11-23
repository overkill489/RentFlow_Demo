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
