import { connectNewsClient } from "./news-collect";

export type NewsStockScheduleType = "interval" | "cron";

export type NewsStockSourceSetting = {
  sourceKey: string;
  startExpr: string;
  endExpr: string;
  scheduleEnabled: boolean;
  scheduleType: NewsStockScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleCronExpr: string;
  dbSettingId: number | null;
};

const SOURCE_KEY = "naver-pay";

const defaultSetting = (): NewsStockSourceSetting => ({
  sourceKey: SOURCE_KEY,
  startExpr: "__TODAY_MINUS_1D__",
  endExpr: "__TODAY_MINUS_1D__",
  scheduleEnabled: false,
  scheduleType: "cron",
  scheduleIntervalMinutes: 60,
  scheduleCronExpr: "",
  dbSettingId: null,
});

let schemaReady = false;

const ensureSchema = async (settingId?: number | null) => {
  if (schemaReady) return;
  const client = await connectNewsClient(settingId);
  try {
    try {
      await client.query(`
        create table if not exists dp.news_stock_source (
          source_key text primary key,
          start_expr text not null,
          end_expr text not null,
          schedule_enabled boolean not null default false,
          schedule_type text not null default 'cron',
          schedule_interval_minutes integer,
          schedule_cron_expr text not null default '',
          db_setting_id integer,
          updated_at timestamptz not null default now(),
          constraint news_stock_source_type_check check (schedule_type in ('interval', 'cron'))
        )
      `);
      await client.query(
        `insert into dp.news_stock_source (source_key, start_expr, end_expr)
         values ($1, '__TODAY_MINUS_1D__', '__TODAY_MINUS_1D__')
         on conflict (source_key) do nothing`,
        [SOURCE_KEY],
      );
    } catch {
      // 읽기 계정은 테이블을 다시 만들지 못해도 기존 설정은 읽을 수 있다.
    }
    await client.query(`select source_key from dp.news_stock_source where source_key = $1`, [SOURCE_KEY]);
    schemaReady = true;
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
};

const mapRow = (row: SourceRow): NewsStockSourceSetting => ({
  sourceKey: row.source_key,
  startExpr: row.start_expr,
  endExpr: row.end_expr,
  scheduleEnabled: Boolean(row.schedule_enabled),
  scheduleType: row.schedule_type === "interval" ? "interval" : "cron",
  scheduleIntervalMinutes:
    typeof row.schedule_interval_minutes === "number" ? row.schedule_interval_minutes : null,
  scheduleCronExpr: row.schedule_cron_expr ?? "",
  dbSettingId: typeof row.db_setting_id === "number" ? row.db_setting_id : null,
});

export const readNewsStockSource = async (settingId?: number | null) => {
  await ensureSchema(settingId);
  const client = await connectNewsClient(settingId);
  try {
    const result = await client.query<SourceRow>(
      `select source_key, start_expr, end_expr, schedule_enabled, schedule_type,
              schedule_interval_minutes, schedule_cron_expr, db_setting_id
         from dp.news_stock_source
        where source_key = $1`,
      [SOURCE_KEY],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : defaultSetting();
  } finally {
    await client.end();
  }
};

export const saveNewsStockSource = async (
  patch: Partial<Omit<NewsStockSourceSetting, "sourceKey">>,
  settingId?: number | null,
) => {
  const current = await readNewsStockSource(settingId);
  const next: NewsStockSourceSetting = {
    ...current,
    ...patch,
    sourceKey: SOURCE_KEY,
    dbSettingId:
      typeof settingId === "number" && settingId > 0 ? settingId : patch.dbSettingId ?? current.dbSettingId,
  };
  const client = await connectNewsClient(settingId);
  try {
    await client.query(
      `insert into dp.news_stock_source (
         source_key, start_expr, end_expr, schedule_enabled, schedule_type,
         schedule_interval_minutes, schedule_cron_expr, db_setting_id, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (source_key) do update
         set start_expr = excluded.start_expr,
             end_expr = excluded.end_expr,
             schedule_enabled = excluded.schedule_enabled,
             schedule_type = excluded.schedule_type,
             schedule_interval_minutes = excluded.schedule_interval_minutes,
             schedule_cron_expr = excluded.schedule_cron_expr,
             db_setting_id = excluded.db_setting_id,
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
      ],
    );
  } finally {
    await client.end();
  }
  return next;
};
