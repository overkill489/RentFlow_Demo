import { execFileSync } from "node:child_process";
import process from "node:process";
import { checkLocalMount, checkStagingFile, staging, validateStagingEnvironment } from "./guards.mjs";

try {
  if (process.platform !== "linux") throw new Error("This staging launcher requires Linux");
  validateStagingEnvironment(process.env);
  checkStagingFile(staging.database);
  checkLocalMount(execFileSync("findmnt", ["-T", staging.database, "-n", "-o", "FSTYPE,OPTIONS"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
  }));
  // The systemd EnvironmentFile is the only configuration source for this service.
  process.env.DOTENV_CONFIG_PATH = "/dev/null";
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
await import("../../server/index.js");
