import cron, { type ScheduledTask } from "node-cron";
import {
  getSchedule,
  readSchedules,
  appendScheduleHistory,
  updateSchedule,
  type ScheduleEntry,
} from "./storage";
import { executeScheduleRun } from "./runner";

type ScheduleJob = {
  type: "interval" | "cron";
  handle: NodeJS.Timeout | ScheduledTask;
};

type SchedulerState = {
  initialized: boolean;
  jobs: Map<string, ScheduleJob>;
  running: Set<string>;
};

const getState = (): SchedulerState => {
  const globalRef = globalThis as typeof globalThis & {
    __workflowScheduler?: SchedulerState;
  };
  if (!globalRef.__workflowScheduler) {
    globalRef.__workflowScheduler = {
      initialized: false,
      jobs: new Map(),
      running: new Set(),
    };
  }
  return globalRef.__workflowScheduler;
};

const stopJob = (id: string) => {
  const state = getState();
  const existing = state.jobs.get(id);
  if (!existing) return;
  if (existing.type === "interval") {
    clearInterval(existing.handle as NodeJS.Timeout);
  } else {
    (existing.handle as ScheduledTask).stop();
  }
  state.jobs.delete(id);
};

const runSchedule = async (id: string) => {
  const state = getState();
  if (state.running.has(id)) return;
  state.running.add(id);
  const startedAt = new Date().toISOString();
  await updateSchedule(id, { lastRunAt: startedAt, lastStatus: "running", lastError: "" });
  try {
    await executeScheduleRun(id);
    await updateSchedule(id, { lastStatus: "success" });
    await appendScheduleHistory(id, { ranAt: startedAt, status: "success" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스케줄 실행에 실패했습니다.";
    await updateSchedule(id, { lastStatus: "failure", lastError: message });
    await appendScheduleHistory(id, { ranAt: startedAt, status: "failure", error: message });
  } finally {
    state.running.delete(id);
  }
};

const registerJob = (entry: ScheduleEntry) => {
  stopJob(entry.id);
  if (!entry.schedule.enabled) return;
  if (entry.schedule.mode === "cron") {
    const task = cron.schedule(entry.schedule.cron, () => {
      void runSchedule(entry.id);
    });
    getState().jobs.set(entry.id, { type: "cron", handle: task });
  } else {
    const intervalMs = entry.schedule.intervalMinutes * 60 * 1000;
    const handle = setInterval(() => {
      void runSchedule(entry.id);
    }, intervalMs);
    getState().jobs.set(entry.id, { type: "interval", handle });
  }
};

export const refreshSchedule = async (entry: ScheduleEntry) => {
  registerJob(entry);
};

export const removeSchedule = (id: string) => {
  stopJob(id);
};

export const initializeScheduler = async () => {
  const state = getState();
  if (state.initialized) return;
  const schedules = await readSchedules();
  schedules.forEach((entry) => registerJob(entry));
  state.initialized = true;
};

export const triggerSchedule = async (id: string) => {
  const entry = await getSchedule(id);
  if (!entry) throw new Error("스케줄을 찾지 못했습니다.");
  await runSchedule(entry.id);
  return entry;
};
