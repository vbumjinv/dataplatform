import cron, { type ScheduledTask } from "node-cron";
import { Client } from "pg";
import { resolveNewsDateToken } from "./news-date-token";
import { readDartSource, type DartSourceSetting } from "./dart-source";
import { startDartDisclosureJob } from "./dart-disclosure";

const CRON_TIMEZONE = "Asia/Seoul";
const CRON_MAX_RANDOM_DELAY_MS = 5 * 60 * 1000;
const SCHEDULE_LOCK_NS = 8103;
const SCHEDULE_LOCK_KEY = 1;
const CONNECT_TIMEOUT_MS = 5000;

type JobHandle = {
  type: "interval" | "cron";
  handle: NodeJS.Timeout | ScheduledTask;
};

type SchedulerState = {
  initialized: boolean;
  job: JobHandle | null;
};

const globalForScheduler = globalThis as typeof globalThis & {
  __dartSchedulerState?: SchedulerState;
};

const state =
  globalForScheduler.__dartSchedulerState ??
  (globalForScheduler.__dartSchedulerState = {
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
      if (!locked) return;
    }
    const setting = await readDartSource(null);
    if (!setting.scheduleEnabled) return;
    const startDate = resolveNewsDateToken(setting.startExpr);
    const endDate = resolveNewsDateToken(setting.endExpr);
    if (!startDate || !endDate) return;
    startDartDisclosureJob(startDate, endDate, setting.dbSettingId);
  } catch (error) {
    console.error("[dart-scheduler] failed:", error instanceof Error ? error.message : String(error));
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

const registerJob = (setting: DartSourceSetting) => {
  stopJob();
  if (!setting.scheduleEnabled) return;
  if (setting.scheduleType === "cron" && setting.scheduleCronExpr.trim()) {
    if (!cron.validate(setting.scheduleCronExpr.trim())) return;
    const task = cron.schedule(
      setting.scheduleCronExpr.trim(),
      () => {
        void executeSchedule();
      },
      {
        name: "dart-disclosure",
        timezone: CRON_TIMEZONE,
        noOverlap: true,
        maxRandomDelay: CRON_MAX_RANDOM_DELAY_MS,
      },
    );
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

export const initializeDartScheduler = async () => {
  if (state.initialized) return;
  try {
    const setting = await readDartSource(null);
    registerJob(setting);
    state.initialized = true;
  } catch {
    // 다음 요청에서 다시 등록한다.
  }
};

export const refreshDartSchedule = async () => {
  if (!state.initialized) {
    await initializeDartScheduler();
    return;
  }
  const setting = await readDartSource(null);
  registerJob(setting);
};
