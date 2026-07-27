import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClientFromRequest, isNonEmpty } from "../_lib/db";
import { initializeMapScheduler } from "./scheduler";

export const runtime = "nodejs";

type MapPayload = {
  sourceOrg?: string;
  apiName?: string;
  sourceTable?: string;
  seriesName?: string;
  seriesKey?: string | null;
  dateColumn?: string;
  dateFormat?: string | null;
  valueColumn?: string;
  whereClause?: string | null;
  unitName?: string | null;
  freq?: string | null;
  duplicateDatePolicy?: "none" | "sum" | null;
  fillForward?: boolean | null;
  isActive?: boolean;
};

const hasScheduleColumns = async (client: { query: (text: string) => Promise<{ rows: Array<{ column_name: string }> }> }) => {
  const result = await client.query(
    `
      select c.column_name
      from information_schema.columns c
      where c.table_schema = 'dp'
        and c.table_name = 'viz_map_mst'
        and c.column_name in (
          'schedule_enabled',
          'schedule_type',
          'schedule_interval_minutes',
          'schedule_cron_expr'
        )
    `,
  );
  return result.rows.length === 4;
};

const normalizeProvider = (provider?: string | null) => {
  const value = (provider ?? "").trim().toLowerCase();
  if (value === "data-go-kr" || value === "data_go_kr") return "datagokr";
  return value || "custom";
};

const validatePayload = (payload: MapPayload) => {
  if (!isNonEmpty(payload.sourceTable)) return "원본 테이블(sourceTable)은 필수입니다.";
  if (!isNonEmpty(payload.seriesName)) return "시리즈명(seriesName)은 필수입니다.";
  if (!isNonEmpty(payload.dateColumn)) return "날짜 컬럼(dateColumn)은 필수입니다.";
  if (!isNonEmpty(payload.valueColumn)) return "값 컬럼(valueColumn)은 필수입니다.";
  return null;
};

const normalizeDuplicateDatePolicy = (value: unknown): "none" | "sum" => {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "sum" ? "sum" : "none";
};

export async function GET(request: Request) {
  await initializeMapScheduler();
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    await connectWithTimeout(client);
    const scheduleColumnsReady = await hasScheduleColumns(client);
    const result = await client.query(
      scheduleColumnsReady
        ? `
            select
              m.map_id,
              m.source_org,
              m.api_name,
              m.source_table,
              m.series_name,
              m.series_key,
              m.date_column,
              m.date_format,
              m.value_column,
              m.where_clause,
              m.unit_name,
              m.freq,
              m.duplicate_date_policy,
              m.fill_forward,
              m.is_active,
              m.schedule_enabled,
              m.schedule_type,
              m.schedule_interval_minutes,
              m.schedule_cron_expr,
              coalesce(d.data_count, 0)::int as data_count,
              d.start_date::text as data_start_date,
              d.end_date::text as data_end_date,
              d.last_generated_at
            from dp.viz_map_mst m
            left join (
              select
                map_id,
                count(*) as data_count,
                min(obs_date) as start_date,
                max(obs_date) as end_date,
                max(updated_at) as last_generated_at
              from dp.viz_map_data
              group by map_id
            ) d on d.map_id = m.map_id
            order by m.updated_at desc, m.map_id desc
          `
        : `
            select
              m.map_id,
              m.source_org,
              m.api_name,
              m.source_table,
              m.series_name,
              m.series_key,
              m.date_column,
              m.date_format,
              m.value_column,
              m.where_clause,
              m.unit_name,
              m.freq,
              m.duplicate_date_policy,
              m.fill_forward,
              m.is_active,
              false as schedule_enabled,
              'interval'::text as schedule_type,
              null::int as schedule_interval_minutes,
              null::text as schedule_cron_expr,
              coalesce(d.data_count, 0)::int as data_count,
              d.start_date::text as data_start_date,
              d.end_date::text as data_end_date,
              d.last_generated_at
            from dp.viz_map_mst m
            left join (
              select
                map_id,
                count(*) as data_count,
                min(obs_date) as start_date,
                max(obs_date) as end_date,
                max(updated_at) as last_generated_at
              from dp.viz_map_data
              group by map_id
            ) d on d.map_id = m.map_id
            order by m.updated_at desc, m.map_id desc
          `,
    );
    return NextResponse.json({
      ok: true,
      items: result.rows.map((row) => ({
        mapId: Number(row.map_id),
        sourceOrg: normalizeProvider((row.source_org as string | null) ?? ""),
        apiName: ((row.api_name as string | null) ?? "").trim(),
        sourceTable: ((row.source_table as string | null) ?? "").trim(),
        seriesName: ((row.series_name as string | null) ?? "").trim(),
        seriesKey: (row.series_key as string | null) ?? null,
        dateColumn: ((row.date_column as string | null) ?? "").trim(),
        dateFormat: (row.date_format as string | null) ?? null,
        valueColumn: ((row.value_column as string | null) ?? "").trim(),
        whereClause: (row.where_clause as string | null) ?? null,
        unitName: (row.unit_name as string | null) ?? null,
        freq: (row.freq as string | null) ?? null,
        duplicateDatePolicy:
          ((row.duplicate_date_policy as string | null) ?? "none").trim().toLowerCase() === "sum"
            ? "sum"
            : "none",
        fillForward: row.fill_forward == null ? true : Boolean(row.fill_forward),
        isActive: Boolean(row.is_active),
        scheduleEnabled: Boolean(row.schedule_enabled),
        scheduleType:
          (row.schedule_type as "interval" | "cron" | null) === "cron" ? "cron" : "interval",
        scheduleIntervalMinutes: Number.isFinite(row.schedule_interval_minutes)
          ? Number(row.schedule_interval_minutes)
          : null,
        scheduleCronExpr: (row.schedule_cron_expr as string | null) ?? null,
        dataCount: Number(row.data_count ?? 0),
        dataStartDate: (row.data_start_date as string | null) ?? null,
        dataEndDate: (row.data_end_date as string | null) ?? null,
        lastGeneratedAt:
          row.last_generated_at instanceof Date
            ? row.last_generated_at.toISOString()
            : ((row.last_generated_at as string | null) ?? null),
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "매핑 목록을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function POST(request: Request) {
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  let payload: MapPayload | null = null;
  try {
    payload = (await request.json()) as MapPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }
  const validationError = validatePayload(payload ?? {});
  if (validationError) {
    return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
  }

  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `
        insert into dp.viz_map_mst (
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
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
        )
        returning map_id
      `,
      [
        normalizeProvider(payload?.sourceOrg),
        payload?.apiName?.trim() || payload?.seriesName?.trim() || "",
        payload?.sourceTable?.trim() || "",
        payload?.seriesName?.trim() || "",
        payload?.seriesKey?.trim() || null,
        payload?.dateColumn?.trim() || "",
        payload?.dateFormat?.trim() || null,
        payload?.valueColumn?.trim() || "",
        payload?.whereClause?.trim() || null,
        payload?.unitName?.trim() || null,
        payload?.freq?.trim() || null,
        normalizeDuplicateDatePolicy(payload?.duplicateDatePolicy),
        payload?.fillForward ?? true,
        payload?.isActive ?? true,
      ],
    );
    return NextResponse.json({ ok: true, mapId: Number(result.rows[0]?.map_id) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "매핑 저장에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

