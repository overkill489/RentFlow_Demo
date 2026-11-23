import { lstatSync, realpathSync } from "node:fs";

export const staging = Object.freeze({
  unit: "rentflow-staging.service",
  fragment: "/etc/systemd/system/rentflow-staging.service",
  database: "/var/lib/rentflow-staging/rentflow.db",
  port: 5500,
  marker: "RentFlow Staging Persistence Marker",
});

export function stagingHostname(env) {
  const host = env.RENTFLOW_STAGING_HOST ?? "";
  if (!/^rentflow-staging(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$/.test(host) ||
      host.length > 253) {
    throw new Error("Set a bare rentflow-staging hostname under your owned domain");
  }
  return host;
}

export function validateStagingEnvironment(env) {
  if (env.RENTFLOW_STAGE_ONLY !== "1" || env.NODE_ENV !== "production" ||
      env.RENTFLOW_SQLITE_PATH !== staging.database || env.PORT !== String(staging.port) ||
      env.RENTFLOW_TRUST_LOOPBACK_PROXY !== "1") {
    throw new Error("Expected the dedicated staging database, port and service settings");
  }
  const host = stagingHostname(env);
  if (env.RENTFLOW_UNSUBSCRIBE_BASE_URL !== `https://${host}` ||
      env.RENTFLOW_EMAIL_PROVIDER || env.RENTFLOW_FROM_EMAIL) {
    throw new Error("Use the staging HTTPS origin and leave provider settings unset");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(env.RENTFLOW_METRICS_TOKEN ?? "") ||
      env.RENTFLOW_METRICS_TOKEN === env.JWT_SECRET ||
      (env.JWT_SECRET?.length ?? 0) < 64) {
    throw new Error("Provide independent staging-only API and metrics secrets");
  }
  return host;
}

export function checkStagingFile(path, files = { lstatSync, realpathSync }) {
  const stat = files.lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || files.realpathSync(path) !== path) {
    throw new Error("Expected a private, canonical staging database file without links");
  }
}

export function checkLocalMount(output) {
  const [filesystem, options, ...rest] = output.trim().split(/\s+/);
  if (!["ext4", "xfs"].includes(filesystem) || !options?.split(",").includes("rw") || rest.length) {
    throw new Error("Expected one writable ext4 or XFS staging mount");
  }
}
