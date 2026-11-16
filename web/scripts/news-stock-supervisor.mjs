import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startDate = process.argv[2] ?? "";
const endDate = process.argv[3] ?? "";
const settingId = process.argv[4] ?? "";
const progressPath = process.argv[5] ?? "";
const startedAt = process.argv[6] ?? String(Date.now());
const pidPath = process.argv[7] ?? "";

if (!startDate || !endDate || !progressPath || !pidPath) {
  process.exit(1);
}

mkdirSync(path.dirname(pidPath), { recursive: true });
mkdirSync(path.dirname(progressPath), { recursive: true });
writeFileSync(pidPath, String(process.pid));

const loader = path.join(webDir, "scripts", "ts-ext-register.mjs");
const worker = path.join(webDir, "scripts", "news-stock-worker.mts");
const logPath = path.join(path.dirname(progressPath), "worker.log");
const logFd = openSync(logPath, "a");

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const run = () => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "--max-old-space-size=2048",
      "--import",
      pathToFileURL(loader).href,
      worker,
      startDate,
      endDate,
      settingId,
      progressPath,
      startedAt,
    ],
    {
      cwd: webDir,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: process.env,
    },
  );
  const started = Date.now();
  child.on("exit", (code, signal) => {
    if (stopping) {
      process.exit(0);
      return;
    }
    const heapCrash = code === 75 || code === 134 || signal === "SIGABRT";
    if (!heapCrash) {
      process.exit(0);
      return;
    }
    const delay = Date.now() - started < 15000 ? 15000 : 2000;
    setTimeout(run, delay);
  });
};

run();
