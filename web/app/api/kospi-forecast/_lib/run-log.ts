import { promises as fs } from "node:fs";
import path from "node:path";
import type { TimePoint } from "./execute";

export type ForecastRunLog = {
  id: string;
  timePoint: TimePoint;
  trigger: "manual" | "schedule";
  target: string;
  llm: boolean;
  status: "success" | "failure";
  startedAt: string;
  finishedAt: string;
  output: string;
};

const DATA_FILE = path.join(process.cwd(), "data", "kospi-forecast", "runs.json");
const MAX_LOGS = 40;

export const appendForecastLog = async (entry: Omit<ForecastRunLog, "id" | "finishedAt"> & { finishedAt?: string }) => {
  const row: ForecastRunLog = {
    ...entry,
    id: `${Date.now()}-${entry.timePoint}-${entry.trigger}`,
    finishedAt: entry.finishedAt ?? new Date().toISOString(),
    output: entry.output.slice(-12000),
    target: entry.target || "",
  };
  let current: ForecastRunLog[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as ForecastRunLog[];
    if (Array.isArray(parsed)) current = parsed;
  } catch {
    current = [];
  }
  const next = [row, ...current].slice(0, MAX_LOGS);
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(next, null, 2), "utf8");
  return row;
};

export const readForecastLogs = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as ForecastRunLog[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
