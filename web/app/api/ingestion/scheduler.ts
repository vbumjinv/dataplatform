import cron, { type ScheduledTask } from "node-cron";
import { Client } from "pg";
import { executeApiGroupLoad } from "./load-runner";

type IngestionScheduleRow = {
  group_id: number;
  source_id: number;
  schedule_enabled: boolean;
  schedule_type: "interval" | "cron" | null;
  schedule_interval_minutes: number | null;
  schedule_cron_expr: string | null;
};

type JobHandle = {
  type: "interval" | "cron";
  handle: NodeJS.Timeout | ScheduledTask;
};

const CONNECT_TIMEOUT_MS = 5000;
const DB_CONFIG = {
  url: process.env.DP_DB_URL,
  database: process.env.DP_DB_NAME,
  user: process.env.DP_DB_USER,
  password: process.env.DP_DB_PASSWORD,
};

const state = {
  initialized: false,
  jobs: new Map<number, JobHandle>(),
};
const SCHEDULE_LOCK_NS = 8101;

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const normalizeJdbcUrl = (raw: string) =>
  raw.startsWith("jdbc:") ? raw.replace(/^jdbc:/, "") : raw;
const buildConnectionString = (payload: {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
}) => {
  if (!payload.url) return null;
  const normalized = normalizeJdbcUrl(payload.url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return null;
  }
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};

const getClient = () => {
  if (
    !isNonEmpty(DB_CONFIG.url) ||
    !isNonEmpty(DB_CONFIG.database) ||
    !isNonEmpty(DB_CONFIG.user) ||
    !isNonEmpty(DB_CONFIG.password)
  ) {
    return null;
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) return null;
  return new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
};

const stopJob = (groupId: number) => {
  const existing = state.jobs.get(groupId);
  if (!existing) return;
  if (existing.type === "interval") {
    clearInterval(existing.handle as NodeJS.Timeout);
  } else {
    (existing.handle as ScheduledTask).stop();
  }
  state.jobs.delete(groupId);
};

const executeSchedule = async (row: IngestionScheduleRow) => {
  const lockClient = getClient();
  let lockTimeoutId: NodeJS.Timeout | null = null;
  let locked = false;
  try {
    if (lockClient) {
      await Promise.race([
        lockClient.connect(),
        new Promise((_, reject) => {
          lockTimeoutId = setTimeout(() => {
            reject(new Error("스케줄 잠금용 DB 연결 시간이 초과되었습니다."));
          }, CONNECT_TIMEOUT_MS);
        }),
      ]);
      const lockResult = await lockClient.query<{ locked: boolean }>(
        `select pg_try_advisory_lock($1, $2) as locked`,
        [SCHEDULE_LOCK_NS, row.group_id],
      );
      locked = Boolean(lockResult.rows[0]?.locked);
      if (!locked) {
        console.warn(
          `[ingestion-scheduler] group=${row.group_id} skipped: lock already held`,
        );
        return;
      }
    }

    await executeApiGroupLoad({
      sourceId: row.source_id,
      groupId: row.group_id,
      truncate: undefined,
      triggerType: "schedule",
    });
  } catch (error) {
    // ignore execution errors in background scheduler
    console.error(
      `[ingestion-scheduler] group=${row.group_id} failed:`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (lockClient) {
      try {
        if (locked) {
          await lockClient.query(`select pg_advisory_unlock($1, $2)`, [
            SCHEDULE_LOCK_NS,
            row.group_id,
          ]);
        }
      } catch {
        // ignore unlock errors
      }
      if (lockTimeoutId) clearTimeout(lockTimeoutId);
      try {
        await lockClient.end();
      } catch {
        // ignore cleanup errors
      }
    }
  }
};

const registerJob = (row: IngestionScheduleRow) => {
  stopJob(row.group_id);
  if (!row.schedule_enabled) return;
  if (row.schedule_type === "cron" && row.schedule_cron_expr?.trim()) {
    const task = cron.schedule(row.schedule_cron_expr.trim(), () => {
      void executeSchedule(row);
    });
    state.jobs.set(row.group_id, { type: "cron", handle: task });
    return;
  }
  const minutes = Number.isFinite(row.schedule_interval_minutes)
    ? Math.max(1, Number(row.schedule_interval_minutes))
    : 60;
  const intervalMs = minutes * 60 * 1000;
  const handle = setInterval(() => {
    void executeSchedule(row);
  }, intervalMs);
  state.jobs.set(row.group_id, { type: "interval", handle });
};

const readRow = async (groupId: number) => {
  const client = getClient();
  if (!client) return null;
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    const result = await client.query<IngestionScheduleRow>(
      `
        select
          g.id as group_id,
          g.source_id,
          g.schedule_enabled,
          g.schedule_type,
          g.schedule_interval_minutes,
          g.schedule_cron_expr
        from dp.api_param_group g
        where g.id = $1
          and g.is_template = false
      `,
      [groupId],
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};

export const initializeIngestionScheduler = async () => {
  if (state.initialized) return;
  const client = getClient();
  if (!client) return;
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    const result = await client.query<IngestionScheduleRow>(
      `
        select
          g.id as group_id,
          g.source_id,
          g.schedule_enabled,
          g.schedule_type,
          g.schedule_interval_minutes,
          g.schedule_cron_expr
        from dp.api_param_group g
        where g.is_template = false
          and g.schedule_enabled = true
      `,
    );
    result.rows.forEach((row) => registerJob(row));
    state.initialized = true;
  } catch {
    // ignore initialize errors
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};

export const refreshIngestionSchedule = async (groupId: number) => {
  const row = await readRow(groupId);
  if (!row) {
    stopJob(groupId);
    return;
  }
  registerJob(row);
};

export const removeIngestionSchedule = (groupId: number) => {
  stopJob(groupId);
};
