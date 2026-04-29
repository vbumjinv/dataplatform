import { NextResponse } from "next/server";
import { Client } from "pg";

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

type AnalysisCreatePayload = {
  chartName?: string;
  seriesIds?: string[];
  isPublic?: boolean;
  createdBy?: string;
  analysisLayout?: unknown;
  analysisConfig?: unknown;
};

export async function GET() {
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
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
          a.analysis_id,
          a.analysis_name,
          a.is_public,
          a.created_by,
          a.config_json,
          a.updated_at,
          count(s.series_id)::int as series_count
        from dp.viz_analysis a
        left join dp.viz_analysis_series s on s.analysis_id = a.analysis_id
        group by a.analysis_id, a.analysis_name, a.is_public, a.created_by, a.config_json, a.updated_at
        order by a.updated_at desc, a.analysis_id desc
      `,
    );
    return NextResponse.json({
      ok: true,
      charts: result.rows.map((row) => ({
        chartId: Number(row.analysis_id),
        chartName: row.analysis_name as string,
        chartType: "analysis",
        isPublic: Boolean(row.is_public),
        createdBy: (row.created_by as string | null) ?? null,
        analysisConfig: row.config_json ?? {},
        updatedAt: (row.updated_at as Date).toISOString(),
        seriesCount: Number(row.series_count ?? 0),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "분석 목록을 불러오지 못했습니다.";
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
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  let payload: AnalysisCreatePayload | null = null;
  try {
    payload = (await request.json()) as AnalysisCreatePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }
  if (!isNonEmpty(payload?.chartName)) {
    return NextResponse.json(
      { ok: false, error: "분석 이름을 입력하세요." },
      { status: 400 },
    );
  }
  const seriesIds = Array.from(new Set((payload?.seriesIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (!seriesIds.length) {
    return NextResponse.json(
      { ok: false, error: "시리즈를 1개 이상 선택하세요." },
      { status: 400 },
    );
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("DB 연결 시간이 초과되었습니다.")), CONNECT_TIMEOUT_MS);
      }),
    ]);
    await client.query("begin");
    const created = await client.query(
      `
        insert into dp.viz_analysis (analysis_name, is_public, created_by, config_json)
        values ($1, $2, $3, $4::jsonb)
        returning analysis_id
      `,
      [
        payload.chartName.trim(),
        payload.isPublic ?? false,
        payload.createdBy?.trim() || null,
        JSON.stringify(payload?.analysisConfig ?? {}),
      ],
    );
    const analysisId = Number(created.rows[0]?.analysis_id);
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
    await client.query(
      `
        insert into dp.viz_analysis_widget_layout (analysis_id, layout_json)
        values ($1, $2::jsonb)
        on conflict (analysis_id) do update
        set layout_json = excluded.layout_json
      `,
      [analysisId, JSON.stringify(payload?.analysisLayout ?? [])],
    );
    await client.query("commit");
    return NextResponse.json({ ok: true, chartId: analysisId });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    const message = error instanceof Error ? error.message : "분석 생성에 실패했습니다.";
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
