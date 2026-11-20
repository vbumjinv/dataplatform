import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export type EveningSchedule = {
  enabled: boolean;
  time: string;
  dbSettingId: number | null;
  lastRunAt?: string;
  lastStatus?: "success" | "failure" | "running";
  lastError?: string;
};

const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const webDir = () => {
  if (path.basename(process.cwd()) === "web") return process.cwd();
  return path.join(process.cwd(), "web");
};

const DATA_FILE = path.join(webDir(), "data", "kospi-forecast", "evening.json");

const defaultTime = () => {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(webDir(), "scripts", "kospi-forecast", "time_points.json"), "utf8"),
    ) as { evening_run?: string };
    return typeof raw.evening_run === "string" && isTime(raw.evening_run) ? raw.evening_run : "19:00";
  } catch {
    return "19:00";
  }
};

const emptySchedule = (): EveningSchedule => ({
  enabled: false,
  time: defaultTime(),
  dbSettingId: null,
});

const normalize = (raw: Partial<EveningSchedule> | undefined): EveningSchedule => {
  const base = emptySchedule();
  const settingId = Number(raw?.dbSettingId);
  return {
    enabled: Boolean(raw?.enabled),
    time: typeof raw?.time === "string" && isTime(raw.time) ? raw.time : base.time,
    dbSettingId: Number.isFinite(settingId) && settingId > 0 ? Math.trunc(settingId) : null,
    lastRunAt: typeof raw?.lastRunAt === "string" ? raw.lastRunAt : undefined,
    lastStatus: raw?.lastStatus === "success" || raw?.lastStatus === "failure" || raw?.lastStatus === "running"
      ? raw.lastStatus
      : undefined,
    lastError: typeof raw?.lastError === "string" ? raw.lastError : undefined,
  };
};

export const readEveningSchedule = async () => {
  try {
    return normalize(JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as Partial<EveningSchedule>);
  } catch {
    return emptySchedule();
  }
};

export const writeEveningSchedule = async (patch: Partial<EveningSchedule>) => {
  const next = normalize({ ...(await readEveningSchedule()), ...patch });
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
};

export const cronForWeekdayTime = (time: string) => {
  const [hour, minute] = time.split(":");
  return `${Number(minute)} ${Number(hour)} * * 1-5`;
};
