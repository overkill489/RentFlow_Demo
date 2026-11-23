import { lstat, link, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { backup, DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);

try {
  if (args.length !== 2 || args.some((arg) => !arg || arg.startsWith("-"))) {
    throw new Error("Usage: npm run db:backup -- <source.db> <new-backup.db>");
  }

  const sourcePath = await realpath(resolve(args[0]));
  const destination = resolve(args[1]);
  if (!(await stat(sourcePath)).isFile()) {
    throw new Error("Backup source must be an existing database file");
  }
  if (/(?:-wal|-shm|-journal)$/i.test(destination)) {
    throw new Error("Backup destination cannot be a SQLite sidecar");
  }

  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const existing = await lstat(destination + suffix).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (existing) throw new Error("Backup destination or a SQLite sidecar already exists");
  }

  const directory = await mkdtemp(join(dirname(destination), ".rentflow-backup-"));
  try {
    const stagedPath = join(directory, "snapshot.db");
    await writeFile(stagedPath, "", { flag: "wx", mode: 0o600 });
    const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 });
    let pages;
    try {
      pages = await backup(source, stagedPath);
    } finally {
      source.close();
    }

    const snapshot = await open(stagedPath, "r+");
    try {
      await snapshot.sync();
    } finally {
      await snapshot.close();
    }

    // Publish the completed file without replacing a destination created concurrently.
    await link(stagedPath, destination);
    console.log(JSON.stringify({ backup: destination, pages }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
}
