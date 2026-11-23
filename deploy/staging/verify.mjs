import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { checkLocalMount, checkStagingFile, staging, stagingHostname, validateStagingEnvironment } from "./guards.mjs";

export function verificationOptions(args, env) {
  if (!(args.length === 1 && args[0] === "--staging") &&
      !(args.length === 2 && args[0] === "--staging" && args[1] === "--restart-staging-service")) {
    throw new Error("Usage: node deploy/staging/verify.mjs --staging [--restart-staging-service]");
  }
  if (env.RENTFLOW_STAGE_ONLY !== "1") throw new Error("Explicit staging confirmation is required");
  const quoteId = env.RENTFLOW_STAGING_QUOTE_ID ?? "";
  if (!/^QT-\d{1,15}$/.test(quoteId)) throw new Error("Provide the synthetic staging marker quote ID");
  return { host: stagingHostname(env), quoteId, restart: args.length === 2 };
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

function serviceState(output) {
  const values = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => line.split("=")));
  requireState(values.ActiveState === "active" && values.User === "rentflow-staging" &&
    values.FragmentPath === staging.fragment && /^[1-9]\d*$/.test(values.MainPID ?? "") &&
    /^[0-9a-f]{32}$/.test(values.InvocationID ?? ""), "Expected the active dedicated staging unit");
  return { pid: values.MainPID, invocation: values.InvocationID };
}

export function inspectService(runtime, host) {
  const service = serviceState(runtime.command("systemctl", [
    "show", "--no-pager", "-p", "ActiveState", "-p", "User", "-p", "FragmentPath",
    "-p", "MainPID", "-p", "InvocationID", staging.unit,
  ]));
  const lines = runtime.read(`/proc/${service.pid}/environ`).split("\0").filter(Boolean);
  const env = Object.fromEntries(lines.map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  requireState(validateStagingEnvironment(env) === host, "Service and verifier staging hostnames differ");
  const output = runtime.command("ss", ["-H", "-ltnp", "sport", "=", `:${staging.port}`]).trim();
  if (!output) throw Object.assign(new Error("Staging listener has not started"), { code: "STAGING_LISTENER_PENDING" });
  const sockets = output.split(/\r?\n/);
  requireState(sockets.length === 1 && sockets[0].trim().split(/\s+/)[3] === `127.0.0.1:${staging.port}` &&
    sockets[0].includes(`pid=${service.pid},`), "Expected the staging PID to own the only loopback listener");
  return { ...service, metricsToken: env.RENTFLOW_METRICS_TOKEN };
}

export function readMarker(path, quoteId) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    const row = db.prepare(`
      SELECT id, company_id, customer, equipment, amount, status
      FROM quotes WHERE id = ? AND company_id IS NOT NULL AND customer = ?
    `).get(quoteId, staging.marker);
    requireState(row, "Create the synthetic staging marker quote before verification");
    return JSON.stringify(row);
  } finally {
    db.close();
  }
}

function request(host, path, bearer) {
  return new Promise((resolve, reject) => {
    const secure = Boolean(host);
    const send = secure ? httpsRequest : httpRequest;
    const headers = secure ? { Host: host } : {};
    // Even an incorrectly configured proxy never gets the metrics bearer.
    if (!secure && bearer) headers.Authorization = `Bearer ${bearer}`;
    const req = send({
      hostname: "127.0.0.1", port: secure ? 443 : staging.port, path, headers,
      servername: host, rejectUnauthorized: true, signal: AbortSignal.timeout(5000), agent: false,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (part) => {
        body += part;
        if (body.length > 32768) req.destroy(new Error("Unexpected staging response size"));
      });
      res.on("error", reject);
      res.on("end", () => {
        let value;
        try { value = JSON.parse(body); } catch { /* Error responses can be plain text. */ }
        resolve({ status: res.statusCode, value });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForWorkers(runtime, service) {
  for (let attempt = 0; attempt < 85; attempt++) {
    const metrics = await runtime.request(null, "/api/metrics", service.metricsToken);
    requireState(metrics.status === 200, "Local metrics did not accept the dedicated bearer");
    const workers = metrics.value?.workers;
    if (["due", "reconcile"].every((name) => workers?.[name]?.runs > 0 &&
        workers[name].status === "healthy" && Number.isFinite(workers[name].lastSuccessAgeMs))) return;
    await runtime.sleep(2000);
  }
  throw new Error("Both schedulers must complete a successful run within the staging probe window");
}

async function verifyEndpoints(runtime, host, service) {
  for (const target of [null, host]) {
    const live = await runtime.request(target, "/api/health/live");
    requireState(live.status === 200 && live.value?.status === "running", "Liveness probe failed");
  }
  requireState((await runtime.request(host, "/api/metrics")).status === 404, "HTTPS proxy must hide metrics");
  requireState((await runtime.request(null, "/api/metrics")).status === 401, "Local metrics must reject anonymous requests");
  requireState((await runtime.request(null, "/api/metrics", "not-a-staging-token")).status === 401,
    "Local metrics must reject the wrong bearer");
  await waitForWorkers(runtime, service);
  for (const target of [null, host]) {
    const ready = await runtime.request(target, "/api/health/ready");
    requireState(ready.status === 200 && ready.value?.status === "ready", "Readiness probe failed");
  }
}

async function waitForListener(runtime, host) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return inspectService(runtime, host);
    } catch (error) {
      if (error.code !== "STAGING_LISTENER_PENDING") throw error;
      await runtime.sleep(1000);
    }
  }
  throw new Error("Staging listener did not return after restart");
}

export async function verifyStaging(options, runtime) {
  const initial = inspectService(runtime, options.host);
  runtime.checkFile(staging.database);
  checkLocalMount(runtime.command("findmnt", ["-T", staging.database, "-n", "-o", "FSTYPE,OPTIONS"]));
  const marker = runtime.readMarker(staging.database, options.quoteId);
  await verifyEndpoints(runtime, options.host, initial);
  if (!options.restart) return { checks: "passed", restart: "skipped" };

  const current = inspectService(runtime, options.host);
  requireState(current.invocation === initial.invocation, "Staging service changed before restart authorization");
  runtime.command("systemctl", ["restart", staging.unit], 60000);
  const next = await waitForListener(runtime, options.host);
  requireState(next.invocation !== initial.invocation, "Expected a new staging service invocation");
  const journal = runtime.command("journalctl", [
    "--no-pager", "-o", "cat", "-u", staging.unit, `_SYSTEMD_INVOCATION_ID=${initial.invocation}`,
  ]);
  const events = new Set(journal.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line)?.event; } catch { return null; }
  }));
  requireState(events.has("shutdown_started") && events.has("http_drain_complete"), "Old invocation did not report graceful drain");
  await verifyEndpoints(runtime, options.host, next);
  runtime.checkFile(staging.database);
  requireState(runtime.readMarker(staging.database, options.quoteId) === marker, "Staging marker changed during restart");
  return { checks: "passed", restart: "drained", persistence: "verified" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = verificationOptions(process.argv.slice(2), process.env);
    if (process.platform !== "linux") throw new Error("Staging verification requires the Linux VM");
    const runtime = {
      command: (file, args, timeout = 10000) => execFileSync(file, args, {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      }),
      read: (path) => readFileSync(path, "utf8"),
      checkFile: checkStagingFile, readMarker, request, sleep,
    };
    console.log(JSON.stringify(await verifyStaging(options, runtime)));
  } catch (error) {
    console.error(`Staging verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
