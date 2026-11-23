import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { checkLocalMount, checkStagingFile, staging, validateStagingEnvironment } from "../deploy/staging/guards.mjs";
import { readMarker, verificationOptions, verifyStaging } from "../deploy/staging/verify.mjs";

const host = "rentflow-staging.example.invalid";
const env = {
  RENTFLOW_STAGE_ONLY: "1",
  NODE_ENV: "production",
  PORT: "5500",
  RENTFLOW_SQLITE_PATH: staging.database,
  RENTFLOW_TRUST_LOOPBACK_PROXY: "1",
  RENTFLOW_STAGING_HOST: host,
  RENTFLOW_UNSUBSCRIBE_BASE_URL: `https://${host}`,
  JWT_SECRET: "x".repeat(72),
  RENTFLOW_METRICS_TOKEN: "y".repeat(64),
  RENTFLOW_STAGING_QUOTE_ID: "QT-2001",
};

function mock({ exposedMetrics = false, wrongSocket = false, missingDrain = false, loseMarker = false,
  activeEnv = env, stuckWorker = false, badTls = false, slowRestart = false } = {}) {
  let generation = 1;
  const commands = [];
  const requests = [];
  const runtime = {
    command(file, args) {
      commands.push([file, ...args]);
      if (file === "systemctl" && args[0] === "restart") {
        generation++;
        return "";
      }
      if (file === "systemctl") return [
        "ActiveState=active", "User=rentflow-staging", `FragmentPath=${staging.fragment}`,
        `MainPID=${generation}`, `InvocationID=${String(generation).repeat(32)}`,
      ].join("\n");
      if (file === "ss") {
        if (generation > 1 && slowRestart) {
          slowRestart = false;
          return "";
        }
        return `LISTEN 0 511 ${wrongSocket ? "0.0.0.0" : "127.0.0.1"}:5500 0.0.0.0:* users:(("node",pid=${generation},fd=3))`;
      }
      if (file === "findmnt") return "ext4 rw,relatime";
      if (file === "journalctl") {
        assert.ok(args.includes(`_SYSTEMD_INVOCATION_ID=${"1".repeat(32)}`));
        return missingDrain ? '{"event":"shutdown_started"}' :
          '{"event":"shutdown_started"}\n{"event":"http_drain_complete"}';
      }
      assert.fail("Unexpected staging command");
    },
    read(path) {
      assert.equal(path, `/proc/${generation}/environ`);
      return Object.entries(activeEnv).map(([key, value]) => `${key}=${value}`).join("\0");
    },
    async request(target, endpoint, bearer) {
      requests.push({ target, endpoint, bearer });
      if (target && badTls) throw new Error("fixture TLS verification failed");
      if (endpoint === "/api/health/live") return { status: 200, value: { status: "running" } };
      if (endpoint === "/api/health/ready") return { status: 200, value: { status: "ready" } };
      if (target) return { status: exposedMetrics ? 401 : 404 };
      if (bearer !== env.RENTFLOW_METRICS_TOKEN) return { status: 401 };
      const worker = { runs: 1, status: stuckWorker ? "stalled" : "healthy", lastSuccessAgeMs: 100 };
      return { status: 200, value: { workers: { due: worker, reconcile: worker } } };
    },
    async sleep() {},
    checkFile(path) { assert.equal(path, staging.database); },
    readMarker(path, quoteId) {
      assert.equal(path, staging.database);
      assert.equal(quoteId, "QT-2001");
      return generation > 1 && loseMarker ? "different marker" : "same marker";
    },
  };
  return { runtime, commands, requests };
}

const options = (args = ["--staging"]) => verificationOptions(args, env);
const restart = () => options(["--staging", "--restart-staging-service"]);

test("staging guards reject unsafe hosts, missing confirmation, production paths and email settings", () => {
  assert.equal(validateStagingEnvironment(env), host);
  assert.throws(() => verificationOptions([], env), /Usage/);
  assert.throws(() => verificationOptions(["--staging"], { ...env, RENTFLOW_STAGE_ONLY: "" }), /confirmation/);
  assert.throws(() => verificationOptions(["--staging"], { ...env, RENTFLOW_STAGING_QUOTE_ID: "abc" }), /marker/);
  for (const invalid of [
    { RENTFLOW_STAGING_HOST: "production.example.invalid" },
    { RENTFLOW_STAGING_HOST: "rentflow-staging.example.invalid:443" },
    { RENTFLOW_SQLITE_PATH: "/var/lib/rentflow/rentflow.db" },
    { RENTFLOW_EMAIL_PROVIDER: "unexpected" },
    { RENTFLOW_METRICS_TOKEN: env.JWT_SECRET },
  ]) {
    assert.throws(() => validateStagingEnvironment({ ...env, ...invalid }));
  }
  assert.doesNotThrow(() => checkLocalMount("ext4 rw,relatime"));
  for (const mount of ["nfs rw", "ext4 ro", "ext4 rw\nxfs rw"]) {
    assert.throws(() => checkLocalMount(mount), /writable ext4 or XFS/);
  }
});

test("staging file guard rejects aliases, multiple links and non-files", () => {
  const files = {
    lstatSync: () => ({ isFile: () => true, nlink: 1 }),
    realpathSync: () => staging.database,
  };
  assert.doesNotThrow(() => checkStagingFile(staging.database, files));
  assert.throws(() => checkStagingFile(staging.database, { ...files, realpathSync: () => "/other.db" }), /without links/);
  for (const stat of [{ isFile: () => false, nlink: 1 }, { isFile: () => true, nlink: 2 }]) {
    assert.throws(() => checkStagingFile(staging.database, { ...files, lstatSync: () => stat }), /without links/);
  }
});

test("verification without restart probes local and TLS endpoints without forwarding the metrics bearer", async () => {
  const { runtime, commands, requests } = mock();
  assert.deepEqual(await verifyStaging(options(), runtime), { checks: "passed", restart: "skipped" });
  assert.ok(!commands.some((command) => command.includes("restart")));
  assert.deepEqual(requests.filter(({ target }) => target).map(({ endpoint, bearer }) => [endpoint, bearer]), [
    ["/api/health/live", undefined], ["/api/metrics", undefined], ["/api/health/ready", undefined],
  ]);
});

test("TLS failure or exposed metrics blocks restart", async () => {
  for (const issue of [{ exposedMetrics: true }, { badTls: true }]) {
    const { runtime, commands } = mock(issue);
    await assert.rejects(verifyStaging(restart(), runtime), /hide metrics|TLS verification/);
    assert.ok(!commands.some((command) => command.includes("restart")));
  }
});

test("unsafe service identity or a stalled worker blocks restart", async () => {
  for (const issue of [
    { wrongSocket: true }, { stuckWorker: true },
    { activeEnv: { ...env, RENTFLOW_SQLITE_PATH: "/var/lib/rentflow/rentflow.db" } },
  ]) {
    const { runtime, commands } = mock(issue);
    await assert.rejects(verifyStaging(restart(), runtime), /listener|successful run|staging database/);
    assert.ok(!commands.some((command) => command.includes("restart")));
  }
});

test("explicit restart is limited to the staging unit and verifies old drain and new persistence", async () => {
  const { runtime, commands } = mock({ slowRestart: true });
  assert.deepEqual(await verifyStaging(restart(), runtime),
    { checks: "passed", restart: "drained", persistence: "verified" });
  assert.deepEqual(commands.filter((command) => command.includes("restart")),
    [["systemctl", "restart", "rentflow-staging.service"]]);
  for (const issue of [{ missingDrain: true }, { loseMarker: true }]) {
    await assert.rejects(verifyStaging(restart(), mock(issue).runtime), /graceful drain|marker changed/);
  }
});

test("the database marker probe requires an owned synthetic quote", () => {
  const path = join(mkdtempSync(join(tmpdir(), "rentflow-staging-test-")), "fixture.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE quotes (id TEXT, company_id TEXT, customer TEXT, equipment TEXT, amount REAL, status TEXT);
      INSERT INTO quotes VALUES ('QT-2001','fictional-company','RentFlow Staging Persistence Marker','Lift',100,'Pending');
      INSERT INTO quotes VALUES ('QT-2002',NULL,'RentFlow Staging Persistence Marker','Lift',100,'Pending');`);
    assert.equal(JSON.parse(readMarker(path, "QT-2001")).status, "Pending");
    assert.throws(() => readMarker(path, "QT-2002"), /synthetic staging marker/);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM quotes").get().total, 2);
  } finally {
    db.close();
  }
});
