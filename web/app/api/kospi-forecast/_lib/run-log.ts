import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { CONNECT_TIMEOUT_MS, buildConnectionString, resolveDbConfig } from "../../db/_lib/connection";
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

const schemaName = () => {
  const raw = (process.env.DP_DB_SCHEMA || "dp").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) throw new Error("DP_DB_SCHEMA 값이 올바르지 않습니다.");
  return raw;
};

const targetDate = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

const withDb = async <T>(dbSettingId: number, run: (client: Client, schema: string) => Promise<T>) => {
  const db = await resolveDbConfig({ settingId: dbSettingId });
  if (!db) throw new Error("선택한 DB 연결 설정을 찾을 수 없습니다.");
  const connectionString = buildConnectionString(db);
  if (!connectionString) throw new Error("DB 연결 정보를 만들지 못했습니다.");
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    return await run(client, schemaName());
  } finally {
    await client.end();
  }
};

type DbLogRow = {
  id: string;
  time_point: TimePoint;
  trigger_type: "manual" | "schedule";
  target_dd: string | null;
  llm: boolean;
  status: "success" | "failure";
  started_at: Date;
  finished_at: Date;
  output: string;
};

export const readForecastLogsFromDb = async (dbSettingId: number) => {
  return withDb(dbSettingId, async (client, schema) => {
    const result = await client.query<DbLogRow>(
      `SELECT id::text, time_point, trigger_type, target_dd::text, llm, status, started_at, finished_at, output
       FROM ${schema}.kospi_forecast_run_log
       ORDER BY started_at DESC, id DESC
       LIMIT $1`,
      [MAX_LOGS],
    );
    return result.rows.map((row) => ({
      id: row.id,
      timePoint: row.time_point,
      trigger: row.trigger_type,
      target: row.target_dd ?? "",
      llm: row.llm,
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: new Date(row.finished_at).toISOString(),
      output: row.output,
    }));
  });
};

const writeFileLog = async (row: ForecastRunLog) => {
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
};

const insertDbLog = async (dbSettingId: number, row: ForecastRunLog) => {
  await withDb(dbSettingId, (client, schema) =>
    client.query(
      `INSERT INTO ${schema}.kospi_forecast_run_log
        (time_point, trigger_type, target_dd, llm, status, started_at, finished_at, output)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.timePoint,
        row.trigger,
        targetDate(row.target),
        row.llm,
        row.status,
        row.startedAt,
        row.finishedAt,
        row.output,
      ],
    ),
  );
};

export const appendForecastLog = async (
  entry: Omit<ForecastRunLog, "id" | "finishedAt"> & { finishedAt?: string; dbSettingId?: number | null },
) => {
  const { dbSettingId, finishedAt, ...rest } = entry;
  const row: ForecastRunLog = {
    ...rest,
    id: `${Date.now()}-${entry.timePoint}-${entry.trigger}`,
    finishedAt: finishedAt ?? new Date().toISOString(),
    output: entry.output.slice(-12000),
    target: entry.target || "",
  };
  await writeFileLog(row);
  if (dbSettingId && dbSettingId > 0) {
    try {
      await insertDbLog(dbSettingId, row);
    } catch (error) {
      const message = error instanceof Error ? error.message : "수행 로그 DB 저장에 실패했습니다.";
      console.error("[kospi-forecast] 수행 로그 DB 저장 실패:", message);
      return { ...row, dbError: message };
    }
  }
  return { ...row, dbError: null as string | null };
};

export const readForecastLogs = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as ForecastRunLog[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
