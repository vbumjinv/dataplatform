const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const uvicorn = path.join(root, "python-forecast-api", ".venv", "bin", "uvicorn");
const children = [
  spawn(
    uvicorn,
    ["app:app", "--app-dir", path.join(root, "python-forecast-api"), "--host", "127.0.0.1", "--port", "8001"],
    { cwd: root, stdio: "inherit" },
  ),
  spawn("npm", ["--prefix", "web", "run", "dev"], { cwd: root, stdio: "inherit" }),
];

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid && !child.killed) child.kill("SIGTERM");
  }
};

process.on("SIGINT", () => {
  stop();
});
process.on("SIGTERM", () => {
  stop();
});

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (stopping) return;
    stop();
    process.exit(signal ? 1 : code ?? 0);
  });
}
