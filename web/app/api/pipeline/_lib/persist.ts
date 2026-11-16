// 파이프라인 생성/수정 공용 로직 (수집 1개 + 매핑 N개).
import type { Client } from "pg";

export type ScheduleInput = {
  enabled?: boolean;
  type?: "interval" | "cron";
  intervalMinutes?: number | string | null;
  cronExpr?: string | null;
};

export type PipelineInput = {
  name?: string;
  description?: string | null;
  collectionType?: "api" | "news";
  newsSourceKey?: "naver-pay" | null;
  groupId?: number | string | null;
  mapIds?: Array<number | string>;
  transformIds?: Array<number | string>;
  isActive?: boolean;
  schedule?: ScheduleInput;
  dbSettingId?: number | string | null;
};

const toInt = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const normalizeSchedule = (schedule?: ScheduleInput) => {
  const enabled = Boolean(schedule?.enabled);
  const type = schedule?.type === "cron" ? "cron" : "interval";
  const intervalMinutes = toInt(schedule?.intervalMinutes ?? 60) ?? 60;
  const cronExpr = (schedule?.cronExpr ?? "").trim() || null;
  return { enabled, type, intervalMinutes: Math.max(1, intervalMinutes), cronExpr };
};

export const ensurePipelineCollectionSchema = async (client: Client) => {
  await client.query(`
    create table if not exists dp.api_pipeline_collection (
      pipeline_id bigint primary key references dp.api_pipeline(pipeline_id) on delete cascade,
      collection_type text not null,
      news_source_key text,
      updated_at timestamptz not null default now(),
      constraint api_pipeline_collection_type_check check (collection_type in ('news')),
      constraint api_pipeline_collection_news_key_check check (
        news_source_key is null or news_source_key in ('naver-pay')
      )
    )
  `);
};

const replaceCollectionMeta = async (client: Client, pipelineId: number, body: PipelineInput) => {
  await client.query(`delete from dp.api_pipeline_collection where pipeline_id = $1`, [pipelineId]);
  if (body.collectionType !== "news") return;
  await client.query(
    `insert into dp.api_pipeline_collection (pipeline_id, collection_type, news_source_key, updated_at)
     values ($1, 'news', $2, now())`,
    [pipelineId, body.newsSourceKey === "naver-pay" ? "naver-pay" : "naver-pay"],
  );
};

const replaceMaps = async (client: Client, pipelineId: number, mapIds?: Array<number | string>) => {
  await client.query(`delete from dp.api_pipeline_map where pipeline_id = $1`, [pipelineId]);
  const ids = Array.from(
    new Set((Array.isArray(mapIds) ? mapIds : []).map(toInt).filter((v): v is number => v != null)),
  );
  for (let i = 0; i < ids.length; i += 1) {
    await client.query(
      `insert into dp.api_pipeline_map (pipeline_id, map_id, sort_order) values ($1, $2, $3)`,
      [pipelineId, ids[i], i],
    );
  }
};

const replaceTransforms = async (
  client: Client,
  pipelineId: number,
  transformIds?: Array<number | string>,
) => {
  await client.query(`delete from dp.api_pipeline_transform where pipeline_id = $1`, [pipelineId]);
  const ids = Array.from(
    new Set(
      (Array.isArray(transformIds) ? transformIds : []).map(toInt).filter((v): v is number => v != null),
    ),
  );
  for (let i = 0; i < ids.length; i += 1) {
    await client.query(
      `insert into dp.api_pipeline_transform (pipeline_id, transform_id, sort_order) values ($1, $2, $3)`,
      [pipelineId, ids[i], i],
    );
  }
};

export const createPipeline = async (client: Client, body: PipelineInput): Promise<number> => {
  const name = (body.name ?? "").trim() || "새 파이프라인";
  const schedule = normalizeSchedule(body.schedule);
  const groupId = body.collectionType === "news" ? null : toInt(body.groupId);
  const dbSettingId = toInt(body.dbSettingId);
  await ensurePipelineCollectionSchema(client);
  await client.query("begin");
  try {
    const result = await client.query<{ pipeline_id: number }>(
      `insert into dp.api_pipeline
         (name, description, group_id, db_setting_id, schedule_enabled, schedule_type, schedule_interval_minutes, schedule_cron_expr, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning pipeline_id`,
      [
        name,
        body.description ?? null,
        groupId,
        dbSettingId,
        schedule.enabled,
        schedule.type,
        schedule.intervalMinutes,
        schedule.cronExpr,
        body.isActive ?? true,
      ],
    );
    const pipelineId = result.rows[0].pipeline_id;
    await replaceCollectionMeta(client, pipelineId, body);
    await replaceMaps(client, pipelineId, body.mapIds);
    await replaceTransforms(client, pipelineId, body.transformIds);
    await client.query("commit");
    return pipelineId;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    throw error;
  }
};

export const updatePipeline = async (
  client: Client,
  pipelineId: number,
  body: PipelineInput,
): Promise<void> => {
  const schedule = normalizeSchedule(body.schedule);
  const groupId = body.collectionType === "news" ? null : toInt(body.groupId);
  const dbSettingId = toInt(body.dbSettingId);
  await ensurePipelineCollectionSchema(client);
  await client.query("begin");
  try {
    await client.query(
      `update dp.api_pipeline set
         name = coalesce($2, name),
         description = $3,
         group_id = $4,
         db_setting_id = coalesce($5, db_setting_id),
         schedule_enabled = $6,
         schedule_type = $7,
         schedule_interval_minutes = $8,
         schedule_cron_expr = $9,
         is_active = $10,
         updated_at = now()
       where pipeline_id = $1`,
      [
        pipelineId,
        (body.name ?? "").trim() || null,
        body.description ?? null,
        groupId,
        dbSettingId,
        schedule.enabled,
        schedule.type,
        schedule.intervalMinutes,
        schedule.cronExpr,
        body.isActive ?? true,
      ],
    );
    await replaceCollectionMeta(client, pipelineId, body);
    if (body.mapIds !== undefined) {
      await replaceMaps(client, pipelineId, body.mapIds);
    }
    if (body.transformIds !== undefined) {
      await replaceTransforms(client, pipelineId, body.transformIds);
    }
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    throw error;
  }
};
