// 파이프라인 스케줄러 (앱 내 node-cron). map-mst/scheduler.ts 멀티엔티티 패턴 미러.
import cron, { type ScheduledTask } from "node-cron";
import { canUseDb, connectWithTimeout, createPipelineClient } from "./db";
import { runPipeline } from "./pipeline-runner";

type PipelineScheduleRow = {
  pipeline_id: number;
  db_setting_id: number | null;
  schedule_enabled: boolean;
  schedule_type: "interval" | "cron" | null;
  schedule_interval_minutes: number | null;
  schedule_cron_expr: string | null;
};

type JobHandle = {
  type: "interval" | "cron";
  handle: NodeJS.Timeout | ScheduledTask;
};

type PipelineSchedulerState = {
  initialized: boolean;
  jobs: Map<number, JobHandle>;
};

// 라우트별 모듈 분리(Turbopack)에도 cron 등록 목록/initialized 플래그가 인스턴스마다
// 따로 생겨 같은 파이프라인 cron 이 중복 등록되지 않도록 globalThis 싱글톤으로 공유한다.
// (스케줄 큐와 동일 패턴 — 기존엔 state 가 모듈 지역 변수라 중복 발화 문제가 있었음)
const getState = (): PipelineSchedulerState => {
  const g = globalThis as typeof globalThis & {
    __pipelineScheduler?: PipelineSchedulerState;
  };
  if (!g.__pipelineScheduler) {
    g.__pipelineScheduler = { initialized: false, jobs: new Map() };
  }
  return g.__pipelineScheduler;
};

const stopJob = (pipelineId: number) => {
  const state = getState();
  const existing = state.jobs.get(pipelineId);
  if (!existing) return;
  if (existing.type === "interval") {
    clearInterval(existing.handle as NodeJS.Timeout);
  } else {
    (existing.handle as ScheduledTask).stop();
  }
  state.jobs.delete(pipelineId);
};

const executeSchedule = async (row: PipelineScheduleRow) => {
  try {
    await runPipeline(row.pipeline_id, "schedule", {
      dbSettingId: row.db_setting_id,
    });
  } catch {
    // 실패는 run_log 에 기록됨. 백그라운드 잡이므로 throw 하지 않는다.
  }
};

// 모든 스케줄 실행을 단일 직렬 큐(FIFO)로 처리한다.
// → 같은 시각에 발화한 스케줄들은 순서대로 1개씩 실행되고,
//   앞 스케줄이 끝나기 전에 발화한 다음 스케줄은 끝날 때까지 대기 후 실행된다.
// (Turbopack 에서 라우트별 모듈 분리에 대비해 globalThis 싱글톤 사용 — cancel-registry 와 동일 패턴)
type ScheduleQueue = { tail: Promise<void> };
const getScheduleQueue = (): ScheduleQueue => {
  const g = globalThis as typeof globalThis & { __pipelineScheduleQueue?: ScheduleQueue };
  if (!g.__pipelineScheduleQueue) g.__pipelineScheduleQueue = { tail: Promise.resolve() };
  return g.__pipelineScheduleQueue;
};

const enqueueSchedule = (row: PipelineScheduleRow) => {
  const queue = getScheduleQueue();
  // executeSchedule 은 내부에서 오류를 삼키므로 체인이 끊기지 않는다.
  queue.tail = queue.tail.then(() => executeSchedule(row));
};

const registerJob = (row: PipelineScheduleRow) => {
  const state = getState();
  stopJob(row.pipeline_id);
  if (!row.schedule_enabled) return;
  if (row.schedule_type === "cron" && row.schedule_cron_expr?.trim()) {
    if (!cron.validate(row.schedule_cron_expr.trim())) return;
    const task = cron.schedule(row.schedule_cron_expr.trim(), () => {
      enqueueSchedule(row);
    });
    state.jobs.set(row.pipeline_id, { type: "cron", handle: task });
    return;
  }
  const minutes = Number.isFinite(row.schedule_interval_minutes)
    ? Math.max(1, Number(row.schedule_interval_minutes))
    : 60;
  const handle = setInterval(() => {
    enqueueSchedule(row);
  }, minutes * 60 * 1000);
  state.jobs.set(row.pipeline_id, { type: "interval", handle });
};

const readRow = async (pipelineId: number): Promise<PipelineScheduleRow | null> => {
  if (!canUseDb()) return null;
  const client = createPipelineClient();
  if (!client) return null;
  try {
    await connectWithTimeout(client);
    const result = await client.query<PipelineScheduleRow>(
      `select pipeline_id, db_setting_id, schedule_enabled, schedule_type, schedule_interval_minutes, schedule_cron_expr
       from dp.api_pipeline where pipeline_id = $1`,
      [pipelineId],
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
};

export const initializePipelineScheduler = async () => {
  const state = getState();
  if (state.initialized) return;
  if (!canUseDb()) return;
  const client = createPipelineClient();
  if (!client) return;
  try {
    await connectWithTimeout(client);
    const result = await client.query<PipelineScheduleRow>(
      `select pipeline_id, db_setting_id, schedule_enabled, schedule_type, schedule_interval_minutes, schedule_cron_expr
       from dp.api_pipeline
       where is_active = true and schedule_enabled = true`,
    );
    result.rows.forEach((row) => registerJob(row));
    state.initialized = true;
  } catch {
    // ignore initialize errors
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
};

export const refreshPipelineSchedule = async (pipelineId: number) => {
  const row = await readRow(pipelineId);
  if (!row) {
    stopJob(pipelineId);
    return;
  }
  registerJob(row);
};

export const removePipelineSchedule = (pipelineId: number) => {
  stopJob(pipelineId);
};
