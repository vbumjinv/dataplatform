import { connectNewsClient } from "./news-collect";

export type NytScheduleType = "interval" | "cron";

export type NytSourceSetting = {
  sourceKey: string;
  startExpr: string;
  endExpr: string;
  scheduleEnabled: boolean;
  scheduleType: NytScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleCronExpr: string;
  dbSettingId: number | null;
  apiKey: string;
  keywords: string;
};

export const DEFAULT_NYT_KEYWORDS = [
  "president",
  "White House",
  "war",
  "Israel",
  "Ukraine",
  "sanctions",
  "Fed",
  "interest rate",
  "oil",
  "dollar",
  "tariff",
  "semiconductor",
  "Samsung",
  "SK Hynix",
  "Korea",
  "China",
  "Taiwan",
].join("\n");

const SOURCE_KEY = "nyt";

const defaultSetting = (): NytSourceSetting => ({
  sourceKey: SOURCE_KEY,
  startExpr: "__TODAY__",
  endExpr: "__TODAY__",
  scheduleEnabled: false,
  scheduleType: "cron",
  scheduleIntervalMinutes: 60,
  scheduleCronExpr: "",
  dbSettingId: null,
  apiKey: "",
  keywords: DEFAULT_NYT_KEYWORDS,
});

let schemaReady = false;
let keywordsReady = false;

export const ensureNytSchema = async (settingId?: number | null) => {
  if (schemaReady && keywordsReady) return;
  const client = await connectNewsClient(settingId);
  try {
    if (!schemaReady) {
    await client.query(`
      create table if not exists dp.news_nyt_source (
        source_key text primary key,
        start_expr text not null,
        end_expr text not null,
        schedule_enabled boolean not null default false,
        schedule_type text not null default 'cron',
        schedule_interval_minutes integer,
        schedule_cron_expr text not null default '',
        db_setting_id integer,
        api_key text not null default '',
        updated_at timestamptz not null default now(),
        constraint news_nyt_source_type_check check (schedule_type in ('interval', 'cron'))
      )
    `);
    await client.query(`
      create table if not exists dp.news_nyt_article (
        article_id text primary key,
        web_url text not null default '',
        headline text not null default '',
        abstract text not null default '',
        section_name text not null default '',
        published_at timestamptz,
        pub_date date,
        fetched_at timestamptz not null default now()
      )
    `);
    await client.query(`
      create index if not exists news_nyt_article_pub_date_idx
        on dp.news_nyt_article (pub_date desc, published_at desc)
    `);
    await client.query(
      `insert into dp.news_nyt_source (source_key, start_expr, end_expr)
       values ($1, '__TODAY__', '__TODAY__')
       on conflict (source_key) do nothing`,
      [SOURCE_KEY],
    );
    await client.query(`grant select, insert, update on table dp.news_nyt_source to dp_reader`);
    await client.query(`grant select, insert, update on table dp.news_nyt_article to dp_reader`);
    schemaReady = true;
    }
    await client.query(`alter table dp.news_nyt_source add column if not exists keywords text not null default ''`);
    await client.query(
      `update dp.news_nyt_source set keywords = $1 where source_key = $2 and btrim(keywords) = ''`,
      [DEFAULT_NYT_KEYWORDS, SOURCE_KEY],
    );
    keywordsReady = true;
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
  keywords: string | null;
};

const mapRow = (row: SourceRow): NytSourceSetting => ({
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
  keywords: row.keywords?.trim() ? row.keywords : DEFAULT_NYT_KEYWORDS,
});

export const readNytSource = async (settingId?: number | null) => {
  await ensureNytSchema(settingId);
  const client = await connectNewsClient(settingId);
  try {
    const result = await client.query<SourceRow>(
      `select source_key, start_expr, end_expr, schedule_enabled, schedule_type,
              schedule_interval_minutes, schedule_cron_expr, db_setting_id, api_key, keywords
         from dp.news_nyt_source
        where source_key = $1`,
      [SOURCE_KEY],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : defaultSetting();
  } finally {
    await client.end();
  }
};

export const saveNytSource = async (
  patch: Partial<Omit<NytSourceSetting, "sourceKey">>,
  settingId?: number | null,
) => {
  const current = await readNytSource(settingId);
  const next: NytSourceSetting = {
    ...current,
    ...patch,
    sourceKey: SOURCE_KEY,
    dbSettingId:
      typeof settingId === "number" && settingId > 0 ? settingId : patch.dbSettingId ?? current.dbSettingId,
  };
  const client = await connectNewsClient(settingId);
  try {
    await client.query(
      `insert into dp.news_nyt_source (
         source_key, start_expr, end_expr, schedule_enabled, schedule_type,
         schedule_interval_minutes, schedule_cron_expr, db_setting_id, api_key, keywords, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       on conflict (source_key) do update
         set start_expr = excluded.start_expr,
             end_expr = excluded.end_expr,
             schedule_enabled = excluded.schedule_enabled,
             schedule_type = excluded.schedule_type,
             schedule_interval_minutes = excluded.schedule_interval_minutes,
             schedule_cron_expr = excluded.schedule_cron_expr,
             db_setting_id = excluded.db_setting_id,
             api_key = excluded.api_key,
             keywords = excluded.keywords,
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
        next.keywords,
      ],
    );
  } finally {
    await client.end();
  }
  return next;
};
