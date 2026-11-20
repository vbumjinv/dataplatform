import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveDbConfig } from "../../db/_lib/connection";
import { resolveNewsDateToken } from "../../ingestion/_lib/news-date-token";

export const TIME_POINTS = ["T0", "T1", "T2"] as const;
export type TimePoint = (typeof TIME_POINTS)[number];

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const resolveWebDir = () => {
  if (existsSync(path.join(process.cwd(), "scripts", "kospi-forecast", "run_predict.py"))) return process.cwd();
  return path.join(process.cwd(), "web");
};

const SCRIPT_DIR = path.join(resolveWebDir(), "scripts", "kospi-forecast");
const SCRIPT_PATH = path.join(SCRIPT_DIR, "run_predict.py");

const pythonExecutable = () => {
  if (process.env.KOSPI_PREDICT_PYTHON) return process.env.KOSPI_PREDICT_PYTHON;
  const venvPython = path.join(SCRIPT_DIR, ".venv", "Scripts", "python.exe");
  if (existsSync(venvPython)) return venvPython;
  return "python";
};

export type ForecastPythonStatus = {
  command: string;
  executable: string;
  venv: boolean;
  exchangeCalendars: boolean;
  error: string;
};

export const inspectForecastPython = () =>
  new Promise<ForecastPythonStatus>((resolve) => {
    const command = pythonExecutable();
    const child = spawn(
      command,
      [
        "-c",
        "import sys,importlib.util; print(sys.executable); print('yes' if sys.prefix != sys.base_prefix else 'no'); print('yes' if importlib.util.find_spec('exchange_calendars') else 'no')",
      ],
      { cwd: SCRIPT_DIR, env: process.env, windowsHide: true },
    );
    const chunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ command, executable: "", venv: false, exchangeCalendars: false, error: "파이썬 확인 시간이 초과되었습니다." });
    }, 8000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, executable: "", venv: false, exchangeCalendars: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = chunks.join("").trim().split(/\r?\n/).filter(Boolean);
      const executable = lines[0] ?? "";
      const venv = lines[1] === "yes";
      const exchangeCalendars = lines[2] === "yes";
      if (code !== 0 || !executable) {
        resolve({
          command,
          executable,
          venv,
          exchangeCalendars,
          error: lines.slice(executable ? 1 : 0).join("\n") || `파이썬 확인 실패 (${code})`,
        });
        return;
      }
      resolve({ command, executable, venv, exchangeCalendars, error: "" });
    });
  });

const seoulStamp = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}+09:00`;
};

const runPython = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(pythonExecutable(), args, {
      cwd: SCRIPT_DIR,
      env,
      windowsHide: true,
    });
    const chunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = chunks.join("");
      if (code === 0) resolve(output);
      else reject(new Error(output.trim() || `코스피 예측 Python 실행 실패 (${code})`));
    });
  });

export const isTimePoint = (value: string): value is TimePoint =>
  (TIME_POINTS as readonly string[]).includes(value);

export const resolveForecastDate = (value: unknown) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  return resolveNewsDateToken(raw) ?? raw;
};

export const executeKospiForecast = async (input: {
  timePoint: TimePoint;
  target?: string;
  dbSettingId: number;
  llm?: boolean;
  autoTarget?: boolean;
}) => {
  if (!existsSync(SCRIPT_PATH)) throw new Error("예측 소스를 찾지 못했습니다.");
  const target = input.autoTarget ? "" : resolveForecastDate(input.target);
  if (!input.autoTarget && !isDate(target)) {
    throw new Error("예측 대상일을 YYYY-MM-DD 형식으로 입력하세요.");
  }
  const db = await resolveDbConfig({ settingId: input.dbSettingId });
  if (!db) throw new Error("선택한 DB 연결 설정을 찾을 수 없습니다.");

  const args = [SCRIPT_PATH, "--tp", input.timePoint, "--write", "--mode", "db"];
  if (target) args.push("--target", target);
  if (input.timePoint === "T2") args.push("--ready-through", seoulStamp());
  if (input.llm) args.push("--llm");

  const output = await runPython(args, {
    ...process.env,
    DP_DB_URL: db.url,
    DP_DB_NAME: db.database,
    DP_DB_USER: db.user,
    DP_DB_PASSWORD: db.password,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  });
  const found = output.match(/대상일\s+(\d{4}-\d{2}-\d{2})/);
  return {
    target: found?.[1] ?? target,
    timePoint: input.timePoint,
    output: output.slice(-12000),
  };
};

export const executeKospiEvening = async (dbSettingId: number) => {
  const script = path.join(SCRIPT_DIR, "run_automation.py");
  if (!existsSync(script)) throw new Error("저녁 작업 소스를 찾지 못했습니다.");
  const db = await resolveDbConfig({ settingId: dbSettingId });
  if (!db) throw new Error("선택한 DB 연결 설정을 찾을 수 없습니다.");
  const output = await runPython([script, "evening", "--write", "--mode", "db"], {
    ...process.env,
    DP_DB_URL: db.url,
    DP_DB_NAME: db.database,
    DP_DB_USER: db.user,
    DP_DB_PASSWORD: db.password,
    KOSPI_MLOPS_MODE: "db",
    KOSPI_PRED_MODE: "db",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  });
  return { output: output.slice(-12000) };
};
