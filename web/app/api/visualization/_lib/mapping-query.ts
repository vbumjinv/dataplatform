import type { Client } from "pg";

type MappingRow = {
  map_id: number;
  source_org: string;
  api_name: string;
  source_table: string;
  series_name: string;
  series_key: string | null;
  date_column: string;
  date_format: string | null;
  value_column: string;
  where_clause: string | null;
  unit_name: string | null;
  freq: string | null;
  is_active: boolean;
};

export type MappingItem = {
  mapId: number;
  sourceOrg: string;
  apiName: string;
  sourceTable: string;
  seriesName: string;
  seriesKey: string | null;
  dateColumn: string;
  dateFormat: string | null;
  valueColumn: string;
  whereClause: string | null;
  unitName: string | null;
  freq: string | null;
  isActive: boolean;
};

export const toSeriesIdFromMapId = (mapId: number) => `map:${mapId}`;
export const parseMapIdFromSeriesId = (seriesId: string): number | null => {
  const value = (seriesId ?? "").trim();
  if (!value.startsWith("map:")) return null;
  const n = Number(value.slice(4));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const asMappingItem = (row: MappingRow): MappingItem => ({
  mapId: Number(row.map_id),
  sourceOrg: row.source_org,
  apiName: row.api_name,
  sourceTable: row.source_table,
  seriesName: row.series_name,
  seriesKey: row.series_key,
  dateColumn: row.date_column,
  dateFormat: row.date_format,
  valueColumn: row.value_column,
  whereClause: row.where_clause,
  unitName: row.unit_name,
  freq: row.freq,
  isActive: Boolean(row.is_active),
});

const normalizeIsoDate = (dateText: string) => {
  if (!dateText) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return dateText;
  const parsed = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const parseObsDate = (raw: unknown, format?: string | null) => {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const normalizedFormat = (format ?? "").trim().toUpperCase();
  if (normalizedFormat === "YYYYMM" && /^\d{6}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-01`;
  }
  if (normalizedFormat === "YYYYMMDD" && /^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  if (normalizedFormat === "YYYY.MM" && /^\d{4}\.\d{2}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(5, 7)}-01`;
  }
  if (normalizedFormat === "YYYY-MM-DD" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  if (/^\d{4}\.\d{2}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(5, 7)}-01`;
  }
  if (/^\d{6}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-01`;
  }
  return normalizeIsoDate(value);
};

const parseObsValue = (raw: unknown) => {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw).trim();
  if (!text) return null;
  const normalized = text.replaceAll(",", "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
};

const quoteIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;

const isSafeClause = (clause: string) => {
  if (!clause.trim()) return true;
  if (clause.includes(";")) return false;
  if (clause.includes("--")) return false;
  if (clause.includes("/*") || clause.includes("*/")) return false;
  return true;
};

export const fetchMappings = async (
  client: Client,
  ids?: number[],
  activeOnly = false,
) => {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (ids && ids.length > 0) {
    values.push(ids);
    conditions.push(`map_id = any($${values.length}::bigint[])`);
  }
  if (activeOnly) {
    conditions.push("is_active = true");
  }
  const whereClause = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const result = await client.query(
    `
      select
        map_id,
        source_org,
        api_name,
        source_table,
        series_name,
        series_key,
        date_column,
        date_format,
        value_column,
        where_clause,
        unit_name,
        freq,
        is_active
      from dp.viz_map_mst
      ${whereClause}
      order by source_org, series_name, map_id
    `,
    values,
  );
  return result.rows.map((row) => asMappingItem(row as MappingRow));
};

export const fetchPointsForMapping = async (client: Client, mapping: MappingItem) => {
  const whereClause = (mapping.whereClause ?? "").trim();
  if (!isSafeClause(whereClause)) {
    throw new Error(`where_clause가 안전하지 않습니다: map_id=${mapping.mapId}`);
  }

  const query = `
    select
      ${quoteIdent(mapping.dateColumn)} as raw_date,
      ${quoteIdent(mapping.valueColumn)} as raw_value
    from ${quoteIdent("dp")}.${quoteIdent(mapping.sourceTable)}
    ${whereClause ? `where (${whereClause})` : ""}
  `;
  const result = await client.query(query);
  const points = result.rows
    .map((row) => {
      const obsDate = parseObsDate(row.raw_date, mapping.dateFormat);
      const obsValue = parseObsValue(row.raw_value);
      if (!obsDate || obsValue == null) return null;
      return { obsDate, obsValue };
    })
    .filter((item): item is { obsDate: string; obsValue: number } => item != null)
    .sort((a, b) => a.obsDate.localeCompare(b.obsDate));
  return points;
};

type PreviewRow = {
  raw_date: unknown;
  raw_value: unknown;
};

export const fetchPreviewForMapping = async (
  client: Client,
  mapping: MappingItem,
  limit = 10,
) => {
  const whereClause = (mapping.whereClause ?? "").trim();
  if (!isSafeClause(whereClause)) {
    throw new Error(`where_clause가 안전하지 않습니다: map_id=${mapping.mapId}`);
  }
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 10;
  const query = `
    select
      ${quoteIdent(mapping.dateColumn)} as raw_date,
      ${quoteIdent(mapping.valueColumn)} as raw_value
    from ${quoteIdent("dp")}.${quoteIdent(mapping.sourceTable)}
    ${whereClause ? `where (${whereClause})` : ""}
    limit ${safeLimit}
  `;
  const result = await client.query(query);
  return result.rows.map((row) => {
    const item = row as PreviewRow;
    return {
      rawDate: item.raw_date == null ? null : String(item.raw_date),
      rawValue: item.raw_value == null ? null : String(item.raw_value),
      obsDate: parseObsDate(item.raw_date, mapping.dateFormat),
      obsValue: parseObsValue(item.raw_value),
    };
  });
};

type BuildMapDataOptions = {
  replaceExisting: boolean;
};

type BuildMapDataResult = {
  affectedCount: number;
  cleanedLegacyFreqCount: number;
  startDate: string | null;
  endDate: string | null;
  generatedAt: string;
};

export const buildMapDataForMapping = async (
  client: Client,
  mapping: MappingItem,
  options: BuildMapDataOptions,
): Promise<BuildMapDataResult> => {
  const whereClause = (mapping.whereClause ?? "").trim();
  if (!isSafeClause(whereClause)) {
    throw new Error(`where_clause가 안전하지 않습니다: map_id=${mapping.mapId}`);
  }

  const freq = ((mapping.freq ?? "M").trim() || "M").toUpperCase();
  const rawDateExpr = `${quoteIdent(mapping.dateColumn)}::text`;
  const rawValueExpr = `${quoteIdent(mapping.valueColumn)}::text`;
  const obsDateExpr = `
    case
      when coalesce(upper($6::text), '') = 'YYYYMM'
        then case when ${rawDateExpr} ~ '^\\d{6}$' then to_date(${rawDateExpr} || '01', 'YYYYMMDD') end
      when coalesce(upper($6::text), '') = 'YYYYMMDD'
        then case when ${rawDateExpr} ~ '^\\d{8}$' then to_date(${rawDateExpr}, 'YYYYMMDD') end
      when coalesce(upper($6::text), '') = 'YYYY.MM'
        then case when ${rawDateExpr} ~ '^\\d{4}\\.\\d{2}$'
          then to_date(replace(${rawDateExpr}, '.', '') || '01', 'YYYYMMDD') end
      when coalesce(upper($6::text), '') = 'YYYY-MM-DD'
        then case when ${rawDateExpr} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${rawDateExpr}::date end
      else case
        when ${rawDateExpr} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${rawDateExpr}::date
        when ${rawDateExpr} ~ '^\\d{4}\\.\\d{2}$'
          then to_date(replace(${rawDateExpr}, '.', '') || '01', 'YYYYMMDD')
        when ${rawDateExpr} ~ '^\\d{6}$' then to_date(${rawDateExpr} || '01', 'YYYYMMDD')
        when ${rawDateExpr} ~ '^\\d{8}$' then to_date(${rawDateExpr}, 'YYYYMMDD')
        else null
      end
    end
  `;
  const obsValueExpr = `
    case
      when nullif(regexp_replace(${rawValueExpr}, ',', '', 'g'), '') is null then null
      when nullif(regexp_replace(${rawValueExpr}, ',', '', 'g'), '') ~ '^[-+]?\\d+(\\.\\d+)?$'
        then (nullif(regexp_replace(${rawValueExpr}, ',', '', 'g'), ''))::numeric
      else null
    end
  `;

  await client.query("begin");
  try {
    let cleanedLegacyFreqCount = 0;
    if (options.replaceExisting) {
      await client.query(`delete from dp.viz_map_data where map_id = $1`, [mapping.mapId]);
    } else {
      const cleaned = await client.query(
        `
          delete from dp.viz_map_data
          where map_id = $1
            and upper(freq) <> $2
        `,
        [mapping.mapId, freq],
      );
      cleanedLegacyFreqCount = cleaned.rowCount ?? 0;
    }

    const upsertResult = await client.query(
      `
        with src as (
          select
            ${obsDateExpr} as obs_date,
            ${obsValueExpr} as obs_value
          from ${quoteIdent("dp")}.${quoteIdent(mapping.sourceTable)}
          ${whereClause ? `where (${whereClause})` : ""}
        ),
        upserted as (
          insert into dp.viz_map_data (
            map_id,
            obs_date,
            obs_value,
            freq,
            series_key,
            series_name,
            unit_name,
            updated_at
          )
          select
            $1,
            src.obs_date,
            src.obs_value,
            $2,
            $3,
            $4,
            $5,
            now()
          from src
          where src.obs_date is not null
            and src.obs_value is not null
          on conflict (map_id, obs_date, freq) do update
          set
            obs_value = excluded.obs_value,
            series_key = excluded.series_key,
            series_name = excluded.series_name,
            unit_name = excluded.unit_name,
            updated_at = now()
          returning obs_date
        )
        select
          count(*)::int as affected_count,
          min(obs_date)::text as start_date,
          max(obs_date)::text as end_date
        from upserted
      `,
      [
        mapping.mapId,
        freq,
        mapping.seriesKey ?? null,
        mapping.seriesName,
        mapping.unitName ?? null,
        mapping.dateFormat ?? null,
      ],
    );
    await client.query("commit");

    const row = upsertResult.rows[0] as
      | { affected_count?: unknown; start_date?: unknown; end_date?: unknown }
      | undefined;
    return {
      affectedCount: Number(row?.affected_count ?? 0),
      cleanedLegacyFreqCount,
      startDate: row?.start_date ? String(row.start_date) : null,
      endDate: row?.end_date ? String(row.end_date) : null,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
};

// 특정 원천 테이블(source_table)에 연결된 활성 데이터 매핑을 모두 생성 실행한다.
// 수집 스케줄(적재) 직후 매핑까지 이어서 수행하기 위한 헬퍼.
export const runMappingsForSourceTable = async (
  client: Client,
  sourceTable: string,
): Promise<{ ranMapIds: number[]; errors: Array<{ mapId: number; error: string }> }> => {
  const idsResult = await client.query<{ map_id: number }>(
    `select map_id
     from dp.viz_map_mst
     where is_active = true
       and lower(source_table) = lower($1)`,
    [sourceTable],
  );
  const ids = idsResult.rows.map((row) => Number(row.map_id)).filter(Number.isFinite);
  if (ids.length === 0) return { ranMapIds: [], errors: [] };

  const mappings = await fetchMappings(client, ids, true);
  const ranMapIds: number[] = [];
  const errors: Array<{ mapId: number; error: string }> = [];
  for (const mapping of mappings) {
    try {
      await buildMapDataForMapping(client, mapping, { replaceExisting: false });
      ranMapIds.push(mapping.mapId);
    } catch (error) {
      errors.push({
        mapId: mapping.mapId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ranMapIds, errors };
};

