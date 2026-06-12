import type { Client } from "pg";

type MapRunTriggerType = "manual" | "schedule";
type MapRunMode = "generate" | "regenerate";
type MapRunStatus = "running" | "success" | "error";

const hasMapRunLogTable = async (client: Client) => {
  try {
    const result = await client.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from information_schema.tables t
          where t.table_schema = 'dp'
            and t.table_name = 'viz_map_run_log'
        ) as exists
      `,
    );
    return Boolean(result.rows[0]?.exists);
  } catch {
    return false;
  }
};

const updateMapRunLog = async (
  client: Client,
  runLogId: number,
  payload: {
    status: MapRunStatus;
    affectedCount?: number;
    startDate?: string | null;
    endDate?: string | null;
    errorMessage?: string | null;
  },
) => {
  if (!(await hasMapRunLogTable(client))) return;
  await client.query(
    `
      update dp.viz_map_run_log
      set
        status = $2,
        affected_count = $3,
        start_date = $4::date,
        end_date = $5::date,
        error_message = $6,
        ended_at = now()
      where run_log_id = $1
    `,
    [
      runLogId,
      payload.status,
      Math.max(0, Number(payload.affectedCount ?? 0)),
      payload.startDate ?? null,
      payload.endDate ?? null,
      payload.errorMessage ?? null,
    ],
  );
};

export const startMapRunLog = async (
  client: Client,
  payload: {
    mapId: number;
    seriesName?: string | null;
    triggerType: MapRunTriggerType;
    runMode: MapRunMode;
  },
) => {
  if (!(await hasMapRunLogTable(client))) return null;
  try {
    const result = await client.query<{ run_log_id: number }>(
      `
        insert into dp.viz_map_run_log (
          map_id,
          series_name,
          trigger_type,
          run_mode,
          status,
          started_at
        )
        values ($1, $2, $3, $4, 'running', now())
        returning run_log_id
      `,
      [payload.mapId, payload.seriesName?.trim() || null, payload.triggerType, payload.runMode],
    );
    return Number(result.rows[0]?.run_log_id ?? 0) || null;
  } catch {
    return null;
  }
};

export const markMapRunLogSuccess = async (
  client: Client,
  runLogId: number | null,
  payload: {
    affectedCount: number;
    startDate: string | null;
    endDate: string | null;
  },
) => {
  if (!runLogId) return;
  try {
    await updateMapRunLog(client, runLogId, {
      status: "success",
      affectedCount: payload.affectedCount,
      startDate: payload.startDate,
      endDate: payload.endDate,
      errorMessage: null,
    });
  } catch {
    // ignore non-critical logging errors
  }
};

export const markMapRunLogError = async (
  client: Client,
  runLogId: number | null,
  errorMessage: string | null,
) => {
  if (!runLogId) return;
  try {
    await updateMapRunLog(client, runLogId, {
      status: "error",
      errorMessage,
    });
  } catch {
    // ignore non-critical logging errors
  }
};

export const canUseMapRunLog = async (client: Client) => hasMapRunLogTable(client);
