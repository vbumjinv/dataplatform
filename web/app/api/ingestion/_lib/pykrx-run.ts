import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

export type PykrxRow = {
  date?: string;
  index_name?: string;
  index_ticker?: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  trading_value?: number | null;
};

const timeoutMs = () =>
  Math.max(5000, Number(process.env.PYKRX_TIMEOUT_MS ?? 180000) || 180000);

const resolvePaths = () => {
  const cwd = process.cwd();
  const webRoot = cwd.endsWith(`${path.sep}web`) ? cwd : path.join(cwd, "web");
  const repoRoot = path.resolve(webRoot, "..");
  const configured = process.env.PYKRX_PYTHON?.trim();
  const candidates = [
    path.join(repoRoot, "python-forecast-api", ".venv", "Scripts", "python.exe"),
    path.join(repoRoot, "python-forecast-api", ".venv", "bin", "python"),
    path.join(repoRoot, "python-forecast-api", ".venv", "bin", "python3"),
  ];
  const python = configured || candidates.find((item) => existsSync(item)) || candidates[0];
  const script = path.join(repoRoot, "python-forecast-api", "pykrx_collect.py");
  return { python, script };
};

export const runPykrxCollect = async (input: {
  dataset: string;
  start: string;
  end: string;
  sample?: boolean;
}) => {
  const { python, script } = resolvePaths();
  const timeout = timeoutMs();
  const payload = JSON.stringify({
    dataset: input.dataset,
    start: input.start,
    end: input.end,
    sample: Boolean(input.sample),
  });

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, [script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `pykrx 응답 시간 초과(${Math.round(timeout / 1000)}초). KOSPI 시리즈는 지수마다 조회하므로 기간이 길면 더 걸립니다.`,
        ),
      );
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `pykrx 실행 실패: ${error.message}. python-forecast-api 가상환경과 pykrx 설치를 확인하세요.`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!out.trim()) {
        reject(
          new Error(
            err.trim() ||
              `pykrx 가 응답하지 않았습니다. (exit ${code ?? "?"}) python-forecast-api 가상환경에 pykrx 가 있는지 확인하세요.`,
          ),
        );
        return;
      }
      resolve(out);
    });
    child.stdin.write(payload);
    child.stdin.end();
  });

  const jsonLine =
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .pop() ?? stdout.trim();
  let parsed: { ok?: boolean; rows?: PykrxRow[]; error?: string };
  try {
    parsed = JSON.parse(jsonLine) as typeof parsed;
  } catch {
    throw new Error("pykrx 응답 형식이 올바르지 않습니다.");
  }
  if (!parsed.ok) {
    throw new Error(parsed.error || "pykrx 조회에 실패했습니다.");
  }
  return parsed.rows ?? [];
};
