# RentFlow production deployment plan · 2026-11-23

**Decision.** Prepare a restricted, simulation-only pilot on one Linux host. Production remains gated on a staging restore drill, a verified database volume, a reviewed schema upgrade, and approved access and operating targets. This plan has not been deployed.

## Proposed topology

| Component | Initial design |
| --- | --- |
| Production host | One x86-64 Linux VM, initially 2 vCPU, 4 GiB RAM and at least 80 GiB of persistent local SSD. Use Debian 12 with security updates, Caddy and systemd. Size from staging measurements because the existing load test ran on a different Windows host. |
| Staging | A separate VM, hostname, SQLite file, signing secret and backup prefix. A 1 vCPU, 2 GiB VM is adequate as a starting point for functional drills. Use a matching 2 vCPU, 4 GiB shape for capacity acceptance. Use synthetic data. |
| HTTP | Caddy serves the Vite build and forwards `/api/*` to one Node process at `127.0.0.1:5000`. Use one HTTPS origin and restrict pilot users at the edge. Keep the API port private. |
| Workers | One API instance owns the existing immediate/60-second due child and 120-second reconciliation child. Workers inherit its database path and run on the same host. Keep them within the API service's cgroup. Manual jobs use the same service user and path and run during a maintenance window. |
| Database | `/var/lib/rentflow/rentflow.db` on the persistent, unsynchronized local filesystem. The service account must be able to create and write both SQLite sidecars in that directory. A release lives under `/opt/rentflow/releases`, independently of the database. |
| Backups | Nightly online SQLite snapshots, isolated validation, client-side encryption and upload to a private off-host object bucket. A separate verification account retrieves and drills restores. The VM and its disk are a single failure domain. |

SQLite WAL requires shared memory and file locking on one host. Keep the database, `-wal` and `-shm` together and let SQLite manage their lifetime. Persistent storage here means the directory and file survive service and VM restarts. SQLite may remove sidecars when the last connection closes. Confirm the guest mounts local ext4 or XFS and that the service account can create sidecars. Avoid NFS, SMB, synchronization tools and object-storage mounts. Use a client/server database before deploying writers across hosts. DigitalOcean documents the boot disk as local and persistent. Host-loss recovery still depends on a tested off-host restore. [SQLite WAL](https://sqlite.org/wal.html) · [DigitalOcean Droplet features](https://docs.digitalocean.com/products/droplets/details/features/)

## Evidence and risk ranking

| Priority | Finding | Gate or mitigation |
| --- | --- | --- |
| High | **Schema changes on import.** The shared bootstrap creates tables, checks and alters columns, and can seed an empty database. Some indexes, triggers and a suppression backfill live in route imports, so the bare worker does not initialize every API table. There is no migration ledger or verified upgrade across all historical schemas. | Start only one API against a new or upgraded file before starting manual workers. Back up and rehearse each upgrade on a restore, inspect the schema diff and approve all data-affecting changes. Keep general release on hold until schema changes are versioned and reviewed. [Bootstrap](../server/database/db.js) · [Route initialization](../server/routes/delivery.js#L9) |
| High | **Deployment and recovery on the target host are unverified.** Staging unit and proxy examples are checked in. Actual host storage, TLS, supervised shutdown, off-host retention and a restore drill remain unverified. Existing backup and WAL verification used temporary local files. | Perform the staging gates below and record measured restore time and data age. Never treat the provider disk image as the SQLite recovery artifact. [Database hardening plan](database-hardening-plan.md) |
| High | **The original startup validated JWT after write-capable imports.** An invalid secret on a disposable zero-byte file failed startup after creating 229,376 bytes of SQLite data. A clean standalone backend install also failed to import `express-rate-limit`. | Startup now validates JWT presence/length, an explicit production database path, port and proxy settings before importing the app. The dependency and its lock entries now belong to the backend. Generate a random signing secret. The length check does not measure entropy. [Startup](../server/index.js) · [Backend manifest](../server/package.json) |
| High | **Public edge behavior needs acceptance.** The default client build uses the visitor's localhost. Express also needs the actual client address to apply per-client login limits behind a loopback proxy. Registration creates a company administrator. | Build with `VITE_API_URL=/`. Enable the one-hop loopback trust explicitly only for the proposed sanitized proxy. Restrict the whole pilot to approved source addresses and agree on signup and reset policy before general release. [API client](../src/services/rentflowApi.js#L1) · [Proxy opt-in](../server/app.js#L17) |
| Medium | **Shutdown and monitoring have limits.** The API stops scheduling new jobs when shutdown begins, closes the HTTP listener and closes its own SQLite connection after HTTP drain. Worker child processes finish independently within their existing timeout. Liveness, readiness, and process-local worker health are available. Durable worker health, request latency and queue age still need external observation. | Verify genuine Linux SIGTERM, cgroup drain, a forced stop and restart under contention in staging. Use the [operator monitoring procedure](#health-and-observability--2026-11-23). [Startup lifecycle](../server/index.js) · [Scheduler](../server/jobs/workerScheduler.js) |
| Medium | **Manual unsubscribe-link URLs still use localhost.** Automated draft templates honor `RENTFLOW_UNSUBSCRIBE_BASE_URL`. The manual admin link route has its own hard-coded origin. | Keep real email disabled. Treat the manual absolute URL as a known pilot limitation. Test unsubscribe with a staged draft from the configured HTTPS origin. Resolve the manual URL before exposing that workflow to operators. [Manual link route](../server/routes/delivery.js#L488) · [Draft template](../server/services/followUpEmailTemplate.js#L12) |

Locally tested on Node v24.22.3, npm 11.19.1 and SQLite 3.54.1. The clean backend install used its own lockfile in an isolated directory. The unchanged React build succeeded with `VITE_API_URL=/` and the generated bundle contained relative `/api` URLs. The startup tests exercised real API startup, its initial child job, invalid settings, per-client login limits, shutdown and authenticated restart on a disposable database using the guarded WAL path and a 25 ms API wait. The shutdown test delivers the Node signal event through IPC on Windows. It does not qualify Linux process signaling or Caddy/TLS. Existing loopback development CORS stays in place. Same-origin proxying avoids relying on cross-origin CORS. `npm --prefix server test` returned **216 passed, 0 failed, 0 skipped, 0 cancelled**. The four startup tests also passed on the isolated clean backend install. [Startup tests](../server/startup.test.js)

## Candidate production setup after approval

Use the [dedicated staging workflow](#reproducible-linux-staging-workflow) for the first validation. The production paths and unit in this section are planning references.

1. Provision the staging VM first. Open ports 80/443 for Caddy and restrict SSH to operator addresses. Keep port 5000 closed at the firewall. Set DNS for the staging hostname. Install Caddy from its official package source. Install pinned Node v24.22.3 under `/opt/node-v24.22.3-linux-x64` from the official Linux archive, verify the signed checksum using the Node release keys, then verify the executable and embedded SQLite. Re-evaluate the pinned patch before deployment.

   ```sh
   /opt/node-v24.22.3-linux-x64/bin/node --version
   /opt/node-v24.22.3-linux-x64/bin/node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(":memory:"); console.log(d.prepare("SELECT sqlite_version() AS version").get()); d.close()'
   ```

2. Create the system user and state/config directories. Keep the private config root-owned and the database owned by the service account. Verify the actual filesystem. Use encrypted local storage appropriate to the data classification before introducing customer data.

   ```sh
   sudo useradd --system --home-dir /var/lib/rentflow --shell /usr/sbin/nologin rentflow
   sudo install -d -m 0755 /opt/rentflow/releases
   sudo install -d -m 0750 /etc/rentflow
   sudo install -d -o rentflow -g rentflow -m 0700 /var/lib/rentflow /var/lib/rentflow/backups
   findmnt -T /var/lib/rentflow -o TARGET,SOURCE,FSTYPE,OPTIONS
   sudo -u rentflow test -w /var/lib/rentflow
   ```

3. From an approved checkout of the release commit, build and verify before changing the `current` symlink. Copy the release and its built `dist/` into a new root-owned release directory. Keep a record of the prior commit and runtime. Provide Caddy read access to `dist/` only through its configured root.

   ```sh
   export PATH=/opt/node-v24.22.3-linux-x64/bin:$PATH
   npm ci
   npm --prefix server ci --omit=dev
   npm --prefix server test
   VITE_API_URL=/ npm run build
   # After placing the verified release under /opt/rentflow/releases:
   sudo ln -sfn "/opt/rentflow/releases/APPROVED_COMMIT" /opt/rentflow/current
   ```

4. Prepare the database explicitly. On the separate, empty staging host only, an authorized operator can create a new empty file using `sudo -u rentflow sh -c 'umask 077; set -C; : > /var/lib/rentflow/rentflow.db'`. Boot once with journal mode unset to initialize a staging fixture. For an existing install, start from a validated snapshot restored to a new path and inspect the rehearsal results. Use the [approved WAL procedure](database-hardening-plan.md#guarded-wal-configuration-and-rollout--2026-11-23) only after all connections stop, the volume is verified, and the change is authorized.

5. Put the following in `/etc/rentflow/api.env`, owned by root with mode `0600`. Replace the secret placeholder using the approved secret manager and a cryptographically random value such as the output of `openssl rand -hex 48`. Keep values out of Git, logs and the browser build. Use different staging and production values. Leave mail provider variables unset. Enable the last three lines only at the applicable approved WAL/timeout gate.

   ```ini
   NODE_ENV=production
   PORT=5000
   JWT_SECRET=REPLACE_VIA_SECRET_MANAGER
   RENTFLOW_SQLITE_PATH=/var/lib/rentflow/rentflow.db
   RENTFLOW_TRUST_LOOPBACK_PROXY=1
   RENTFLOW_UNSUBSCRIBE_BASE_URL=https://rentflow-stage.example.com
   # RENTFLOW_SQLITE_JOURNAL_MODE=wal
   # RENTFLOW_SQLITE_STORAGE=local-single-host
   # RENTFLOW_SQLITE_BUSY_TIMEOUT_MS=25
   # RENTFLOW_METRICS_TOKEN=REPLACE_WITH_SEPARATE_RANDOM_TOKEN
   ```

6. Use this systemd service at `/etc/systemd/system/rentflow.service`. Run Node directly so it receives the stop signal. `KillMode=mixed` signals the API first and leaves its active child handles time to drain, with a 45-second cgroup deadline. Check both graceful and forced behavior in staging. [systemd kill policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)

   ```ini
   [Unit]
   Description=RentFlow API and local workers
   After=network.target
   RequiresMountsFor=/var/lib/rentflow

   [Service]
   Type=simple
   User=rentflow
   Group=rentflow
   WorkingDirectory=/opt/rentflow/current/server
   EnvironmentFile=/etc/rentflow/api.env
   ExecStart=/opt/node-v24.22.3-linux-x64/bin/node index.js
   Restart=on-failure
   RestartSec=5s
   KillMode=mixed
   TimeoutStopSec=45s
   UMask=0077
   NoNewPrivileges=yes
   PrivateTmp=yes
   ProtectSystem=strict
   ReadWritePaths=/var/lib/rentflow

   [Install]
   WantedBy=multi-user.target
   ```

7. Configure HTTPS on Caddy. Replace the documentation address with the actual approved staging/pilot and monitoring egress ranges and replace the hostname. The upstream sees one sanitized forwarding hop. A CDN or second intermediary requires a fresh proxy review. Avoid logging unsubscribe URLs, credentials, bearer headers or request bodies. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) · [Automatic HTTPS](https://caddyserver.com/docs/automatic-https) · [Express proxy trust](https://expressjs.com/en/guide/behind-proxies/)

   ```caddyfile
   rentflow-stage.example.com {
     route {
       @outside not remote_ip 192.0.2.10/32
       respond @outside 403
       @localMetrics path_regexp (?i)^/api/metrics/?$
       respond @localMetrics 404
       @api path /api /api/*
       handle @api {
         reverse_proxy 127.0.0.1:5000 {
           header_up X-Forwarded-For {remote_host}
         }
       }
       handle {
         root * /opt/rentflow/current/dist
         try_files {path} /index.html
         file_server
       }
     }
   }
   ```

   During approved staging, run `sudo systemd-analyze verify /etc/systemd/system/rentflow.service`, `sudo caddy validate --config /etc/caddy/Caddyfile`, `sudo systemctl daemon-reload`, `sudo systemctl enable --now rentflow.service` and `sudo systemctl reload caddy`. Check `curl --fail http://127.0.0.1:5000/api/health` and `curl --fail https://rentflow-stage.example.com/api/health` from their intended networks. Confirm the API port is unreachable externally.

## Backup, recovery and operational gates

Use the staging-only drill below to validate the SQLite snapshot, encryption, authorized off-host retrieval and isolated restore. Nightly backup cadence, encryption key custody and independent archive verification remain proposed production requirements. This repository provides no automatic upload, backup timer or live restore command.

Before a future approved upgrade, stop writers, take and validate a fresh snapshot, rehearse the app startup against a copy of the last release's database, and inspect schema, trigger and row-count changes. For compatible code-only releases, drain, switch to the previous release and restart after checking database compatibility. For an incompatible schema or data change, preserve the failed database and sidecars. Restore a validated snapshot to a new file, and require approval of the recovery point and treatment of post-backup writes before promotion. Follow the separate [journal-mode rollback procedure](database-hardening-plan.md#guarded-wal-configuration-and-rollout--2026-11-23) if journal mode itself must be reverted.

Use the local [health and monitoring procedure](#health-and-observability--2026-11-23) to diagnose startup, worker and lock errors. Record backup freshness and queue age separately.

### Staged rollout

1. Reproduce the clean build and install on the intended Linux runtime. Verify both configurations, run two-host isolation checks for staging vs production paths, and verify no inbound route to API port 5000.
2. On synthetic staging data, verify same-origin login, per-client rate limiting, tenant isolation, worker ownership and shutdown while a child is active. Check systemd stop/restart and VM reboot, including persisted rows and readable/writable WAL and SHM in a staging-only WAL trial. Run the load harness on the intended instance shape. Check both graceful shutdown and forced recovery before allowing real records.
3. Drill encrypted off-host recovery and rehearse rollback with the prior release. Approve alert thresholds, timeout and journal choices and the database/schema plan. Only then request approval for a restricted pilot with one API instance. Keep simulation and draft mode.

### Estimated monthly operating cost

Planning estimate in USD, before taxes and bandwidth/usage overages. A DigitalOcean Basic regular Droplet with 2 vCPU/4 GiB/80 GiB is **$24/month**. A 1 vCPU/2 GiB staging VM is **$12/month**. Private Spaces Standard starts at **$5/month**. That is **$41/month** continuously, or **$53/month** if staging uses the production size. Optional weekly provider images for the production VM add **$4.80/month**. VM images supplement the SQLite online backup process. Domain, monitoring subscriptions, operator time and storage overages are excluded. Pricing and region availability must be confirmed before purchase. [Droplet pricing](https://www.digitalocean.com/pricing/droplets) · [Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/) · [Backup pricing](https://docs.digitalocean.com/products/backups/details/pricing/)

**Unresolved decisions.** Provider and region, data residency and encryption policy, pilot access and signup policy, owner/on-call, expected tenant traffic, latency/queue/backlog limits, backup retention and key custody, approved RPO/RTO, and the first migration and journal-mode rollout. The prior isolated two-API and 50-row worker benchmark supports testing the design. It does not qualify a shared-CPU VM, public rollout or cross-host SQLite.

## Health and observability · 2026-11-23

| Endpoint | Contract and access |
| --- | --- |
| `GET /api/health/live` | HTTP 200 if the API can answer. It does not touch SQLite or wait for workers. `/api/health` remains a backward-compatible alias with the same response body. |
| `GET /api/health/ready` | HTTP 200 with `{"status":"ready"}`, or HTTP 503 with `{"status":"not_ready"}`. It checks shutdown, worker freshness and one read-only `SELECT 1 FROM companies LIMIT 1` on the shared API connection. It returns no database details. The probe checks read access, not write permission, disk capacity or full schema integrity. |
| `GET /api/metrics` | Optional process-local JSON. Returns 404 when `RENTFLOW_METRICS_TOKEN` is unset, 401 without the dedicated bearer and 200 on success. Use a separate random 32–128 character URL-safe token, such as the output of `openssl rand -hex 32`. A user JWT does not grant metrics access. Keep the proxy deny rule and collect from loopback on the existing private API port. |

The three routes send `Cache-Control: no-store`. Metrics expose fixed HTTP completion, 4xx, 5xx and abort counts, SQLite busy/locked counts, database probe failures, suppressed error log counts and per-worker run, failure and success-age summary. SQLite counters cover requests, probes and classified worker exits. Monitor the change in each counter between samples and reset the rate baseline when the process restarts. Metrics contain no tenant, route, token, payload or recipient labels. Health and metrics traffic is excluded from ordinary HTTP completion counters. Observability requires no database writes, migrations, queue scans or provider calls. [HTTP endpoints](../server/app.js) · [Worker and counter state](../server/operations.js)

| Worker condition | Threshold |
| --- | --- |
| First success grace | Due worker starts immediately and has 105 seconds. Reconciliation first runs at 120 seconds and has 165 seconds. During grace, readiness can pass if the database is readable and the worker is neither failing nor stalled. |
| Stalled run | A run still in progress after 40 seconds is stale. The child command has an existing 30-second timeout. |
| Repeated failures | Two consecutive failures make readiness fail. A successful run clears the streak. |
| Overdue after a success | No new due success for 165 seconds, or no reconciliation success for 285 seconds, makes readiness fail. |
| Shutdown | The API marks readiness unavailable before stopping timers and closing the listener. Liveness can still answer on a connection that reaches the server during drain. In-flight child completions can still log their outcome. |

Startup, shutdown and worker transitions emit JSON with fixed event names, numeric durations and allowlisted counts or reason codes. Request error logs are capped at 12 per process per 60-second window, with suppressed lines counted. HTTP error messages, stacks, paths, request bodies, headers and raw child stdout/stderr are excluded from these operational logs. Keep direct operator job dry-run output restricted, since detailed job results can contain record IDs. Retain journal logs according to the approved host policy. [Scheduler output handling](../server/jobs/workerScheduler.js)

### Staging checks and operator response

1. Check `curl --fail http://127.0.0.1:5000/api/health/live` and `curl --fail http://127.0.0.1:5000/api/health/ready`. Verify the same behavior through the restricted HTTPS gateway and confirm the gateway returns 404 for metrics. Use liveness for process responsiveness. Use readiness to decide whether to admit traffic. Avoid restarting a responsive process solely because a worker or local database is temporarily busy.
2. If metrics are enabled, use an authorized host collector and pass the bearer through its secret configuration. For a local drill with the token provided in the environment, pipe the header to curl rather than placing the token in the command argument list.

   ```sh
   printf 'header = "Authorization: Bearer %s"\n' "$RENTFLOW_METRICS_TOKEN" |
     curl --fail --silent --show-error --config - http://127.0.0.1:5000/api/metrics
   ```

3. Start with a 15-second probe interval and investigate three consecutive readiness failures. If liveness passes, inspect `journalctl -u rentflow.service` for `worker_failed`, `http_error` and `startup_failed`, and check the worker statuses and database probe failures from loopback. Check file permissions, disk headroom, WAL growth and other writers before changing timeout settings. For a stalled or repeatedly failing job, confirm no old worker remains active before any supervised restart. Retain the scheduler and existing transaction replay safeguards. Keep separate alerts for stale off-host backups and queue age.
4. Drill a temporary database lock, a delayed worker and normal systemd shutdown on staging fixtures. Confirm liveness stays independent from the database, readiness and worker metrics recover after successful work, timers stop before HTTP drain, and logs contain only approved fields. Verify no secrets reach Caddy or journal output. Track busy/5xx rate and p95/p99 at the proxy separately from cumulative counters. Approve production alert thresholds after the staging baseline.

The isolated suite verified real startup, a locked SQLite fixture, scheduler grace and a stalled job, recovery after success, shutdown behavior, token access, log limits and child-output redaction. The full backend suite returned **220 passed, 0 failed, 0 skipped, 0 cancelled**. The focused suite returned **25 passed, 0 failed, 0 skipped, 0 cancelled**. Linux systemd, the live proxy, external alert delivery and production thresholds remain staging gates.

## Reproducible Linux staging workflow

These examples are for a dedicated synthetic-data VM. Use them after infrastructure approval. They have not been installed on a host. Keep one `rentflow-staging.service` and let the API own both scheduler children. Staging is separate from the candidate production service, paths, credentials, host and backup bucket or prefix.

### Install and configure after staging approval

1. Install the approved Linux Node build under `/opt/node-v24.22.3-linux-x64`, Caddy, and the Linux systemd/util-linux/iproute2 tools. Install `age` and `sha256sum` for the recovery drill. Use the build commands above with `VITE_API_URL=/`, then place the tested checkout, including both `deploy/` and `server/`, and built `dist/` in a new release directory.

   ```sh
   sudo useradd --system --home-dir /var/lib/rentflow-staging --shell /usr/sbin/nologin rentflow-staging
   sudo install -d -m 0755 /opt/rentflow-staging/releases
   sudo install -d -m 0750 /etc/rentflow-staging
   sudo install -d -o rentflow-staging -g rentflow-staging -m 0700 /var/lib/rentflow-staging
   findmnt -T /var/lib/rentflow-staging -o TARGET,SOURCE,FSTYPE,OPTIONS
   sudo -u rentflow-staging sh -c 'umask 077; set -C; : > /var/lib/rentflow-staging/rentflow.db'
   ```

   The last command is only for a new staging fixture. It refuses to overwrite an existing regular file. Confirm local persistent storage independently of the ext4/XFS guard. Leave the WAL settings commented for initial schema bootstrap. Switch only the staging copy to WAL after draining services and validating a snapshot, using the approved journal-mode procedure. Keep port 5500 private.

2. From the verified release, install the [staging unit](../deploy/staging/rentflow-staging.service) and [API environment template](../deploy/staging/api.env.example) as new files during staging setup. Stop if either target already exists and review the existing file.

   ```sh
   test ! -e /etc/systemd/system/rentflow-staging.service &&
     sudo install -m 0644 deploy/staging/rentflow-staging.service /etc/systemd/system/rentflow-staging.service
   test ! -e /etc/rentflow-staging/api.env &&
     sudo install -m 0600 deploy/staging/api.env.example /etc/rentflow-staging/api.env
   sudoedit /etc/rentflow-staging/api.env
   ```

   Fill in a bare, owned hostname whose first label is `rentflow-staging`; use that exact HTTPS origin as the unsubscribe base. Supply separately generated staging-only JWT and metrics secrets. Keep provider variables unset. Point `/opt/rentflow-staging/current` at the prepared, root-owned release and ensure Caddy can read its `dist/`. The [launcher](../deploy/staging/launch.mjs) checks the dedicated staging environment, file identity and mount before importing the write-capable app. It disables checkout dotenv files for this service.

3. Configure DNS for the chosen staging host. Install the [Caddy template](../deploy/staging/Caddyfile.example) only on the dedicated staging Caddy instance. Give Caddy its own environment file with `RENTFLOW_STAGING_HOST` and a space-separated `RENTFLOW_STAGING_ALLOWED_IPS` list of approved source CIDRs. Include loopback as shown in the template. The API secrets belong exclusively to the API unit. Use a Caddy systemd drop-in with `EnvironmentFile=/etc/rentflow-staging/caddy.env`. For validation, set only the hostname and CIDR variables in the operator shell, then use:

   ```sh
   sudo systemd-analyze verify /etc/systemd/system/rentflow-staging.service
   sudo env RENTFLOW_STAGING_HOST="$RENTFLOW_STAGING_HOST" \
     RENTFLOW_STAGING_ALLOWED_IPS="$RENTFLOW_STAGING_ALLOWED_IPS" \
     caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl daemon-reload
   sudo systemctl start rentflow-staging.service
   sudo systemctl restart caddy.service
   ```

4. Through the restricted staging origin, register a fictional tenant and create a quote with customer name exactly `RentFlow Staging Persistence Marker`. Save its `QT-…` ID. Use a new marker for a separate dataset and leave it unchanged during the drill.

### Verification and restart

From the staged checkout, run the [verifier](../deploy/staging/verify.mjs) as an authorized host operator with access to the staging process and journal. Enter the hostname and synthetic quote ID in the shell. The verifier obtains the metrics bearer from the bound staging process and never prints it or sends it to Caddy.

```sh
cd /opt/rentflow-staging/current
export RENTFLOW_STAGE_ONLY=1
read -r -p 'Owned staging hostname: ' RENTFLOW_STAGING_HOST
read -r -p 'Synthetic staging quote ID: ' RENTFLOW_STAGING_QUOTE_ID
export RENTFLOW_STAGING_HOST RENTFLOW_STAGING_QUOTE_ID
sudo --preserve-env=RENTFLOW_STAGE_ONLY,RENTFLOW_STAGING_HOST,RENTFLOW_STAGING_QUOTE_ID \
  /opt/node-v24.22.3-linux-x64/bin/node deploy/staging/verify.mjs --staging
```

- The default run checks the dedicated active systemd unit, process environment, one loopback listener owned by that PID, canonical staging file, mount, both health routes, metrics rejection at HTTPS and locally without a valid bearer, and successful runs from both workers. It reads the marker through a read-only SQLite connection. It verifies Caddy on loopback port 443 with the configured TLS name and normal CA validation. From an authorized off-host egress address also run `curl --fail "https://$RENTFLOW_STAGING_HOST/api/health/live"` and the readiness equivalent to qualify DNS, firewall, and public TLS reachability through the allowlist.
- For an explicitly approved staging restart window, rerun the same command with `--staging --restart-staging-service`. The verifier rechecks the service identity immediately before running the one fixed systemd restart. It checks a new invocation, both old-invocation drain events, endpoint and worker health, and the same persisted marker. This exercises a normal stop/start cycle. A VM reboot, forced termination and recovery under contention are separate drills. Failed verification stops the script and reports the failed check. It never retries a restart or changes the database.

### Encrypted off-host snapshot and isolated restore drill

Use only the dedicated synthetic staging database after read-only verification succeeds. Use an approved private staging bucket, separate upload and read-only retrieval identities, and an `age` recipient whose private key is held by the recovery operator off the staging VM. Confirm scope, encryption and retention with the backup owner. The commands below create local files only.

```sh
# Run this block from the verified staging checkout under the staging service account.
test "${RENTFLOW_STAGE_ONLY:-}" = 1 || exit 1
umask 077
set -e
drill=$(mktemp -d /var/lib/rentflow-staging/backup-drill.XXXXXXXX)
/opt/node-v24.22.3-linux-x64/bin/node server/database/backupDatabase.js \
  /var/lib/rentflow-staging/rentflow.db "$drill/staging.db"
/opt/node-v24.22.3-linux-x64/bin/node server/database/validateBackup.js "$drill/staging.db"
age -r "$RENTFLOW_BACKUP_AGE_RECIPIENT" -o "$drill/staging.db.age" "$drill/staging.db"
sha256sum -- "$drill/staging.db.age"
```

Record the UTC time, encrypted artifact SHA-256, expected counts, and marker ID through the approved drill record. After explicit approval, an operator may transfer **only** the `.age` object using the approved off-host storage interface. Check that the destination is the private staging bucket and use a fresh object name. No uploader or scheduled transfer is supplied. Keep the raw snapshot on restricted staging storage under the agreed retention procedure.

On the separate restore host, the verification operator uses the read-only storage identity to retrieve that exact object into a new mode-0700 scratch directory. Leave the original database and service configuration untouched. Use an authorized copy of the release. Compare the checksum before decrypting, and use a fresh scratch directory per attempt.

```sh
test "${RENTFLOW_STAGE_ONLY:-}" = 1 || exit 1
umask 077
set -e
restore=$(mktemp -d)
# Retrieve the approved encrypted object into "$restore/staging.db.age" using the read-only identity.
actual=$(sha256sum -- "$restore/staging.db.age" | cut -d ' ' -f 1)
test "$actual" = "$RENTFLOW_EXPECTED_ARCHIVE_SHA256"
age -d -i "$RENTFLOW_RESTORE_IDENTITY" -o "$restore/restored.db" "$restore/staging.db.age"
/opt/node-v24.22.3-linux-x64/bin/node server/database/validateBackup.js "$restore/restored.db"
/opt/node-v24.22.3-linux-x64/bin/node --input-type=module -e '
  import { readMarker } from "./deploy/staging/verify.mjs";
  readMarker(process.argv[1], process.argv[2]);
  console.log("Synthetic staging marker found");
' "$restore/restored.db" "$RENTFLOW_STAGING_QUOTE_ID"
```

Compare the restored counts with the snapshot evidence and record elapsed time to validated data and recovered data age. To qualify **service** recovery rather than file recovery, use a disposable restore VM and its own credentials. Copy the validated database to a new, previously absent staging path there, verify ownership, and run the isolated authenticated workflow in simulation mode after approval. Do not point either existing service at the drill artifact. No promotion or automatic cleanup runs from these scripts.

### Pending gates and rollback

| Gate | Evidence required before approval |
| --- | --- |
| Runtime and edge | Verified Linux Node/SQLite builds and dependency install, systemd/Caddy syntax on the host, authorized external HTTPS probe, private API port, proxy forwarding/rate-limit check, registration policy and manual unsubscribe URL disposition. |
| Storage and lifecycle | Persistent local disk after VM reboot, stable service ownership and writable SQLite sidecars under WAL, verified busy policy on the actual VM, cgroup drain and forced restart during active worker work. |
| Schema and data | Reviewed migrations and rollback compatibility, restore rehearsal against the relevant previous schema, synthetic-only staging data, and required production data residency, encryption and access decisions. |
| Recovery and operations | Off-host encrypted upload and fresh retrieval using separate credentials, checksum and isolated restore evidence, retention and key custody, measured RPO/RTO, queue-age/backup alerts and operator ownership. |
| Capacity and rollout | Repeat the load test on the matching VM, agree latency, contention and queue targets, and obtain pilot, hosting and deployment approval. Keep a single writer host and email disabled. |

If a staging release fails, stop only the dedicated staging unit after approval, confirm the old main process and children have drained, record the release IDs, and point the staging `current` symlink back to the verified compatible release. Start the staging unit and rerun the read-only verifier. When data or schema compatibility is uncertain, keep the failed database and sidecars and validate a separate restore on the disposable host. Changes to the database path, recovery point, journal mode or actual infrastructure require separate approval. Retain the prior environment and DNS/TLS setup while diagnosing a code-only rollback.

The existing estimate remains **$41/month** with smaller staging and **$53/month** for matching size, including baseline private object storage. A staging-only drill can use the smaller **$12/month** VM plus **$5/month** storage if both are kept continuously. Match production VM size for capacity acceptance. Costs exclude taxes, domains, overages and operator time. [Compute pricing](https://www.digitalocean.com/pricing/droplets) · [Object storage pricing](https://docs.digitalocean.com/products/spaces/details/pricing/)

Local verification used mock systemd, socket, journal, HTTPS and worker responses, and an actual temporary SQLite marker fixture. `npm --prefix server test` returned **227 passed, 0 failed, 0 skipped, 0 cancelled**. The focused `node --test --test-reporter=spec server/stagingWorkflow.test.js` run returned **7 passed, 0 failed, 0 skipped, 0 cancelled**. Actual Linux systemd, Caddy certificates, external DNS, encrypted transfer and host recovery remain unverified. No staging service was installed, restarted or provisioned in this work.

### Email staging gate

The current release has a closed real-delivery gate. The VM verification and disaster-recovery drill remain simulation-only. Run the isolated provider tests from the repository root with `node --test --test-reporter=spec server/services/mockDelivery.test.js`.

Rehearse version 2 of the [explicit ledger migration](../server/database/emailDeliveryMigration.js) on a disposable restored staging copy after approval. Validate the SQLite-aware backup, verify the resolved path points to the copy, stop its API and workers and invoke `migrateEmailDeliveryLedger(db)` with foreign keys enabled. Version 2 adds two bounded attempt error codes. A version 1 fixture upgrades by copying the attempt rows and rebuilding their constraints and index in one SQLite transaction. Verify version 2, `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and compare original queue, simulation, audit, ledger, attempt and replay receipt counts. A second invocation should report `applied: false`. The module has no CLI or startup hook. Treat restored ledger state and webhook receipts as required recovery data and verify them explicitly during restore.

Schedule any provider staging exercise separately after approval. Use a dedicated staging provider account or equivalent isolation, verified sender subdomain and explicitly allowed test recipients. Confirm provider and DNS authentication, From and Reply-To header handling, the public HTTPS unsubscribe origin, and signed event processing for duplicate, delayed and unmatched events. Rehearse an accepted send with a lost response and restoration from a snapshot that predates provider acceptance. Keep delivery gated during recovery. Reconcile provider records and suppressions before any subsequent dispatch. Record evidence without message content or tokens. [Email release gates](production-readiness-audit.md#email-provider-groundwork--2026-11-23)

#### Resend configuration and activation gates

1. **Credentials and tenant binding.** After approval, provision a staging Resend account isolated from production and customer traffic. Store a domain-restricted Sending access API key (`re_…`) and a distinct endpoint signing secret (`whsec_…`) in the approved secret store. Deliver them directly to the adapter through protected service credentials, such as systemd `LoadCredential`, once runtime wiring is reviewed. Bind the configured account label, company, From address and endpoint secret in trusted server configuration. Never select an account or signer from webhook JSON. Verify the provider account suppression scope before approving any shared-account design. No credentials are configured by this release. [Resend key permissions](https://resend.com/changelog/new-api-key-permissions) · [Resend webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
2. **Sender authentication.** Complete the RentFlow ownership TXT challenge and verify the exact sending subdomain separately in Resend. Publish the provider's SPF/return-path and DKIM records. Verify SPF and DKIM results and DMARC alignment with the visible From domain in a controlled received message. Review `_dmarc` policy and reports with the DNS owner. Check reply-to mailbox ownership and routing, Unicode or quoted display names, and the configured canonical HTTPS unsubscribe origin. A verified RentFlow TXT record alone cannot authorize sending. [Verified domains](https://resend.com/docs/dashboard/domains/introduction) · [DMARC](https://resend.com/docs/dashboard/domains/dmarc)
3. **Webhook setup.** After separate approval, wire an HTTPS POST endpoint only in staging. Authenticate `svix-id`, `svix-timestamp` and `svix-signature` over exact raw bytes before JSON middleware. Apply the 64 KiB cap at the proxy and parser, keep the host clock synchronized, and subscribe to `email.delivered`, `email.bounced` and `email.complained`. Verify endpoint-secret isolation and rotation, event redaction, receipt retention and duplicate/out-of-order behavior. Return HTTP 200 for committed or safely deduplicated events. Exercise retryable responses for database errors and unmatched events, then decide whether a durable inbox is needed before launch. Validate that a fresh Resend redelivery preserves `svix-id` and carries a fresh signature. [Resend webhook setup](https://resend.com/docs/webhooks/create-webhook) · [Retries and replay](https://resend.com/docs/webhooks/retries-and-replays)
4. **Wire and exercise authorized dispatch.** The hard-closed gate, provider connection authorization and absence of an application dispatch entry point prevent live delivery in this release. Review an explicit staging-only dispatch path and recipient allowlist before any controlled send. Verify the required provider connection attestation and approved per-tenant authorization, exact payload and idempotency behavior for one approved message, and ensure the `rentflow_delivery` tag is delivered intact on each supported webhook event. Verify a lost send response, two competing claimants, a late bounce and a snapshot restore. A matched `data.email_id` or authenticated tag can correlate an event. An event lacking both usable identifiers stays unmatched. The adapter never automatically retries submissions, including documented 429s. Treat the provider's 24-hour idempotency window as a hard limit for any future reviewed replay policy. [Send API](https://resend.com/docs/api-reference/emails/send-email) · [Idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys) · [Error reference](https://resend.com/docs/api-reference/errors)
5. **Monitor and roll back.** Before approval, assign ownership and alert on old claims, ambiguous responses, unexpected rejections, bounce or complaint spikes and webhook failure or unmatched rates. Log only bounded result codes and operational counters. For rollback, close dispatch first and preserve the database, receipts and suppressions. Keep authenticated event intake only if safe and compatible, or pause the endpoint and record events requiring replay or reconciliation. Revoke or rotate credentials if the rollback involves a suspected compromise. Restore only into a separate path and reconcile provider acceptance and suppression against the saved ledger before considering dispatch. Rehearse application downgrade with the retained additive schema and preserve the failed file for investigation.

#### Local migration and release rehearsal

The [rehearsal](../server/database/emailRelease.test.js) initializes a temporary database through the application schema, records real queue approval and simulation transitions, and takes a snapshot with `backupDatabase.js`. It restores a populated v1 ledger to a new path and kills the migration process after the attempt-table rebuild and before commit. Reopening shows v1 and the original data. A new process upgrades to v2, a repeated process reports `applied: false`, and separate recovery from the untouched v1 snapshot reproduces the original rows. Checks compare all three queue rows, the simulation attempt, seven queue audit events, outbound messages, and the ledger, attempt and event receipt. SQLite integrity and foreign-key checks pass after interruption, upgrade and recovery. This exercises database rollback by restoring to a new path. It leaves downgrade compatibility of a deployed binary for the staging rehearsal.

The backup validator previously returned success when `email_delivery_events` was absent from a migrated fixture. It now rejects partial ledgers and mismatched event account bindings and reports the ledger version and counts. For every post-migration staging snapshot or isolated restored copy, run the second form below and compare the expected version and counts against the snapshot record. The first form continues to accept an intact pre-ledger backup.

```sh
node server/database/validateBackup.js "$PRE_LEDGER_SNAPSHOT"
node server/database/validateBackup.js --require-email-ledger "$POST_MIGRATION_COPY"
```

If a staged migration is interrupted, leave the candidate and its sidecars together, reopen the candidate with the same SQLite runtime and verify its version, integrity, foreign keys and counts. If v1 and its expected counts are intact, repeat the explicit migration on the stopped, isolated candidate. For failed integrity checks, keep the candidate for investigation and create a new restore from the validated pre-migration snapshot. Start a staged code rollback with delivery off and the ledger retained, subject to compatibility verification. Avoid an in-place schema downgrade because it can discard provider evidence.

The [startup check](../server/startup.test.js) ran a technically eligible, authenticated queue item through preflight, audit, both worker entry points and simulation while trapping outbound `fetch`, HTTP and HTTPS calls in the startup process and workers. Provider-related values and a synthetic enable flag did not open the gate. The attempted send and webhook URLs returned 404 and the egress trap recorded zero attempts. The restored-copy workflow reconciled an ambiguous fixture submission with a signed bounce, recorded tenant-scoped suppression and the resulting queue audit, then deduplicated the same event after a second backup and restore.

```sh
npm --prefix server test
node --test --test-reporter=spec server/database/emailRelease.test.js server/services/resendDelivery.test.js server/services/mockDelivery.test.js server/stagingWorkflow.test.js
node --test --test-reporter=spec server/startup.test.js
node node_modules/eslint/bin/eslint.js server deploy/staging
npm run lint
```

On Node v24.22.3, the full backend suite returned **258 passed**, focused integration **37 passed**, and startup **5 passed**, with **0 failed, 0 skipped and 0 cancelled** in each run. Backend and staging lint returned **0 errors and 0 warnings**. Repository-wide lint returned **6 errors and 6 warnings**, all in the existing React frontend. The Windows rehearsal cannot verify Linux systemd, ext4/XFS, actual TLS, off-host recovery or provider behavior.

#### Proposed staging-only dispatch and webhook ingress

Keep the current staging API and schedulers in simulation mode. A subsequent, separately approved release would supply a one-shot operator command or dedicated systemd unit for staged email. Use a separate service identity, staging release path, canonical staging SQLite file and a synthetic tenant bound to one staging Resend account. Require explicit operator approval for the release, company, account, queue ID, exact normalized allowlisted address, payload digest, expiration and one permitted submission. Persist who approved it. The existing queue approval is for simulation and supplies no send authorization. Consume the staged approval and reserve the ledger claim in the same writer transaction after running current preflight and checking the exact recipient and payload. Reject a changed recipient, expired approval, altered payload, unknown account or missing provider authorization. Restrict access to the staging-owned credentials and intended outbound endpoint. Automation and any automatic replay stay disabled for the experiment. Wire the production adapter only after reviewing this separate authorization boundary and a staging-only gate that cannot activate on a production host.

Use a dedicated HTTPS callback hostname or narrowly scoped listener for `POST /api/webhooks/resend/<binding>`, where the server resolves the binding to one staging account and secret. Keep the existing operator allowlist and metrics restrictions on the API origin. Put the webhook's raw parser ahead of Express JSON middleware. Accept a single set of the three Svix headers, JSON content with identity encoding, and at most 64 KiB at both proxy and app. Reject duplicate headers, malformed bodies and unsupported encodings before forwarding to the verifier. Verify the exact signed bytes and freshness before trusting the event. Use the ledger's account, provider message ID or signed correlation tag and single recipient to determine the owning company. Acknowledge with 200 after commit, for durable duplicates, or for intentionally ignored authenticated event types. Use 400 for malformed requests, 401 for authentication failures, 409 for conflicts, and a retryable 503 for unmatched events or unavailable storage until an approved durable inbox exists. Verify the provider's handling of these statuses and its redelivery behavior in staging. Keep tokens, signer material, full event bodies and recipient addresses out of logs. Review an overlap window or recoverable replay plan for signer rotation before enabling ingress.

#### Next approvals and evidence on staging

1. Obtain operator approval for the dedicated Linux VM and synthetic dataset. Install the pinned runtime and approved artifact. Verify systemd and Caddy configuration on the actual host, the private API listener, mount and file ownership, restart and graceful worker drain. Verify DNS, TLS certificate validation, the operator allowlist and upstream header handling from an authorized off-host client. Run `deploy/staging/verify.mjs --staging` and approve its restart mode separately.
2. Create and retrieve an approved encrypted off-host backup. Check `integrity_check`, foreign keys, the marker and original queue/audit counts. Rehearse schema v2 upgrade, interruption and rollback on the isolated Linux restore path. For migrated snapshots, also require the ledger in the validator and compare attempt and replay-receipt counts. Verify code rollback, persistent writes across restart and agreed RPO/RTO.
3. Obtain separate approval for provider staging. Provision the isolated, domain-scoped Resend key and endpoint secret, verify domain ownership and provider authorization, and check SPF/DKIM/DMARC, Reply-To and the HTTPS unsubscribe origin using a controlled mailbox. Deploy the separately reviewed one-shot dispatch and scoped webhook ingress only after these prerequisites are met. Verify the live adapter's correlation tag, raw-byte TLS ingress, stale-signature rejection, key rotation, replay ordering, duplicate acknowledgment, unmatched handling and tenant suppression using only approved staging recipients. Rehearse a lost response and restore before authorizing wider traffic.
