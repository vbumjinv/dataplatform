import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StockNewsRangeProgress } from "./naver-stock-news";
import { connectNewsClient } from "./news-collect";

const runtimeDir = path.join(os.tmpdir(), "finjump-news-stock");
const progressPath = path.join(runtimeDir, "progress.json");
const pidPath = path.join(runtimeDir, "supervisor.pid");

type JobState = StockNewsRangeProgress & {
  running: boolean;
  startedAt: number;
  dbSettingId: number | null;
};

type CollectStatus = "running" | "done" | "error";

const idleJob = (): JobState => ({
  running: false,
  startedAt: 0,
  date: "",
  startDate: "",
  endDate: "",
  dayIndex: 0,
  dayCount: 0,
  phase: "done",
  listCount: 0,
  bodyTotal: 0,
  bodyDone: 0,
  bodyOk: 0,
  elapsedMs: 0,
  message: "",
  error: "",
  dbSettingId: null,
});

const getJob = (): JobState => {
  const globalRef = globalThis as typeof globalThis & { __naverStockNewsJob?: JobState };
  if (!globalRef.__naverStockNewsJob) {
    globalRef.__naverStockNewsJob = idleJob();
  }
  return globalRef.__naverStockNewsJob;
};

const saveCollectJob = async (
  startDate: string,
  endDate: string,
  dbSettingId: number | null,
  status: CollectStatus,
  message: string,
) => {
  const client = await connectNewsClient(dbSettingId);
  try {
    await client.query(
      `insert into dp.news_stock_collect_job (
         id, start_date, end_date, db_setting_id, status, message, updated_at
       )
       values (1, $1::date, $2::date, $3, $4, $5, now())
       on conflict (id) do update
         set start_date = excluded.start_date,
             end_date = excluded.end_date,
             db_setting_id = excluded.db_setting_id,
             status = excluded.status,
             message = excluded.message,
             updated_at = now()`,
      [startDate, endDate, dbSettingId, status, message.slice(0, 500)],
    );
  } finally {
    await client.end();
  }
};

const globalFlags = globalThis as typeof globalThis & { __naverStockNewsOwned?: boolean };

const isPidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readSupervisorPid = () => {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) ? pid : 0;
  } catch {
    return 0;
  }
};

const isSupervisorAlive = () => isPidAlive(readSupervisorPid());

const adoptProgress = () => {
  try {
    const parsed = JSON.parse(readFileSync(progressPath, "utf8")) as Partial<JobState>;
    const job = getJob();
    if (typeof parsed.date === "string") job.date = parsed.date;
    if (typeof parsed.startDate === "string") job.startDate = parsed.startDate;
    if (typeof parsed.endDate === "string") job.endDate = parsed.endDate;
    if (typeof parsed.dayIndex === "number") job.dayIndex = parsed.dayIndex;
    if (typeof parsed.dayCount === "number") job.dayCount = parsed.dayCount;
    if (parsed.phase === "list" || parsed.phase === "body" || parsed.phase === "done" || parsed.phase === "error") {
      job.phase = parsed.phase;
    }
    if (typeof parsed.listCount === "number") job.listCount = parsed.listCount;
    if (typeof parsed.bodyTotal === "number") job.bodyTotal = parsed.bodyTotal;
    if (typeof parsed.bodyDone === "number") job.bodyDone = parsed.bodyDone;
    if (typeof parsed.bodyOk === "number") job.bodyOk = parsed.bodyOk;
    if (typeof parsed.message === "string") job.message = parsed.message;
    if (typeof parsed.error === "string") job.error = parsed.error;
    if (typeof parsed.startedAt === "number" && parsed.startedAt > 0) job.startedAt = parsed.startedAt;
    if (typeof parsed.dbSettingId === "number" || parsed.dbSettingId === null) job.dbSettingId = parsed.dbSettingId;
    const finished = job.phase === "done" || job.phase === "error";
    const pidAlive = isSupervisorAlive();
    const starting = !finished && job.startedAt > 0 && Date.now() - job.startedAt < 20000;
    job.running = pidAlive || starting;
    if (!job.running && finished && typeof parsed.elapsedMs === "number") job.elapsedMs = parsed.elapsedMs;
    else if (job.running && job.startedAt > 0) job.elapsedMs = Date.now() - job.startedAt;
  } catch {
    // 진행 파일이 아직 없으면 메모리 상태를 유지한다.
  }
};

const webDir = () => {
  if (existsSync(path.join(process.cwd(), "scripts", "news-stock-supervisor.mjs"))) return process.cwd();
  return path.join(process.cwd(), "web");
};

const spawnSupervisor = (startDate: string, endDate: string, dbSettingId: number | null, startedAt: number) => {
  mkdirSync(runtimeDir, { recursive: true });
  const supervisor = path.join(webDir(), "scripts", "news-stock-supervisor.mjs");
  const child = spawn(
    process.execPath,
    [
      supervisor,
      startDate,
      endDate,
      dbSettingId ? String(dbSettingId) : "",
      progressPath,
      String(startedAt),
      pidPath,
    ],
    {
      cwd: webDir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  child.on("error", () => {
    globalFlags.__naverStockNewsOwned = false;
    const current = getJob();
    current.running = false;
    current.phase = "error";
    current.error = "수집 프로세스를 시작하지 못했습니다.";
    current.message = current.error;
  });
  child.unref();
  globalFlags.__naverStockNewsOwned = true;
};

const writeJobFile = (job: JobState) => {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    progressPath,
    JSON.stringify({
      date: job.date,
      startDate: job.startDate,
      endDate: job.endDate,
      dayIndex: job.dayIndex,
      dayCount: job.dayCount,
      phase: job.phase,
      listCount: job.listCount,
      bodyTotal: job.bodyTotal,
      bodyDone: job.bodyDone,
      bodyOk: job.bodyOk,
      elapsedMs: job.elapsedMs,
      message: job.message,
      error: job.error,
      running: job.running,
      startedAt: job.startedAt,
      dbSettingId: job.dbSettingId,
    }),
  );
};

const launchStockNewsJob = (
  startDate: string,
  endDate: string,
  dbSettingId: number | null,
  startedAt: number,
) => {
  void saveCollectJob(startDate, endDate, dbSettingId, "running", "수집을 시작합니다.").catch(() => undefined);
  spawnSupervisor(startDate, endDate, dbSettingId, startedAt);
};

export const readStockNewsJob = () => {
  adoptProgress();
  const job = getJob();
  if (job.running && job.startedAt > 0) job.elapsedMs = Date.now() - job.startedAt;
  return { ...job };
};

export const startStockNewsJob = (
  startDate: string,
  endDate: string,
  dbSettingId?: number | null,
) => {
  adoptProgress();
  const job = getJob();
  const finished = job.phase === "done" || job.phase === "error";
  if (isSupervisorAlive() && !finished) {
    job.running = true;
    return { started: false, job: { ...job } };
  }
  const startedAt = Date.now();
  const settingId = typeof dbSettingId === "number" ? dbSettingId : null;
  job.running = true;
  job.startedAt = startedAt;
  job.date = startDate;
  job.startDate = startDate;
  job.endDate = endDate;
  job.dayIndex = 0;
  job.dayCount = 0;
  job.phase = "list";
  job.listCount = 0;
  job.bodyTotal = 0;
  job.bodyDone = 0;
  job.bodyOk = 0;
  job.elapsedMs = 0;
  job.message = "수집을 시작합니다.";
  job.error = "";
  job.dbSettingId = settingId;
  writeJobFile(job);
  launchStockNewsJob(startDate, endDate, settingId, startedAt);
  return { started: true, job: { ...job } };
};

