import { promises as fs } from "fs";
import path from "path";
import type { WorkflowState } from "@/app/workflow/types";

export type ScheduleConfig = {
  enabled: boolean;
  mode: "interval" | "cron";
  intervalMinutes: number;
  cron: string;
};

export type ScheduleEntry = {
  id: string;
  name: string;
  workflow: WorkflowState;
  schedule: ScheduleConfig;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: "success" | "failure" | "running";
  lastError?: string;
  history?: Array<{
    ranAt: string;
    status: "success" | "failure";
    error?: string;
  }>;
};

type SchedulePatch = Partial<
  Pick<
    ScheduleEntry,
    "lastRunAt" | "lastStatus" | "lastError" | "workflow" | "schedule" | "name"
  >
>;

const DATA_DIR = path.join(process.cwd(), "data", "schedules");
const LEGACY_DIR = path.join(process.cwd(), "app", "api", "schedules", "data");
const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");
const LEGACY_FILE = path.join(LEGACY_DIR, "schedules.json");

const ensureDataDir = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

const readJsonFile = async () => {
  try {
    const raw = await fs.readFile(SCHEDULES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as ScheduleEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      const raw = await fs.readFile(LEGACY_FILE, "utf-8");
      const parsed = JSON.parse(raw) as ScheduleEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
};

const writeJsonFile = async (data: ScheduleEntry[]) => {
  await ensureDataDir();
  await fs.writeFile(SCHEDULES_FILE, JSON.stringify(data, null, 2), "utf-8");
};

export const normalizeScheduleConfig = (schedule: ScheduleConfig): ScheduleConfig => ({
  enabled: Boolean(schedule.enabled),
  mode: schedule.mode === "cron" ? "cron" : "interval",
  intervalMinutes: Math.max(1, Math.floor(schedule.intervalMinutes || 1)),
  cron: schedule.cron?.trim() || "0 * * * *",
});

export const readSchedules = async () => readJsonFile();

export const getSchedule = async (id: string) => {
  const list = await readJsonFile();
  return list.find((entry) => entry.id === id) ?? null;
};

export const upsertSchedule = async (entry: ScheduleEntry) => {
  const list = await readJsonFile();
  const index = list.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    list[index] = entry;
  } else {
    list.unshift(entry);
  }
  await writeJsonFile(list);
  return entry;
};

export const deleteSchedule = async (id: string) => {
  const list = await readJsonFile();
  const next = list.filter((item) => item.id !== id);
  await writeJsonFile(next);
  return next.length !== list.length;
};

export const updateSchedule = async (id: string, patch: SchedulePatch) => {
  const list = await readJsonFile();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const next = {
    ...list[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  list[index] = next;
  await writeJsonFile(list);
  return next;
};

export const appendScheduleHistory = async (
  id: string,
  entry: { ranAt: string; status: "success" | "failure"; error?: string },
) => {
  const list = await readJsonFile();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const history = list[index].history ?? [];
  const nextHistory = [entry, ...history].slice(0, 50);
  const next = {
    ...list[index],
    history: nextHistory,
    updatedAt: new Date().toISOString(),
  };
  list[index] = next;
  await writeJsonFile(list);
  return next;
};
