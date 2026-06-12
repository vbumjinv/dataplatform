import { NextResponse } from "next/server";
import { Client } from "pg";
import { resolveDbConfig } from "../../../db/_lib/connection";

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

const toDateText = (value: unknown) => {
  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  if (typeof value === "string") return value.slice(0, 10);
  return String(value ?? "").slice(0, 10);
};

const parseMapIdFromSeriesId = (seriesId: string) => {
  const match = /^map:(\d+)$/.exec(seriesId);
  if (!match) return null;
  const mapId = Number(match[1]);
  return Number.isFinite(mapId) ? mapId : null;
};

const normalizeReferenceLines = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const lineType = row.lineType === "vertical" ? "vertical" : "horizontal";
      const lineWidthNumber = Number(row.lineWidth ?? 1.5);
      return {
        refLineId: Number.isFinite(Number(row.refLineId)) ? Number(row.refLineId) : null,
        lineType,
        lineLabel: typeof row.lineLabel === "string" ? row.lineLabel : null,
        lineValue: Number.isFinite(Number(row.lineValue)) ? Number(row.lineValue) : null,
        lineDate: typeof row.lineDate === "string" ? row.lineDate : null,
        lineColor: typeof row.lineColor === "string" ? row.lineColor : null,
        lineWidth: Number.isFinite(lineWidthNumber) && lineWidthNumber > 0 ? lineWidthNumber : 1.5,
        lineDash: typeof row.lineDash === "string" ? row.lineDash : null,
        displayOrder: Number.isFinite(Number(row.displayOrder)) ? Number(row.displayOrder) : index,
      };
    })
    .filter((item): item is Record<string, unknown> => item !== null);
};

export async function GET(
  request: Request,
  context: { params: Promise<{ chartId: string }> },
) {
  const { chartId: chartIdRaw } = await context.params;
  const chartId = Number(chartIdRaw);
  if (!Number.isFinite(chartId)) {
    return NextResponse.json(
      { ok: false, error: "유효한 그래프 ID가 필요합니다." },
      { status: 400 },
    );
  }

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
    const chartResult = await client.query(
      `
        select
          chart_id,
          chart_name,
          chart_type,
          series_ids,
          series_axis_map,
          reference_lines,
          is_public,
          created_by,
          created_at,
          updated_at
        from dp.viz_chart_cfg
        where chart_id = $1 and is_active = true
      `,
      [chartId],
    );
    if (!chartResult.rowCount) {
      return NextResponse.json({ ok: false, error: "그래프를 찾을 수 없습니다." }, { status: 404 });
    }

    const chartRow = chartResult.rows[0] as {
      chart_id: number;
      chart_name: string;
      chart_type: string;
      series_ids: string[];
      series_axis_map: Record<string, string> | null;
      reference_lines: unknown;
      is_public: boolean;
      created_by: string | null;
      created_at: Date;
      updated_at: Date;
    };

    const seriesIds = Array.isArray(chartRow.series_ids) ? chartRow.series_ids : [];
    const axisMap = (chartRow.series_axis_map ?? {}) as Record<string, string>;

    const mapIds = seriesIds
      .map((seriesId) => parseMapIdFromSeriesId(seriesId))
      .filter((mapId): mapId is number => mapId != null);

    let mappingRows: Array<{
      map_id: number;
      series_name: string;
      unit_name: string | null;
      freq: string | null;
    }> = [];
    let pointRows: Array<{ map_id: number; obs_date: unknown; obs_value: unknown }> = [];

    if (mapIds.length > 0) {
      const mappingResult = await client.query(
        `
          select map_id, series_name, unit_name, freq
          from dp.viz_map_mst
          where map_id = any($1::int[]) and is_active = true
        `,
        [mapIds],
      );
      mappingRows = mappingResult.rows;

      const pointsResult = await client.query(
        `
          select map_id, obs_date, obs_value
          from dp.viz_map_data
          where map_id = any($1::int[])
          order by obs_date asc
        `,
        [mapIds],
      );
      pointRows = pointsResult.rows;
    }

    const mappingById = new Map(mappingRows.map((row) => [Number(row.map_id), row]));
    const pointsById = new Map<number, Array<{ obsDate: string; obsValue: number }>>();
    for (const row of pointRows) {
      const mapId = Number(row.map_id);
      const next = pointsById.get(mapId) ?? [];
      next.push({
        obsDate: toDateText(row.obs_date),
        obsValue: Number(row.obs_value ?? 0),
      });
      pointsById.set(mapId, next);
    }

    const series = seriesIds.map((seriesId, index) => {
      const mapId = parseMapIdFromSeriesId(seriesId);
      const mapping = mapId != null ? mappingById.get(mapId) : null;
      const points = mapId != null ? pointsById.get(mapId) ?? [] : [];
      return {
        seriesId,
        seriesName: mapping?.series_name ?? seriesId,
        unitName: mapping?.unit_name ?? null,
        freq: mapping?.freq ?? "M",
        displayOrder: index,
        lineColor: null,
        yAxisSide: axisMap[seriesId] === "right" ? "right" : "left",
        points,
      };
    });

    return NextResponse.json({
      ok: true,
      chart: {
        chartId: Number(chartRow.chart_id),
        chartName: chartRow.chart_name,
        chartType: chartRow.chart_type ?? "line",
        xAxisLabel: null,
        yAxisLabel: null,
        isPublic: Boolean(chartRow.is_public),
        createdBy: chartRow.created_by,
        createdAt: chartRow.created_at.toISOString(),
        updatedAt: chartRow.updated_at.toISOString(),
      },
      series,
      referenceLines: normalizeReferenceLines(chartRow.reference_lines),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "그래프 상세를 불러오지 못했습니다.";
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ chartId: string }> },
) {
  const { chartId: chartIdRaw } = await context.params;
  const chartId = Number(chartIdRaw);
  if (!Number.isFinite(chartId)) {
    return NextResponse.json(
      { ok: false, error: "유효한 그래프 ID가 필요합니다." },
      { status: 400 },
    );
  }

  const connectionString = await resolveConnectionString(request);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    chartName?: string;
    seriesIds?: string[];
    seriesOptions?: Array<{ seriesId?: string; yAxisSide?: string }>;
    referenceLines?: unknown;
  } | null;

  const chartName = payload?.chartName?.trim();
  const seriesIds = (payload?.seriesIds ?? [])
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  const axisMap = Object.fromEntries(
    seriesIds.map((seriesId) => {
      const option = (payload?.seriesOptions ?? []).find((row) => row.seriesId === seriesId);
      return [seriesId, option?.yAxisSide === "right" ? "right" : "left"];
    }),
  );
  const referenceLines = normalizeReferenceLines(payload?.referenceLines);

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
        update dp.viz_chart_cfg
        set
          chart_name = coalesce($2, chart_name),
          series_ids = case when cardinality($3::text[]) > 0 then $3::text[] else series_ids end,
          series_axis_map = case when cardinality($3::text[]) > 0 then $4::jsonb else series_axis_map end,
          reference_lines = $5::jsonb,
          updated_at = now()
        where chart_id = $1 and is_active = true
      `,
      [
        chartId,
        chartName && chartName.length > 0 ? chartName : null,
        seriesIds,
        JSON.stringify(axisMap),
        JSON.stringify(referenceLines),
      ],
    );

    if (!result.rowCount) {
      return NextResponse.json({ ok: false, error: "그래프를 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "그래프 저장에 실패했습니다.";
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

export async function DELETE(
  request: Request,
  context: { params: Promise<{ chartId: string }> },
) {
  const { chartId: chartIdRaw } = await context.params;
  const chartId = Number(chartIdRaw);
  if (!Number.isFinite(chartId)) {
    return NextResponse.json(
      { ok: false, error: "유효한 그래프 ID가 필요합니다." },
      { status: 400 },
    );
  }

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
    const updated = await client.query(
      `
        update dp.viz_chart_cfg
        set is_active = false, updated_at = now()
        where chart_id = $1 and is_active = true
      `,
      [chartId],
    );
    if (!updated.rowCount) {
      return NextResponse.json({ ok: false, error: "그래프를 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "그래프 삭제에 실패했습니다.";
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