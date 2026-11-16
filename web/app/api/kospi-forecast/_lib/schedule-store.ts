import { promises as fs } from "node:fs";
import path from "node:path";
import { TIME_POINTS, type TimePoint } from "./execute";

export type PointSchedule = {
  timePoint: TimePoint;
  enabled: boolean;
  time: string;
  llm: boolean;
  dbSettingId: number | null;
  lastRunAt?: string;
  lastStatus?: "success" | "failure" | "running";
  lastError?: string;
};

const DEFAULT_TIME: Record<TimePoint, string> = {
  T0: "16:00",
  T1: "02:00",
  T2: "08:30",
};

const DATA_FILE = path.join(process.cwd(), "data", "kospi-forecast", "schedules.json");

const emptyPoint = (timePoint: TimePoint): PointSchedule => ({
  timePoint,
  enabled: false,
  time: DEFAULT_TIME[timePoint],
  llm: false,
  dbSettingId: null,
});

const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const normalizePoint = (timePoint: TimePoint, raw: Partial<PointSchedule> | undefined): PointSchedule => {
  const base = emptyPoint(timePoint);
  const settingId = Number(raw?.dbSettingId);
  return {
    timePoint,
    enabled: Boolean(raw?.enabled),
    time: typeof raw?.time === "string" && isTime(raw.time) ? raw.time : base.time,
    llm: Boolean(raw?.llm),
    dbSettingId: Number.isFinite(settingId) && settingId > 0 ? Math.trunc(settingId) : null,
    lastRunAt: typeof raw?.lastRunAt === "string" ? raw.lastRunAt : undefined,
    lastStatus: raw?.lastStatus === "success" || raw?.lastStatus === "failure" || raw?.lastStatus === "running"
      ? raw.lastStatus
      : undefined,
    lastError: typeof raw?.lastError === "string" ? raw.lastError : undefined,
  };
};

export const readPointSchedules = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as { points?: Partial<Record<TimePoint, Partial<PointSchedule>>> };
    return TIME_POINTS.map((timePoint) => normalizePoint(timePoint, parsed.points?.[timePoint]));
  } catch {
    return TIME_POINTS.map((timePoint) => emptyPoint(timePoint));
  }
};

export const writePointSchedule = async (timePoint: TimePoint, patch: Partial<PointSchedule>) => {
  const current = await readPointSchedules();
  const next = current.map((item) =>
    item.timePoint === timePoint ? normalizePoint(timePoint, { ...item, ...patch, timePoint }) : item,
  );
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(
    DATA_FILE,
    JSON.stringify({ points: Object.fromEntries(next.map((item) => [item.timePoint, item])) }, null, 2),
    "utf8",
  );
  return next;
};

export const cronForTime = (time: string) => {
  const [hour, minute] = time.split(":");
  return `${Number(minute)} ${Number(hour)} * * *`;
};
