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
  duplicate_date_policy: "none" | "sum" | null;
  fill_forward: boolean | null;
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
  duplicateDatePolicy: "none" | "sum";
  fillForward: boolean;
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
  duplicateDatePolicy:
    ((row.duplicate_date_policy ?? "none") as string).trim().toLowerCase() === "sum"
      ? "sum"
      : "none",
  fillForward: row.fill_forward == null ? true : Boolean(row.fill_forward),
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

const parseQuarterDate = (value: string) => {
  const normalized = value.trim().toUpperCase().replace("-", "");
  const match = normalized.match(/^(\d{4})Q([1-4])$/);
  if (!match) return null;
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  const month = (quarter - 1) * 3 + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
};

const parseObsDate = (raw: unknown, format?: string | null) => {
  // date/timestamp 컬럼은 node-postgres 가 JS Date 객체로 돌려준다.
  // 로컬 기준 자정으로 파싱되므로 로컬 연·월·일을 그대로 써야 날짜가 밀리지 않는다.
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const yyyy = raw.getFullYear();
    const mm = String(raw.getMonth() + 1).padStart(2, "0");
    const dd = String(raw.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const normalizedFormat = (format ?? "").trim().toUpperCase();
  if (normalizedFormat === "YYYYQM") {
    const quarterDate = parseQuarterDate(value);
    if (quarterDate) return quarterDate;
  }
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
  if (normalizedFormat === "YYYY" && /^\d{4}$/.test(value)) {
    return `${value}-01-01`;
  }
  if (normalizedFormat === "YYYY-MM" && /^\d{4}-\d{2}$/.test(value)) {
    return `${value}-01`;
  }
  if (/^\d{4}\.\d{2}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(5, 7)}-01`;
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    return `${value}-01`;
  }
  if (/^\d{4}$/.test(value)) {
    return `${value}-01-01`;
  }
  if (/^\d{6}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-01`;
  }
  const quarterDate = parseQuarterDate(value);
  if (quarterDate) return quarterDate;
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

// SQL에서 주석을 제거한 사본. WHERE 절은 더 큰 쿼리 안에 끼워 넣으므로,
// '--' 가 그대로 들어가면 뒤따르는 닫는 괄호 ')' 까지 주석 처리되어 인젝션 위험이 있다.
// → 저장은 주석 포함 원본으로 하되(편집창 초록색 표시용), 실행 시엔 이 함수로 주석을 제거한다.
const stripSqlComments = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* ... */ 블록 주석
    .replace(/--[^\n]*/g, " "); // -- 줄 주석 (해당 줄 끝까지)

// 주석을 제거한 "실제 코드"로 안전성을 검사한다. (세미콜론으로 여러 문 실행 차단)
const isSafeClause = (clause: string) => {
  const code = stripSqlComments(clause);
  if (!code.trim()) return true;
  if (code.includes(";")) return false;
  return true;
};

// WHERE 절을 쿼리에 끼워 넣기 위한 안전한 형태로 변환 (주석 제거 후 trim)
const sanitizeWhereClause = (clause: string): string => stripSqlComments(clause).trim();

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
        duplicate_date_policy,
        fill_forward,
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
  const rawWhere = (mapping.whereClause ?? "").trim();
  if (!isSafeClause(rawWhere)) {
    throw new Error(`where_clause가 안전하지 않습니다: map_id=${mapping.mapId}`);
  }
  const whereClause = sanitizeWhereClause(rawWhere);

  const query = `
    select
      ${quoteIdent(mapping.dateColumn)}::text as raw_date,
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
  const rawWhere = (mapping.whereClause ?? "").trim();
  if (!isSafeClause(rawWhere)) {
    throw new Error(`where_clause가 안전하지 않습니다: map_id=${mapping.mapId}`);
  }
  const whereClause = sanitizeWhereClause(rawWhere);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 10;
  if (mapping.duplicateDatePolicy !== "sum") {
    const query = `
      select
        ${quoteIdent(mapping.dateColumn)}::text as raw_date,
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
  }

  const rawDateExpr = `${quoteIdent(mapping.dateColumn)}::text`;
  const rawValueExpr = `${quoteIdent(mapping.valueColumn)}::text`;
  const obsDateExpr = `
    case
      when coalesce(upper($1::text), '') = 'YYYYMM'
        then case when ${rawDateExpr} ~ '^\\d{6}$' then to_date(${rawDateExpr} || '01', 'YYYYMMDD') end
      when coalesce(upper($1::text), '') = 'YYYYMMDD'
        then case when ${rawDateExpr} ~ '^\\d{8}$' then to_date(${rawDateExpr}, 'YYYYMMDD') end
      when coalesce(upper($1::text), '') = 'YYYY.MM'
        then case when ${rawDateExpr} ~ '^\\d{4}\\.\\d{2}$'
          then to_date(replace(${rawDateExpr}, '.', '') || '01', 'YYYYMMDD') end
      when coalesce(upper($1::text), '') = 'YYYY-MM'
        then case when ${rawDateExpr} ~ '^\\d{4}-\\d{2}$' then to_date(${rawDateExpr} || '-01', 'YYYY-MM-DD') end
      when coalesce(upper($1::text), '') = 'YYYY'
        then case when ${rawDateExpr} ~ '^\\d{4}$' then to_date(${rawDateExpr} || '-01-01', 'YYYY-MM-DD') end
      when coalesce(upper($1::text), '') = 'YYYYQM'
        then case when upper(replace(${rawDateExpr}, '-', '')) ~ '^\\d{4}Q[1-4]$'
          then make_date(
            substring(upper(replace(${rawDateExpr}, '-', '')) from 1 for 4)::int,
            ((substring(upper(replace(${rawDateExpr}, '-', '')) from 6 for 1)::int - 1) * 3) + 1,
            1
          ) end
      when coalesce(upper($1::text), '') = 'YYYY-MM-DD'
        then case when ${rawDateExpr} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${rawDateExpr}::date end
      else case
        when ${rawDateExpr} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${rawDateExpr}::date
        when ${rawDateExpr} ~ '^\\d{4}-\\d{2}$' then to_date(${rawDateExpr} || '-01', 'YYYY-MM-DD')
        when ${rawDateExpr} ~ '^\\d{4}$' then to_date(${rawDateExpr} || '-01-01', 'YYYY-MM-DD')
        when ${rawDateExpr} ~ '^\\d{4}\\.\\d{2}$'
          then to_date(replace(${rawDateExpr}, '.', '') || '01', 'YYYYMMDD')
        when ${rawDateExpr} ~ '^\\d{6}$' then to_date(${rawDateExpr} || '01', 'YYYYMMDD')
        when ${rawDateExpr} ~ '^\\d{8}$' then to_date(${rawDateExpr}, 'YYYYMMDD')
        when upper(replace(${rawDateExpr}, '-', '')) ~ '^\\d{4}Q[1-4]$'
          then make_date(
            substring(upper(replace(${rawDateExpr}, '-', '')) from 1 for 4)::int,
            ((substring(upper(replace(${rawDateExpr}, '-', '')) from 6 for 1)::int - 1) * 3) + 1,
            1
          )
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
  const query = `
    with src as (
      select
        ${obsDateExpr} as obs_date,
        ${obsValueExpr} as obs_value
      from ${quoteIdent("dp")}.${quoteIdent(mapping.sourceTable)}
      ${whereClause ? `where (${whereClause})` : ""}
    )
    select
      to_char(obs_date, 'YYYY-MM-DD') as raw_date,
      sum(obs_value)::text as raw_value,
      to_char(obs_date, 'YYYY-MM-DD') as obs_date,
      sum(obs_value) as obs_value
    from src
    where obs_date is not null
      and obs_value is not null
    group by obs_date
    order by obs_date desc
    limit ${safeLimit}
  `;
  const result = await client.query(query, [mapping.dateFormat ?? null]);
  return result.rows.map((row) => {
    const item = row as PreviewRow & { obs_date?: unknown; obs_value?: unknown };
    return {
      rawDate: item.raw_date == null ? null : String(item.raw_date),
      rawValue: item.raw_value == null ? null : String(item.raw_value),
      obsDate: item.obs_date == null ? null : String(item.obs_date),
      obsValue: parseObsValue(item.obs_value),
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
  const rawWhere = (mapping.whereClause ?? "").trim();
  if (!isSafeClause(rawWhere)) {
    throw new Error(`where_clause가 안전하지 않습니다: map_id=${mapping.mapId}`);
  }
  const whereClause = sanitizeWhereClause(rawWhere);

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
      when coalesce(upper($6::text), '') = 'YYYY-MM'
        then case when ${rawDateExpr} ~ '^\\d{4}-\\d{2}$' then to_date(${rawDateExpr} || '-01', 'YYYY-MM-DD') end
      when coalesce(upper($6::text), '') = 'YYYY'
        then case when ${rawDateExpr} ~ '^\\d{4}$' then to_date(${rawDateExpr} || '-01-01', 'YYYY-MM-DD') end
      when coalesce(upper($6::text), '') = 'YYYYQM'
        then case when upper(replace(${rawDateExpr}, '-', '')) ~ '^\\d{4}Q[1-4]$'
          then make_date(
            substring(upper(replace(${rawDateExpr}, '-', '')) from 1 for 4)::int,
            ((substring(upper(replace(${rawDateExpr}, '-', '')) from 6 for 1)::int - 1) * 3) + 1,
            1
          ) end
      when coalesce(upper($6::text), '') = 'YYYY-MM-DD'
        then case when ${rawDateExpr} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${rawDateExpr}::date end
      else case
        when ${rawDateExpr} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${rawDateExpr}::date
        when ${rawDateExpr} ~ '^\\d{4}-\\d{2}$' then to_date(${rawDateExpr} || '-01', 'YYYY-MM-DD')
        when ${rawDateExpr} ~ '^\\d{4}$' then to_date(${rawDateExpr} || '-01-01', 'YYYY-MM-DD')
        when ${rawDateExpr} ~ '^\\d{4}\\.\\d{2}$'
          then to_date(replace(${rawDateExpr}, '.', '') || '01', 'YYYYMMDD')
        when ${rawDateExpr} ~ '^\\d{6}$' then to_date(${rawDateExpr} || '01', 'YYYYMMDD')
        when ${rawDateExpr} ~ '^\\d{8}$' then to_date(${rawDateExpr}, 'YYYYMMDD')
        when upper(replace(${rawDateExpr}, '-', '')) ~ '^\\d{4}Q[1-4]$'
          then make_date(
            substring(upper(replace(${rawDateExpr}, '-', '')) from 1 for 4)::int,
            ((substring(upper(replace(${rawDateExpr}, '-', '')) from 6 for 1)::int - 1) * 3) + 1,
            1
          )
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

    // 빈 날짜 채우기(forward-fill): 일별(D) + 옵션 켜짐일 때만.
    // normalized 의 min~max 사이 모든 달력일을 만들고, 빠진 날은 직전 관측값으로 채운다.
    const useFill = mapping.fillForward && freq === "D";
    const fillCtes = useFill
      ? `,
        calendar as (
          select g::date as obs_date
          from generate_series(
            (select min(obs_date) from normalized)::timestamp,
            (select max(obs_date) from normalized)::timestamp,
            interval '1 day'
          ) g
        ),
        joined as (
          select
            c.obs_date,
            n.obs_value,
            (n.obs_value is null) as is_filled,
            count(n.obs_value) over (order by c.obs_date) as grp
          from calendar c
          left join (
            select distinct on (obs_date) obs_date, obs_value from normalized order by obs_date
          ) n on n.obs_date = c.obs_date
        ),
        filled as (
          select
            obs_date,
            first_value(obs_value) over (partition by grp order by obs_date) as obs_value,
            is_filled
          from joined
        )`
      : "";
    const insertSource = useFill ? "filled" : "normalized";

    const upsertResult = await client.query(
      `
        with src as (
          select
            ${obsDateExpr} as obs_date,
            ${obsValueExpr} as obs_value
          from ${quoteIdent("dp")}.${quoteIdent(mapping.sourceTable)}
          ${whereClause ? `where (${whereClause})` : ""}
        ),
        normalized as (
          select
            src.obs_date,
            ${
              mapping.duplicateDatePolicy === "sum"
                ? "sum(src.obs_value) as obs_value"
                : "src.obs_value"
            }
          from src
          where src.obs_date is not null
            and src.obs_value is not null
          ${mapping.duplicateDatePolicy === "sum" ? "group by src.obs_date" : ""}
        )${fillCtes},
        upserted as (
          insert into dp.viz_map_data (
            map_id,
            obs_date,
            obs_value,
            freq,
            series_key,
            series_name,
            unit_name,
            is_filled,
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
            ${useFill ? "src.is_filled" : "false"},
            now()
          from ${insertSource} src
          where src.obs_value is not null
          on conflict (map_id, obs_date, freq) do update
          set
            obs_value = excluded.obs_value,
            series_key = excluded.series_key,
            series_name = excluded.series_name,
            unit_name = excluded.unit_name,
            is_filled = excluded.is_filled,
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

