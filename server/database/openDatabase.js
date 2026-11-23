import {
  accessSync, constants, lstatSync, mkdirSync, realpathSync, statfsSync, statSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const remoteFilesystemTypes = new Set([
  0x6969,     // NFS
  0x517b,     // SMB
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x01021997, // 9P
  0x00c36400, // Ceph
]);

function validateWalStorage(path, platform) {
  const directory = dirname(path);
  if (/^[\\/]{2}/.test(path) ||
      path.split(/[\\/]/).some((part) => /^OneDrive(?:\s+-\s+.+)?$/i.test(part)) ||
      (platform === "linux" && remoteFilesystemTypes.has(statfsSync(directory).type >>> 0))) {
    throw new Error("WAL requires a local database directory outside network or synchronized storage");
  }
  accessSync(directory, constants.W_OK);
  accessSync(path, constants.R_OK | constants.W_OK);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = path + suffix;
    const stats = lstatSync(sidecar, { throwIfNoEntry: false });
    if (stats) {
      if (!stats.isFile()) throw new Error("SQLite WAL and SHM sidecars must be regular files");
      accessSync(sidecar, constants.R_OK | constants.W_OK);
    }
  }
}

export function openRentFlowDatabase(defaultPath, env = process.env) {
  const mode = env.RENTFLOW_SQLITE_JOURNAL_MODE;
  const configuredPath = env.RENTFLOW_SQLITE_PATH;
  const useWal = mode === "wal";
  const timeout = env.RENTFLOW_SQLITE_BUSY_TIMEOUT_MS ?? "0";

  if (!/^(?:0|[1-9]\d{0,2})$/.test(timeout) || Number(timeout) > 100) {
    throw new Error("RENTFLOW_SQLITE_BUSY_TIMEOUT_MS must be a whole number from 0 to 100");
  }
  if (mode && !useWal) {
    throw new Error("RENTFLOW_SQLITE_JOURNAL_MODE must be unset or wal");
  }
  if (useWal && (!configuredPath || env.RENTFLOW_SQLITE_STORAGE !== "local-single-host")) {
    throw new Error("WAL requires RENTFLOW_SQLITE_PATH and RENTFLOW_SQLITE_STORAGE=local-single-host");
  }

  let path = defaultPath;
  if (configuredPath) {
    if (!isAbsolute(configuredPath)) {
      throw new Error("RENTFLOW_SQLITE_PATH must be absolute");
    }
    // Reject network paths before probing them, and check the resolved location below.
    if (useWal && /^[\\/]{2}/.test(configuredPath)) {
      throw new Error("WAL requires a local database directory outside network or synchronized storage");
    }
    path = realpathSync(configuredPath);
    const file = statSync(path);
    if (!file.isFile() || (useWal && file.size === 0)) {
      throw new Error("RENTFLOW_SQLITE_PATH must point to an existing database file");
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (useWal) validateWalStorage(path, process.platform);

  const db = new DatabaseSync(path, { timeout: Number(timeout) });
  if (!useWal) return db;

  try {
    const { version } = db.prepare("SELECT sqlite_version() AS version").get();
    const [major, minor, patch] = version.split(".").map(Number);
    if (major * 1000000 + minor * 1000 + patch < 3051003) {
      throw new Error("RentFlow WAL requires SQLite 3.51.3 or later");
    }

    const current = db.prepare("PRAGMA journal_mode").get().journal_mode;
    if (current !== "wal" && db.prepare("PRAGMA journal_mode = WAL").get().journal_mode !== "wal") {
      throw new Error("SQLite could not establish WAL journal mode");
    }
    db.exec("PRAGMA synchronous = FULL");
    // Exercise the real filesystem before continuing to schema initialization.
    db.prepare("PRAGMA schema_version").get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
