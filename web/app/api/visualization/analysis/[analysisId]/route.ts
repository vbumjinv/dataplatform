import { NextResponse } from "next/server";
import { Client } from "pg";
import {
  fetchMappings,
  fetchPointsForMapping,
  parseMapIdFromSeriesId,
  toSeriesIdFromMapId,
} from "../../_lib/mapping-query";

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

type AnalysisUpdatePayload = {
  chartName?: string;
  seriesIds?: string[];
  analysisLayout?: unknown;
  analysisConfig?: unknown;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ analysisId: string }> },
) {
  const params = await context.params;
  const analysisId = Number(params.analysisId);
  if (!Number.isFinite(analysisId) || analysisId <= 0) {
    return NextResponse.json({ ok: false, error: "analysisId가 올바르지 않습니다." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
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
    const analysisResult = await client.query(
      `
        select analysis_id, analysis_name, is_public, created_by, config_json, created_at, updated_at
        from dp.viz_analysis
        where analysis_id = $1
        limit 1
      `,
      [analysisId],
    );
    if (!analysisResult.rowCount) {
      return NextResponse.json({ ok: false, error: "분석을 찾을 수 없습니다." }, { status: 404 });
    }
    const analysisRow = analysisResult.rows[0];
    const analysisSeriesResult = await client.query(
      `
        select
          series_id,
          display_order
        from dp.viz_analysis_series
        where analysis_id = $1
        order by display_order asc, series_id asc
      `,
      [analysisId],
    );
    const analysisSeriesRows = analysisSeriesResult.rows.map((row) => ({
      seriesId: (row.series_id as string) ?? "",
      displayOrder: Number(row.display_order ?? 0),
    }));
    const mapIds = Array.from(
      new Set(
        analysisSeriesRows
          .map((item) => parseMapIdFromSeriesId(item.seriesId))
          .filter((value): value is number => value != null),
      ),
    );
    const mappings = await fetchMappings(client, mapIds);
    const mappingBySeriesId = new Map(
      mappings.map((item) => [toSeriesIdFromMapId(item.mapId), item] as const),
    );
    const layoutResult = await client.query(
      `
        select layout_json
        from dp.viz_analysis_widget_layout
        where analysis_id = $1
        limit 1
      `,
      [analysisId],
    );
    const pointsBySeries = new Map<string, Array<{ obsDate: string; obsValue: number }>>();
    for (const item of analysisSeriesRows) {
      const mapping = mappingBySeriesId.get(item.seriesId);
      if (!mapping) {
        pointsBySeries.set(item.seriesId, []);
        continue;
      }
      const points = await fetchPointsForMapping(client, mapping);
      pointsBySeries.set(item.seriesId, points);
    }
    return NextResponse.json({
      ok: true,
      chart: {
        chartId: Number(analysisRow.analysis_id),
        chartName: analysisRow.analysis_name as string,
        chartType: "analysis",
        isPublic: Boolean(analysisRow.is_public),
        createdBy: (analysisRow.created_by as string | null) ?? null,
        analysisConfig: analysisRow.config_json ?? {},
        createdAt: (analysisRow.created_at as Date).toISOString(),
        updatedAt: (analysisRow.updated_at as Date).toISOString(),
        analysisLayout: layoutResult.rows[0]?.layout_json ?? [],
      },
      series: analysisSeriesRows.map((row) => {
        const mapping = mappingBySeriesId.get(row.seriesId);
        return {
          seriesId: row.seriesId,
          seriesName: mapping?.seriesName ?? "(미존재 매핑)",
          unitName: mapping?.unitName ?? null,
          freq: mapping?.freq ?? "M",
          displayOrder: row.displayOrder,
          lineColor: null,
          yAxisSide: "left",
          points: pointsBySeries.get(row.seriesId) ?? [],
        };
      }),
      referenceLines: [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "분석 상세를 불러오지 못했습니다.";
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
  context: { params: Promise<{ analysisId: string }> },
) {
  const params = await context.params;
  const analysisId = Number(params.analysisId);
  if (!Number.isFinite(analysisId) || analysisId <= 0) {
    return NextResponse.json({ ok: false, error: "analysisId가 올바르지 않습니다." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }
  let payload: AnalysisUpdatePayload | null = null;
  try {
    payload = (await request.json()) as AnalysisUpdatePayload;
  } catch {
    return NextResponse.json({ ok: false, error: "요청 본문이 비어있습니다." }, { status: 400 });
  }
  if (!isNonEmpty(payload?.chartName)) {
    return NextResponse.json({ ok: false, error: "분석 이름을 입력하세요." }, { status: 400 });
  }
  const hasSeriesPayload = Array.isArray(payload?.seriesIds);
  const hasLayoutPayload = payload && Object.prototype.hasOwnProperty.call(payload, "analysisLayout");
  const hasConfigPayload = payload && Object.prototype.hasOwnProperty.call(payload, "analysisConfig");
  const seriesIds = hasSeriesPayload
    ? Array.from(new Set((payload?.seriesIds ?? []).map((id) => id.trim()).filter(Boolean)))
    : [];
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("DB 연결 시간이 초과되었습니다.")), CONNECT_TIMEOUT_MS);
      }),
    ]);
    await client.query("begin");
    const result = await client.query(
      `
        update dp.viz_analysis
        set analysis_name = $2,
            config_json = case when $3::boolean then $4::jsonb else config_json end
        where analysis_id = $1
        returning analysis_id
      `,
      [analysisId, payload.chartName.trim(), hasConfigPayload, JSON.stringify(payload?.analysisConfig ?? {})],
    );
    if (!result.rowCount) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "분석을 찾을 수 없습니다." }, { status: 404 });
    }
    if (hasSeriesPayload) {
      await client.query(`delete from dp.viz_analysis_series where analysis_id = $1`, [analysisId]);
      if (seriesIds.length) {
        const values: Array<string | number> = [];
        const rows = seriesIds
          .map((seriesId, index) => {
            const base = index * 3;
            values.push(analysisId, seriesId, index);
            return `($${base + 1}, $${base + 2}, $${base + 3})`;
          })
          .join(", ");
        await client.query(
          `
            insert into dp.viz_analysis_series (analysis_id, series_id, display_order)
            values ${rows}
          `,
          values,
        );
      }
    }
    if (hasLayoutPayload) {
      await client.query(
        `
          insert into dp.viz_analysis_widget_layout (analysis_id, layout_json)
          values ($1, $2::jsonb)
          on conflict (analysis_id) do update
          set layout_json = excluded.layout_json
        `,
        [analysisId, JSON.stringify(payload?.analysisLayout ?? [])],
      );
    }
    await client.query("commit");
    return NextResponse.json({ ok: true, chartId: analysisId });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    const message = error instanceof Error ? error.message : "분석 저장에 실패했습니다.";
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
  _request: Request,
  context: { params: Promise<{ analysisId: string }> },
) {
  const params = await context.params;
  const analysisId = Number(params.analysisId);
  if (!Number.isFinite(analysisId) || analysisId <= 0) {
    return NextResponse.json({ ok: false, error: "analysisId가 올바르지 않습니다." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
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
    await client.query("begin");
    const result = await client.query(
      `
        delete from dp.viz_analysis
        where analysis_id = $1
        returning analysis_id
      `,
      [analysisId],
    );
    if (!result.rowCount) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "분석을 찾을 수 없습니다." }, { status: 404 });
    }
    await client.query("commit");
    return NextResponse.json({ ok: true, chartId: analysisId });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    const message = error instanceof Error ? error.message : "분석 삭제에 실패했습니다.";
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
