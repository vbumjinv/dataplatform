import cron, { type ScheduledTask } from "node-cron";
import { Client } from "pg";
import { resolveNewsDateToken } from "./news-date-token";
import { readNewsStockSource, type NewsStockSourceSetting } from "./news-stock-source";
import { startStockNewsJob } from "./naver-stock-news-job";

const CRON_TIMEZONE = "Asia/Seoul";
const CRON_MAX_RANDOM_DELAY_MS = 5 * 60 * 1000;
const SCHEDULE_LOCK_NS = 8102;
const SCHEDULE_LOCK_KEY = 1;
const CONNECT_TIMEOUT_MS = 5000;

type JobHandle = {
  type: "interval" | "cron";
  handle: NodeJS.Timeout | ScheduledTask;
};

type SchedulerState = {
  initialized: boolean;
  job: JobHandle | null;
  ensuring?: boolean;
  watch?: NodeJS.Timeout | null;
};

const globalForScheduler = globalThis as typeof globalThis & {
  __newsStockSchedulerState?: SchedulerState;
};

const state =
  globalForScheduler.__newsStockSchedulerState ??
  (globalForScheduler.__newsStockSchedulerState = {
    initialized: false,
    job: null,
  });

const stopJob = () => {
  if (!state.job) return;
  if (state.job.type === "interval") clearInterval(state.job.handle as NodeJS.Timeout);
  else (state.job.handle as ScheduledTask).stop();
  state.job = null;
};

const envClient = () => {
  const url = process.env.DP_DB_URL;
  const database = process.env.DP_DB_NAME;
  const user = process.env.DP_DB_USER;
  const password = process.env.DP_DB_PASSWORD;
  if (!url || !database || !user || !password) return null;
  const normalized = url.startsWith("jdbc:") ? url.replace(/^jdbc:/, "") : url;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return null;
  parsed.username = user;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return new Client({ connectionString: parsed.toString(), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
};

const executeSchedule = async () => {
  const lockClient = envClient();
  let locked = false;
  try {
    if (lockClient) {
      await lockClient.connect();
      const lockResult = await lockClient.query<{ locked: boolean }>(
        `select pg_try_advisory_lock($1, $2) as locked`,
        [SCHEDULE_LOCK_NS, SCHEDULE_LOCK_KEY],
      );
      locked = Boolean(lockResult.rows[0]?.locked);
      if (!locked) {
        console.error("[news-stock-scheduler] 다른 실행이 잠금을 잡고 있어 이번 시각은 건너뜁니다.");
        return;
      }
    }
    const setting = await readNewsStockSource(null);
    if (!setting.scheduleEnabled) {
      console.error("[news-stock-scheduler] 스케줄이 꺼져 있어 건너뜁니다.");
      return;
    }
    const startDate = resolveNewsDateToken(setting.startExpr);
    const endDate = resolveNewsDateToken(setting.endExpr);
    if (!startDate || !endDate) {
      console.error("[news-stock-scheduler] 날짜를 해석하지 못해 건너뜁니다.");
      return;
    }
    console.log(`[news-stock-scheduler] 실행 ${startDate}~${endDate}`);
    startStockNewsJob(startDate, endDate, setting.dbSettingId);
  } catch (error) {
    console.error(
      "[news-stock-scheduler] failed:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (lockClient) {
      try {
        if (locked) {
          await lockClient.query(`select pg_advisory_unlock($1, $2)`, [SCHEDULE_LOCK_NS, SCHEDULE_LOCK_KEY]);
        }
      } catch {
        // ignore unlock errors
      }
      try {
        await lockClient.end();
      } catch {
        // ignore cleanup errors
      }
    }
  }
};

const registerJob = (setting: NewsStockSourceSetting) => {
  stopJob();
  if (!setting.scheduleEnabled) return;
  if (setting.scheduleType === "cron" && setting.scheduleCronExpr.trim()) {
    if (!cron.validate(setting.scheduleCronExpr.trim())) return;
    const task = cron.schedule(
      setting.scheduleCronExpr.trim(),
      () => executeSchedule(),
      {
        name: "news-stock-naver-pay",
        timezone: CRON_TIMEZONE,
        noOverlap: true,
        maxRandomDelay: CRON_MAX_RANDOM_DELAY_MS,
      },
    );
    task.on("execution:missed", () => {
      console.warn("[news-stock-scheduler] 놓친 시각이 있어 지금 실행합니다.");
      void executeSchedule();
    });
    state.job = { type: "cron", handle: task };
    return;
  }
  const minutes = Number.isFinite(setting.scheduleIntervalMinutes)
    ? Math.max(1, Number(setting.scheduleIntervalMinutes))
    : 60;
  const handle = setInterval(() => {
    void executeSchedule();
  }, minutes * 60 * 1000);
  state.job = { type: "interval", handle };
};

const taskAlive = () => {
  const current = state.job;
  if (!current) return false;
  if (current.type === "interval") return true;
  const status = current.handle.getStatus();
  if (status instanceof Promise) return true;
  return status === "idle" || status === "running";
};

const armWatch = () => {
  if (state.watch) return;
  state.watch = setInterval(() => {
    void ensureNewsStockScheduler();
  }, 30_000);
};

export const ensureNewsStockScheduler = async () => {
  armWatch();
  if (state.ensuring || taskAlive()) return;
  state.ensuring = true;
  try {
    const setting = await readNewsStockSource(null);
    if (!setting.scheduleEnabled) {
      stopJob();
      state.initialized = true;
      return;
    }
    if (!taskAlive()) {
      registerJob(setting);
      if (state.job) {
        const when = setting.scheduleType === "cron" ? setting.scheduleCronExpr : `${setting.scheduleIntervalMinutes}분`;
        console.log(`[news-stock-scheduler] 스케줄을 등록했습니다. ${when}`);
      } else {
        console.error("[news-stock-scheduler] 스케줄을 등록하지 못했습니다.");
      }
    }
    state.initialized = Boolean(state.job);
  } catch (error) {
    state.initialized = false;
    console.error(
      "[news-stock-scheduler] failed:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    state.ensuring = false;
  }
};

export const initializeNewsStockScheduler = async () => {
  await ensureNewsStockScheduler();
};

export const refreshNewsStockSchedule = async () => {
  stopJob();
  await ensureNewsStockScheduler();
};

void ensureNewsStockScheduler();
