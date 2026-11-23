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
| High | **Deployment and recovery on the target host are unverified.** No deployment manifests, persistent mount, proxy topology, scheduled backup, off-host retention or restore drill are checked in. Existing backup and WAL verification used temporary local files. | Perform the staging gates below and record measured restore time and data age. Never treat the provider disk image as the SQLite recovery artifact. [Database hardening plan](database-hardening-plan.md) |
| High | **The original startup validated JWT after write-capable imports.** An invalid secret on a disposable zero-byte file failed startup after creating 229,376 bytes of SQLite data. A clean standalone backend install also failed to import `express-rate-limit`. | Startup now validates JWT presence/length, an explicit production database path, port and proxy settings before importing the app. The dependency and its lock entries now belong to the backend. Generate a random signing secret. The length check does not measure entropy. [Startup](../server/index.js) · [Backend manifest](../server/package.json) |
| High | **Public edge behavior needs acceptance.** The default client build uses the visitor's localhost. Express also needs the actual client address to apply per-client login limits behind a loopback proxy. Registration creates a company administrator. | Build with `VITE_API_URL=/`. Enable the one-hop loopback trust explicitly only for the proposed sanitized proxy. Restrict the whole pilot to approved source addresses and agree on signup and reset policy before general release. [API client](../src/services/rentflowApi.js#L1) · [Proxy opt-in](../server/app.js#L17) |
| Medium | **Shutdown and monitoring have limits.** The API now stops the timer schedules on shutdown, closes the HTTP listener and closes its own SQLite connection after HTTP drain. The worker child processes finish independently within their existing timeout. Health is liveness-only. There is no durable worker health or structured request latency metric. | Verify genuine Linux SIGTERM, cgroup drain, a forced stop and restart under contention in staging. Use supervisor and proxy observations plus synthetic probes. Monitor worker success, contention, queue age and backup freshness independently. [Startup lifecycle](../server/index.js) · [Scheduler](../server/jobs/startFollowUpScheduler.js) |
| Medium | **Manual unsubscribe-link URLs still use localhost.** Automated draft templates honor `RENTFLOW_UNSUBSCRIBE_BASE_URL`. The manual admin link route has its own hard-coded origin. | Keep real email disabled. Treat the manual absolute URL as a known pilot limitation. Test unsubscribe with a staged draft from the configured HTTPS origin. Resolve the manual URL before exposing that workflow to operators. [Manual link route](../server/routes/delivery.js#L488) · [Draft template](../server/services/followUpEmailTemplate.js#L12) |

Locally tested on Node v24.22.3, npm 11.19.1 and SQLite 3.54.1. The clean backend install used its own lockfile in an isolated directory. The unchanged React build succeeded with `VITE_API_URL=/` and the generated bundle contained relative `/api` URLs. The startup tests exercised real API startup, its initial child job, invalid settings, per-client login limits, shutdown and authenticated restart on a disposable database using the guarded WAL path and a 25 ms API wait. The shutdown test delivers the Node signal event through IPC on Windows. It does not qualify Linux process signaling or Caddy/TLS. Existing loopback development CORS stays in place. Same-origin proxying avoids relying on cross-origin CORS. `npm --prefix server test` returned **216 passed, 0 failed, 0 skipped, 0 cancelled**. The four startup tests also passed on the isolated clean backend install. [Startup tests](../server/startup.test.js)

## Setup after infrastructure approval

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

Use a private bucket with distinct staging/production prefixes. Keep backup configuration, scoped object-store credentials and the public recipient key in a root-owned `0600` environment file. Set `RENTFLOW_SQLITE_PATH` to the same absolute database path as the API, `RENTFLOW_BACKUP_AGE_RECIPIENT` to the public encryption recipient, and `RENTFLOW_BACKUP_REMOTE` to an rclone destination such as `rentflow:private-rentflow-backups/staging`. Define that remote using restricted rclone configuration supplied by the service environment and verify its permissions. Keep the decryption key off-host and protect archives independently from credentials on the VM. Install `age`, `rclone` and `flock` on staging before enabling the timer.

Place the following script in `/usr/local/sbin/rentflow-backup` with root ownership and mode `0755`.

```sh
#!/bin/sh
set -eu
umask 077
cd /opt/rentflow/current/server
export PATH=/opt/node-v24.22.3-linux-x64/bin:$PATH
exec 9>/var/lib/rentflow/backups/backup.lock
flock -n 9
stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
snapshot="/var/lib/rentflow/backups/rentflow-$stamp.db"
npm run db:backup -- "$RENTFLOW_SQLITE_PATH" "$snapshot"
npm run db:validate-backup -- "$snapshot"
age -r "$RENTFLOW_BACKUP_AGE_RECIPIENT" -o "$snapshot.age" "$snapshot"
rclone copyto --immutable "$snapshot.age" "$RENTFLOW_BACKUP_REMOTE/$(basename "$snapshot.age")"
```

Install `/etc/systemd/system/rentflow-backup.service` and `/etc/systemd/system/rentflow-backup.timer` during approved staging.

```ini
# rentflow-backup.service
[Unit]
Description=RentFlow SQLite snapshot, validation and off-host upload
RequiresMountsFor=/var/lib/rentflow
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=rentflow
Group=rentflow
EnvironmentFile=/etc/rentflow/backup.env
ExecStart=/usr/local/sbin/rentflow-backup
TimeoutStartSec=10min
UMask=0077
PrivateTmp=yes
```

```ini
# rentflow-backup.timer
[Unit]
Description=Nightly RentFlow backup

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

Run `sudo systemctl daemon-reload`, then `sudo systemctl start rentflow-backup.service` for the first drill. Verify its output with `sudo journalctl -u rentflow-backup.service` and retrieve the resulting archive from off-host storage before running `sudo systemctl enable --now rentflow-backup.timer`.

- Treat an upload as provisional until a separate verifier retrieves the encrypted file, decrypts it in restricted storage, runs `npm run db:validate-backup -- /absolute/path/restored.db`, and checks expected company, user, quote and queue counts. In a drill, boot an isolated staging service on that restored path and test login, a quote, a follow-up and simulated queue processing. Capture time from incident start to usable service and the age of the recovered data. Start with a proposed daily RPO, subject to approval, and measure RTO before committing to it. Apply a separately approved local/remote retention policy to keep disk bounded.
- Before each upgrade, stop writers, take and validate a fresh snapshot, rehearse the app startup against a copy of the last release's database, and inspect schema, trigger and row-count changes. For reversible code-only releases, drain, switch the release symlink back and restart after checking database compatibility. If the schema or data is incompatible with the previous release, stop all writers and restore a validated backup to a **new** file. Point the previous release at that absolute path only after an approved decision about post-backup writes. Preserve the failed file and its SQLite-managed sidecars. Use the separate [journal-mode rollback procedure](database-hardening-plan.md#guarded-wal-configuration-and-rollout--2026-11-23) if journal mode itself must be reverted.
- Use `journalctl -u rentflow.service` and the backup service journal for startup recovery, due/reconcile success and errors. Alert on missed worker successes, elevated SQLite busy/500 counts, quote-list p95/p99, queue age, stale verified backups, disk headroom and abnormal WAL growth. Measure API latency and status counts at the proxy with fields that omit tokenized paths. Use an authenticated staging probe for database and tenant readiness alongside the public liveness route. The code has no operational readiness endpoint or durable worker heartbeat.

### Staged rollout

1. Reproduce the clean build and install on the intended Linux runtime. Verify both configurations, run two-host isolation checks for staging vs production paths, and verify no inbound route to API port 5000.
2. On synthetic staging data, verify same-origin login, per-client rate limiting, tenant isolation, worker ownership and shutdown while a child is active. Check systemd stop/restart and VM reboot, including persisted rows and readable/writable WAL and SHM in a staging-only WAL trial. Run the load harness on the intended instance shape. Check both graceful shutdown and forced recovery before allowing real records.
3. Drill encrypted off-host recovery and rehearse rollback with the prior release. Approve alert thresholds, timeout and journal choices and the database/schema plan. Only then request approval for a restricted pilot with one API instance. Keep simulation and draft mode.

### Estimated monthly operating cost

Planning estimate in USD, before taxes and bandwidth/usage overages. A DigitalOcean Basic regular Droplet with 2 vCPU/4 GiB/80 GiB is **$24/month**. A 1 vCPU/2 GiB staging VM is **$12/month**. Private Spaces Standard starts at **$5/month**. That is **$41/month** continuously, or **$53/month** if staging uses the production size. Optional weekly provider images for the production VM add **$4.80/month**. VM images supplement the SQLite online backup process. Domain, monitoring subscriptions, operator time and storage overages are excluded. Pricing and region availability must be confirmed before purchase. [Droplet pricing](https://www.digitalocean.com/pricing/droplets) · [Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/) · [Backup pricing](https://docs.digitalocean.com/products/backups/details/pricing/)

**Unresolved decisions.** Provider and region, data residency and encryption policy, pilot access and signup policy, owner/on-call, expected tenant traffic, latency/queue/backlog limits, backup retention and key custody, approved RPO/RTO, and the first migration and journal-mode rollout. The prior isolated two-API and 50-row worker benchmark supports testing the design. It does not qualify a shared-CPU VM, public rollout or cross-host SQLite.
