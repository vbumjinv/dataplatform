import { NextResponse } from "next/server";
import { Client } from "pg";
import { resolveDbConfig } from "../../db/_lib/connection";

export const runtime = "nodejs";

const CONNECT_TIMEOUT_MS = 5000;
const DB_CONFIG = {
  url: process.env.DP_DB_URL,
  database: process.env.DP_DB_NAME,
  user: process.env.DP_DB_USER,
  password: process.env.DP_DB_PASSWORD,
};

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
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return null;
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};

const canUseDb = () =>
  isNonEmpty(DB_CONFIG.url) &&
  isNonEmpty(DB_CONFIG.database) &&
  isNonEmpty(DB_CONFIG.user) &&
  isNonEmpty(DB_CONFIG.password);

const resolveConnectionString = async (request: Request) => {
  const selectedSettingId = new URL(request.url).searchParams.get("dbSettingId");
  const numericId = Number(selectedSettingId);
  const resolvedDb = await resolveDbConfig({
    settingId: Number.isFinite(numericId) ? numericId : null,
  });
  if (resolvedDb) return buildConnectionString(resolvedDb);
  if (!canUseDb()) return null;
  return buildConnectionString(DB_CONFIG);
};

const normalizeAxisMap = (
  seriesIds: string[],
  seriesOptions: Array<{ seriesId?: string; yAxisSide?: string }> = [],
) => {
  const map = new Map<string, "left" | "right">();
  for (const item of seriesOptions) {
    const seriesId = (item.seriesId ?? "").trim();
    if (!seriesId) continue;
    const yAxisSide = item.yAxisSide === "right" ? "right" : "left";
    map.set(seriesId, yAxisSide);
  }
  return Object.fromEntries(
    seriesIds.map((seriesId) => [seriesId, map.get(seriesId) ?? "left"]),
  );
};

export async function GET(request: Request) {
  const connectionString = await resolveConnectionString(request);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("DB 연결 시간이 초과되었습니다.")), CONNECT_TIMEOUT_MS);
      }),
    ]);
    const result = await client.query(
      `
        select
          c.chart_id,
          c.chart_name,
          c.chart_type,
          c.is_public,
          c.created_by,
          c.created_at,
          c.updated_at,
          cardinality(c.series_ids) as series_count
        from dp.viz_chart_cfg c
        where c.is_active = true
        order by c.updated_at desc, c.chart_id desc
      `,
    );

    return NextResponse.json({
      ok: true,
      charts: result.rows.map((row) => ({
        chartId: Number(row.chart_id),
        chartName: (row.chart_name as string) ?? `그래프 ${row.chart_id}`,
        chartType: (row.chart_type as string) ?? "line",
        isPublic: Boolean(row.is_public),
        createdBy: (row.created_by as string | null) ?? null,
        updatedAt: ((row.updated_at as Date) ?? (row.created_at as Date)).toISOString(),
        seriesCount: Number(row.series_count ?? 0),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "그래프 목록을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function POST(request: Request) {
  const connectionString = await resolveConnectionString(request);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    chartName?: string;
    chartType?: string;
    seriesIds?: string[];
    seriesOptions?: Array<{ seriesId?: string; yAxisSide?: string }>;
  } | null;

  const chartName = payload?.chartName?.trim() ?? "";
  const seriesIds = (payload?.seriesIds ?? [])
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  if (!chartName) {
    return NextResponse.json(
      { ok: false, error: "그래프 이름을 입력하세요." },
      { status: 400 },
    );
  }
  if (seriesIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: "시리즈를 1개 이상 선택하세요." },
      { status: 400 },
    );
  }

  const chartType = payload?.chartType?.trim() || "line";
  const axisMap = normalizeAxisMap(seriesIds, payload?.seriesOptions ?? []);

  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("DB 연결 시간이 초과되었습니다.")), CONNECT_TIMEOUT_MS);
      }),
    ]);
    const result = await client.query(
      `
        insert into dp.viz_chart_cfg (
          chart_name,
          chart_type,
          series_ids,
          series_axis_map,
          reference_lines,
          is_public,
          is_active
        )
        values ($1, $2, $3::text[], $4::jsonb, '[]'::jsonb, true, true)
        returning chart_id
      `,
      [chartName, chartType, seriesIds, JSON.stringify(axisMap)],
    );
    return NextResponse.json({
      ok: true,
      chartId: Number(result.rows[0]?.chart_id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "그래프 생성에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

