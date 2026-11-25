import cron, { type ScheduledTask } from "node-cron";
import { Client } from "pg";
import { appendForecastLog } from "../../kospi-forecast/_lib/run-log";
import { cronForWeekdayTime, readEveningSchedule, writeEveningSchedule, type EveningSchedule } from "./evening-schedule";
import { executeKospiEvening5, executeKospiForecast5, type TimePoint } from "./execute";
import { cronForTime, readPointSchedules, writePointSchedule, type PointSchedule } from "./schedule-store";

const LOCK_NS = 8104;
const LOCK_KEY: Record<TimePoint, number> = { W0: 0, W2: 1 };

type Job = { timePoint: TimePoint; task: ScheduledTask };

type State = {
  initialized: boolean;
  jobs: Job[];
  evening: ScheduledTask | null;
  running: Set<TimePoint>;
  eveningRunning: boolean;
};

const globalState = globalThis as typeof globalThis & { __kospiForecast5Scheduler?: State };
const state = globalState.__kospiForecast5Scheduler ?? (globalState.__kospiForecast5Scheduler = {
  initialized: false,
  jobs: [],
  evening: null,
  running: new Set(),
  eveningRunning: false,
});

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
  return new Client({ connectionString: parsed.toString(), connectionTimeoutMillis: 5000 });
};

const stopJobs = () => {
  state.jobs.forEach((job) => job.task.stop());
  state.jobs = [];
};

const runPoint = async (point: PointSchedule) => {
  if (state.running.has(point.timePoint)) return;
  if (!point.enabled || !point.dbSettingId) return;
  state.running.add(point.timePoint);
  const startedAt = new Date().toISOString();
  await writePointSchedule(point.timePoint, { lastRunAt: startedAt, lastStatus: "running", lastError: "" });
  const lockClient = envClient();
  let locked = false;
  try {
    if (lockClient) {
      await lockClient.connect();
      const lock = await lockClient.query<{ locked: boolean }>(
        `select pg_try_advisory_lock($1, $2) as locked`,
        [LOCK_NS, LOCK_KEY[point.timePoint]],
      );
      locked = Boolean(lock.rows[0]?.locked);
      if (!locked) {
        const message = "다른 실행이 진행 중이라 이번 시각은 건너뛰었습니다.";
        await writePointSchedule(point.timePoint, { lastStatus: "failure", lastError: message });
        await appendForecastLog({
          timePoint: point.timePoint,
          trigger: "schedule",
          target: "",
          llm: point.llm,
          status: "failure",
          startedAt,
          output: message,
          dbSettingId: point.dbSettingId,
        });
        return;
      }
    }
    const result = await executeKospiForecast5({
      timePoint: point.timePoint,
      dbSettingId: point.dbSettingId,
      llm: point.llm,
      autoDate: true,
    });
    await writePointSchedule(point.timePoint, { lastStatus: "success", lastError: "" });
    await appendForecastLog({
      timePoint: point.timePoint,
      trigger: "schedule",
      target: result.target,
      llm: point.llm,
      status: "success",
      startedAt,
      output: result.output,
      dbSettingId: point.dbSettingId,
    });
    console.log(`[kospi-forecast5] ${point.timePoint} 스케줄 실행 완료`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "스케줄 실행에 실패했습니다.";
    await writePointSchedule(point.timePoint, { lastStatus: "failure", lastError: message.slice(-500) });
    await appendForecastLog({
      timePoint: point.timePoint,
      trigger: "schedule",
      target: "",
      llm: point.llm,
      status: "failure",
      startedAt,
      output: message.slice(-12000),
      dbSettingId: point.dbSettingId,
    });
    console.error(`[kospi-forecast5] ${point.timePoint} 스케줄 실패:`, message.slice(-500));
  } finally {
    state.running.delete(point.timePoint);
    if (lockClient) {
      try {
        if (locked) await lockClient.query(`select pg_advisory_unlock($1, $2)`, [LOCK_NS, LOCK_KEY[point.timePoint]]);
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

export const runEvening5 = async (schedule: EveningSchedule, trigger: "manual" | "schedule") => {
  if (state.eveningRunning) return { ok: false as const, error: "저녁 작업이 이미 실행 중입니다." };
  if (!schedule.dbSettingId) return { ok: false as const, error: "DB 연결을 선택하세요." };
  state.eveningRunning = true;
  const startedAt = new Date().toISOString();
  await writeEveningSchedule({ ...schedule, lastRunAt: startedAt, lastStatus: "running", lastError: "" });
  try {
    const result = await executeKospiEvening5(schedule.dbSettingId);
    await writeEveningSchedule({ lastStatus: "success", lastError: "" });
    console.log(`[kospi-forecast5] 저녁 작업(${trigger}) 완료`);
    return { ok: true as const, output: result.output };
  } catch (error) {
    const message = error instanceof Error ? error.message : "저녁 작업에 실패했습니다.";
    await writeEveningSchedule({ lastStatus: "failure", lastError: message.slice(-500) });
    console.error(`[kospi-forecast5] 저녁 작업 실패:`, message.slice(-500));
    return { ok: false as const, error: message.slice(-4000) };
  } finally {
    state.eveningRunning = false;
  }
};

const registerEvening = (schedule: EveningSchedule) => {
  state.evening?.stop();
  state.evening = null;
  if (!schedule.enabled || !schedule.dbSettingId) return;
  const expression = cronForWeekdayTime(schedule.time);
  if (!cron.validate(expression)) return;
  state.evening = cron.schedule(expression, () => {
    void (async () => {
      const latest = await readEveningSchedule();
      if (latest.enabled && latest.dbSettingId) await runEvening5(latest, "schedule");
    })();
  }, { timezone: "Asia/Seoul", name: "kospi-forecast5-evening", noOverlap: true });
};

const registerJobs = (points: PointSchedule[]) => {
  stopJobs();
  points.forEach((point) => {
    if (!point.enabled || !point.dbSettingId) return;
    const expression = cronForTime(point.time);
    if (!cron.validate(expression)) return;
    const task = cron.schedule(expression, () => {
      void (async () => {
        const latest = (await readPointSchedules()).find((item) => item.timePoint === point.timePoint);
        if (latest) await runPoint(latest);
      })();
    }, { timezone: "Asia/Seoul", name: `kospi-forecast5-${point.timePoint}`, noOverlap: true });
    state.jobs.push({ timePoint: point.timePoint, task });
  });
};

export const refreshKospiForecast5Scheduler = async () => {
  const [points, evening] = await Promise.all([readPointSchedules(), readEveningSchedule()]);
  registerJobs(points);
  registerEvening(evening);
  state.initialized = true;
};

export const initializeKospiForecast5Scheduler = async () => {
  await refreshKospiForecast5Scheduler();
};
