import { connectNewsClient } from "./news-collect";

export type DartScheduleType = "interval" | "cron";

export type DartSourceSetting = {
  sourceKey: string;
  startExpr: string;
  endExpr: string;
  scheduleEnabled: boolean;
  scheduleType: DartScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleCronExpr: string;
  dbSettingId: number | null;
  apiKey: string;
};

const SOURCE_KEY = "disclosure";

const defaultSetting = (): DartSourceSetting => ({
  sourceKey: SOURCE_KEY,
  startExpr: "__TODAY__",
  endExpr: "__TODAY__",
  scheduleEnabled: false,
  scheduleType: "cron",
  scheduleIntervalMinutes: 60,
  scheduleCronExpr: "",
  dbSettingId: null,
  apiKey: "",
});

let schemaReady = false;
let apiKeyReady = false;

export const ensureDartSchema = async (settingId?: number | null) => {
  if (schemaReady && apiKeyReady) return;
  const client = await connectNewsClient(settingId);
  try {
    if (schemaReady) {
      await client.query(`alter table dp.dart_source add column if not exists api_key text not null default ''`);
      apiKeyReady = true;
      return;
    }
    await client.query(`
      create table if not exists dp.dart_source (
        source_key text primary key,
        start_expr text not null,
        end_expr text not null,
        schedule_enabled boolean not null default false,
        schedule_type text not null default 'cron',
        schedule_interval_minutes integer,
        schedule_cron_expr text not null default '',
        db_setting_id integer,
        updated_at timestamptz not null default now(),
        constraint dart_source_type_check check (schedule_type in ('interval', 'cron'))
      )
    `);
    await client.query(`
      create table if not exists dp.dart_disclosure (
        rcept_no text primary key,
        rcept_dt date not null,
        corp_code text not null default '',
        corp_name text not null default '',
        stock_code text not null default '',
        corp_cls text not null default '',
        report_nm text not null default '',
        flr_nm text not null default '',
        rm text not null default '',
        fetched_at timestamptz not null default now()
      )
    `);
    await client.query(`
      create index if not exists dart_disclosure_rcept_dt_idx
        on dp.dart_disclosure (rcept_dt desc, corp_name)
    `);
    await client.query(
      `insert into dp.dart_source (source_key, start_expr, end_expr)
       values ($1, '__TODAY__', '__TODAY__')
       on conflict (source_key) do nothing`,
      [SOURCE_KEY],
    );
    await client.query(`alter table dp.dart_source add column if not exists api_key text not null default ''`);
    await client.query(`grant select, insert, update on table dp.dart_source to dp_reader`);
    await client.query(`grant select, insert, update on table dp.dart_disclosure to dp_reader`);
    schemaReady = true;
    apiKeyReady = true;
  } finally {
    await client.end();
  }
};

type SourceRow = {
  source_key: string;
  start_expr: string;
  end_expr: string;
  schedule_enabled: boolean;
  schedule_type: string | null;
  schedule_interval_minutes: number | null;
  schedule_cron_expr: string | null;
  db_setting_id: number | null;
  api_key: string | null;
};

const mapRow = (row: SourceRow): DartSourceSetting => ({
  sourceKey: row.source_key,
  startExpr: row.start_expr,
  endExpr: row.end_expr,
  scheduleEnabled: Boolean(row.schedule_enabled),
  scheduleType: row.schedule_type === "interval" ? "interval" : "cron",
  scheduleIntervalMinutes:
    typeof row.schedule_interval_minutes === "number" ? row.schedule_interval_minutes : null,
  scheduleCronExpr: row.schedule_cron_expr ?? "",
  dbSettingId: typeof row.db_setting_id === "number" ? row.db_setting_id : null,
  apiKey: row.api_key ?? "",
});

export const readDartSource = async (settingId?: number | null) => {
  await ensureDartSchema(settingId);
  const client = await connectNewsClient(settingId);
  try {
    const result = await client.query<SourceRow>(
      `select source_key, start_expr, end_expr, schedule_enabled, schedule_type,
              schedule_interval_minutes, schedule_cron_expr, db_setting_id, api_key
         from dp.dart_source
        where source_key = $1`,
      [SOURCE_KEY],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : defaultSetting();
  } finally {
    await client.end();
  }
};

export const saveDartSource = async (
  patch: Partial<Omit<DartSourceSetting, "sourceKey">>,
  settingId?: number | null,
) => {
  const current = await readDartSource(settingId);
  const next: DartSourceSetting = {
    ...current,
    ...patch,
    sourceKey: SOURCE_KEY,
    dbSettingId:
      typeof settingId === "number" && settingId > 0 ? settingId : patch.dbSettingId ?? current.dbSettingId,
  };
  const client = await connectNewsClient(settingId);
  try {
    await client.query(
      `insert into dp.dart_source (
         source_key, start_expr, end_expr, schedule_enabled, schedule_type,
         schedule_interval_minutes, schedule_cron_expr, db_setting_id, api_key, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       on conflict (source_key) do update
         set start_expr = excluded.start_expr,
             end_expr = excluded.end_expr,
             schedule_enabled = excluded.schedule_enabled,
             schedule_type = excluded.schedule_type,
             schedule_interval_minutes = excluded.schedule_interval_minutes,
             schedule_cron_expr = excluded.schedule_cron_expr,
             db_setting_id = excluded.db_setting_id,
             api_key = excluded.api_key,
             updated_at = now()`,
      [
        SOURCE_KEY,
        next.startExpr,
        next.endExpr,
        next.scheduleEnabled,
        next.scheduleType,
        next.scheduleIntervalMinutes,
        next.scheduleCronExpr,
        next.dbSettingId,
        next.apiKey,
      ],
    );
  } finally {
    await client.end();
  }
  return next;
};
