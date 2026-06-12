// 산업부 수출입동향 PDF 월간 자동 적재 스케줄러 (앱 내 node-cron).
// map-mst/scheduler.ts 패턴을 단일 글로벌 잡으로 단순화.
import cron, { type ScheduledTask } from "node-cron";
import {
  ITEMTRADE_JOB_KEY,
  connectPlatformClient,
  previousReportMonth,
  runItemTradeLoad,
} from "./pdf-itemtrade-loader";

type ScheduleConfig = {
  enabled: boolean;
  cronExpr: string;
};

type SchedulerState = {
  initialized: boolean;
  task: ScheduledTask | null;
  running: boolean;
};

const getState = (): SchedulerState => {
  const globalRef = globalThis as typeof globalThis & {
    __pdfItemtradeScheduler?: SchedulerState;
  };
  if (!globalRef.__pdfItemtradeScheduler) {
    globalRef.__pdfItemtradeScheduler = { initialized: false, task: null, running: false };
  }
  return globalRef.__pdfItemtradeScheduler;
};

const stopJob = () => {
  const state = getState();
  if (state.task) {
    state.task.stop();
    state.task = null;
  }
};

const runScheduled = async () => {
  const state = getState();
  if (state.running) return; // 중복 실행 방지
  state.running = true;
  try {
    const { year, month } = previousReportMonth();
    await runItemTradeLoad({ year, month, triggerType: "schedule" });
  } catch {
    // 실패는 run_log 에 기록됨. 백그라운드 잡이므로 throw 하지 않는다.
  } finally {
    state.running = false;
  }
};

const registerJob = (config: ScheduleConfig) => {
  stopJob();
  if (!config.enabled) return;
  if (!config.cronExpr.trim() || !cron.validate(config.cronExpr.trim())) return;
  const state = getState();
  state.task = cron.schedule(config.cronExpr.trim(), () => {
    void runScheduled();
  });
};

export const readScheduleConfig = async (): Promise<ScheduleConfig> => {
  const client = await connectPlatformClient();
  try {
    const result = await client.query<{ schedule_enabled: boolean; schedule_cron_expr: string }>(
      `select schedule_enabled, schedule_cron_expr
       from dp.pdf_ingest_schedule
       where job_key = $1`,
      [ITEMTRADE_JOB_KEY],
    );
    const row = result.rows[0];
    return {
      enabled: Boolean(row?.schedule_enabled),
      cronExpr: row?.schedule_cron_expr?.trim() || "0 9 1 * *",
    };
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
};

export const initializePdfItemtradeScheduler = async () => {
  const state = getState();
  if (state.initialized) return;
  try {
    const config = await readScheduleConfig();
    registerJob(config);
    state.initialized = true;
  } catch {
    // ignore initialize errors
  }
};

export const refreshPdfItemtradeSchedule = async () => {
  try {
    const config = await readScheduleConfig();
    registerJob(config);
    getState().initialized = true;
  } catch {
    // ignore refresh errors
  }
};
