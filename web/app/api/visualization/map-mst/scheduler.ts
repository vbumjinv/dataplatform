import cron, { type ScheduledTask } from "node-cron";
import {
  canUseDb,
  connectWithTimeout,
  createDbClient,
} from "../_lib/db";
import { buildMapDataForMapping, fetchMappings } from "../_lib/mapping-query";
import { markMapRunLogError, markMapRunLogSuccess, startMapRunLog } from "../_lib/map-run-log";

type MapScheduleRow = {
  map_id: number;
  schedule_enabled: boolean;
  schedule_type: "interval" | "cron" | null;
  schedule_interval_minutes: number | null;
  schedule_cron_expr: string | null;
};

type JobHandle = {
  type: "interval" | "cron";
  handle: NodeJS.Timeout | ScheduledTask;
};

const state = {
  initialized: false,
  jobs: new Map<number, JobHandle>(),
};
const SCHEDULE_LOCK_NS = 8102;

const stopJob = (mapId: number) => {
  const existing = state.jobs.get(mapId);
  if (!existing) return;
  if (existing.type === "interval") {
    clearInterval(existing.handle as NodeJS.Timeout);
  } else {
    (existing.handle as ScheduledTask).stop();
  }
  state.jobs.delete(mapId);
};

const executeSchedule = async (row: MapScheduleRow) => {
  if (!canUseDb()) return;
  const client = createDbClient();
  if (!client) return;
  let locked = false;
  let runLogId: number | null = null;
  try {
    await connectWithTimeout(client);
    const lockResult = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock($1, $2) as locked`,
      [SCHEDULE_LOCK_NS, row.map_id],
    );
    locked = Boolean(lockResult.rows[0]?.locked);
    if (!locked) return;

    const mappings = await fetchMappings(client, [row.map_id], true);
    const mapping = mappings[0];
    if (!mapping) return;
    runLogId = await startMapRunLog(client, {
      mapId: row.map_id,
      seriesName: mapping.seriesName,
      triggerType: "schedule",
      runMode: "generate",
    });
    const result = await buildMapDataForMapping(client, mapping, { replaceExisting: false });
    await markMapRunLogSuccess(client, runLogId, {
      affectedCount: result.affectedCount,
      startDate: result.startDate,
      endDate: result.endDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "스케줄 실행에 실패했습니다.";
    await markMapRunLogError(client, runLogId, message);
    // ignore execution errors in background scheduler
  } finally {
    try {
      if (locked) {
        await client.query(`select pg_advisory_unlock($1, $2)`, [SCHEDULE_LOCK_NS, row.map_id]);
      }
    } catch {
      // ignore unlock errors
    }
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};

const registerJob = (row: MapScheduleRow) => {
  stopJob(row.map_id);
  if (!row.schedule_enabled) return;
  if (row.schedule_type === "cron" && row.schedule_cron_expr?.trim()) {
    const task = cron.schedule(row.schedule_cron_expr.trim(), () => {
      void executeSchedule(row);
    });
    state.jobs.set(row.map_id, { type: "cron", handle: task });
    return;
  }
  const minutes = Number.isFinite(row.schedule_interval_minutes)
    ? Math.max(1, Number(row.schedule_interval_minutes))
    : 60;
  const handle = setInterval(() => {
    void executeSchedule(row);
  }, minutes * 60 * 1000);
  state.jobs.set(row.map_id, { type: "interval", handle });
};

const readRow = async (mapId: number) => {
  if (!canUseDb()) return null;
  const client = createDbClient();
  if (!client) return null;
  try {
    await connectWithTimeout(client);
    const result = await client.query<MapScheduleRow>(
      `
        select
          m.map_id,
          m.schedule_enabled,
          m.schedule_type,
          m.schedule_interval_minutes,
          m.schedule_cron_expr
        from dp.viz_map_mst m
        where m.map_id = $1
      `,
      [mapId],
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};

export const initializeMapScheduler = async () => {
  if (state.initialized) return;
  if (!canUseDb()) return;
  const client = createDbClient();
  if (!client) return;
  try {
    await connectWithTimeout(client);
    const result = await client.query<MapScheduleRow>(
      `
        select
          m.map_id,
          m.schedule_enabled,
          m.schedule_type,
          m.schedule_interval_minutes,
          m.schedule_cron_expr
        from dp.viz_map_mst m
        where m.is_active = true
          and m.schedule_enabled = true
      `,
    );
    result.rows.forEach((row) => registerJob(row));
    state.initialized = true;
  } catch {
    // ignore initialize errors
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};

export const refreshMapSchedule = async (mapId: number) => {
  const row = await readRow(mapId);
  if (!row) {
    stopJob(mapId);
    return;
  }
  registerJob(row);
};

export const removeMapSchedule = (mapId: number) => {
  stopJob(mapId);
};
