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

type ChartCreatePayload = {
  chartName?: string;
  chartType?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  isPublic?: boolean;
  createdBy?: string;
  seriesIds?: string[];
  seriesOptions?: ChartSeriesOptionPayload[];
  referenceLines?: ChartReferenceLinePayload[];
};

type ChartSeriesOptionPayload = {
  seriesId?: string;
  yAxisSide?: "left" | "right" | string | null;
};

type ChartReferenceLinePayload = {
  lineType?: "horizontal" | "vertical";
  lineLabel?: string | null;
  lineValue?: number | string | null;
  lineDate?: string | null;
  lineColor?: string | null;
  lineWidth?: number | string | null;
  lineDash?: string | null;
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

const parseSeriesOptions = (
  idsInput: unknown,
  optionsInput: unknown,
): Array<{ seriesId: string; yAxisSide: "left" | "right" }> => {
  const result: Array<{ seriesId: string; yAxisSide: "left" | "right" }> = [];
  const seen = new Set<string>();
  const pushItem = (seriesIdRaw: unknown, yAxisSideRaw: unknown) => {
    if (!isNonEmpty(seriesIdRaw)) return;
    const seriesId = seriesIdRaw.trim();
    if (!seriesId || seen.has(seriesId)) return;
    seen.add(seriesId);
    result.push({
      seriesId,
      yAxisSide: yAxisSideRaw === "right" ? "right" : "left",
    });
  };
  if (Array.isArray(optionsInput)) {
    optionsInput.forEach((raw) => {
      if (!raw || typeof raw !== "object") return;
      const item = raw as ChartSeriesOptionPayload;
      pushItem(item.seriesId, item.yAxisSide);
    });
  }
  if (Array.isArray(idsInput)) {
    idsInput.forEach((raw) => pushItem(raw, "left"));
  }
  return result;
};

const parseReferenceLines = (
  input: unknown,
): Array<{
  lineType: "horizontal" | "vertical";
  lineLabel: string | null;
  lineValue: number | null;
  lineDate: string | null;
  lineColor: string | null;
  lineWidth: number;
  lineDash: string | null;
}> => {
  if (!Array.isArray(input)) return [];
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const result: Array<{
    lineType: "horizontal" | "vertical";
    lineLabel: string | null;
    lineValue: number | null;
    lineDate: string | null;
    lineColor: string | null;
    lineWidth: number;
    lineDash: string | null;
  }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as ChartReferenceLinePayload;
    const lineType = item.lineType;
    if (lineType !== "horizontal" && lineType !== "vertical") continue;
    const rawValue =
      typeof item.lineValue === "number"
        ? item.lineValue
        : typeof item.lineValue === "string"
          ? Number(item.lineValue)
          : NaN;
    const lineValue = Number.isFinite(rawValue) ? rawValue : null;
    const lineDate = isNonEmpty(item.lineDate) ? item.lineDate.trim().slice(0, 10) : null;
    if (lineType === "horizontal" && lineValue === null) continue;
    if (lineType === "vertical" && (!lineDate || !datePattern.test(lineDate))) continue;
    const rawWidth =
      typeof item.lineWidth === "number"
        ? item.lineWidth
        : typeof item.lineWidth === "string"
          ? Number(item.lineWidth)
          : NaN;
    const lineWidth = Number.isFinite(rawWidth) ? Math.max(1, Math.min(4, rawWidth)) : 1.2;
    result.push({
      lineType,
      lineLabel: isNonEmpty(item.lineLabel) ? item.lineLabel.trim() : null,
      lineValue,
      lineDate,
      lineColor: isNonEmpty(item.lineColor) ? item.lineColor.trim() : null,
      lineWidth,
      lineDash: isNonEmpty(item.lineDash) ? item.lineDash.trim() : "6 4",
    });
  }
  return result;
};

export async function GET(request: Request) {
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
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    const chartTypeFilter = new URL(request.url).searchParams.get("chartType");
    const result = await client.query(
      `
        select
          c.chart_id,
          c.chart_name,
          c.chart_type,
          c.is_public,
          c.created_by,
          c.updated_at,
          count(cs.series_id)::int as series_count
        from dp.viz_chart c
        left join dp.viz_chart_series cs on cs.chart_id = c.chart_id
        where ($1::text is null or c.chart_type = $1::text)
        group by c.chart_id, c.chart_name, c.chart_type, c.is_public, c.created_by, c.updated_at
        order by c.updated_at desc, c.chart_id desc
      `,
      [chartTypeFilter],
    );
    return NextResponse.json({
      ok: true,
      charts: result.rows.map((row) => ({
        chartId: Number(row.chart_id),
        chartName: row.chart_name as string,
        chartType: row.chart_type as string,
        isPublic: Boolean(row.is_public),
        createdBy: (row.created_by as string | null) ?? null,
        updatedAt: (row.updated_at as Date).toISOString(),
        seriesCount: Number(row.series_count ?? 0),
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "그래프 목록을 불러오지 못했습니다.";
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

  let payload: ChartCreatePayload | null = null;
  try {
    payload = (await request.json()) as ChartCreatePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }
  if (!isNonEmpty(payload?.chartName)) {
    return NextResponse.json(
      { ok: false, error: "그래프 이름을 입력하세요." },
      { status: 400 },
    );
  }
  const seriesItems = parseSeriesOptions(payload?.seriesIds, payload?.seriesOptions);
  const referenceLines = parseReferenceLines(payload?.referenceLines ?? []);
  if (!seriesItems.length) {
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
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    await client.query("begin");
    const created = await client.query(
      `
        insert into dp.viz_chart (
          chart_name,
          chart_type,
          x_axis_label,
          y_axis_label,
          is_public,
          created_by
        )
        values ($1, $2, $3, $4, $5, $6)
        returning chart_id
      `,
      [
        payload.chartName.trim(),
        payload.chartType?.trim() || "line",
        payload.xAxisLabel?.trim() || null,
        payload.yAxisLabel?.trim() || null,
        payload.isPublic ?? false,
        payload.createdBy?.trim() || null,
      ],
    );
    const chartId = Number(created.rows[0]?.chart_id);

    const values: Array<string | number | null> = [];
    const rows = seriesItems
      .map((item, index) => {
        const base = index * 5;
        values.push(
          chartId,
          item.seriesId,
          index,
          null,
          item.yAxisSide,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      })
      .join(", ");

    await client.query(
      `
        insert into dp.viz_chart_series (
          chart_id,
          series_id,
          display_order,
          line_color,
          y_axis_side
        )
        values ${rows}
      `,
      values,
    );

    if (referenceLines.length) {
      const refValues: Array<number | string | null> = [];
      const refRows = referenceLines
        .map((line, index) => {
          const base = index * 9;
          refValues.push(
            chartId,
            line.lineType,
            line.lineLabel,
            line.lineValue,
            line.lineDate,
            line.lineColor,
            line.lineWidth,
            line.lineDash,
            index,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
        })
        .join(", ");
      await client.query(
        `
          insert into dp.viz_chart_ref_line (
            chart_id,
            line_type,
            line_label,
            line_value,
            line_date,
            line_color,
            line_width,
            line_dash,
            display_order
          )
          values ${refRows}
        `,
        refValues,
      );
    }

    await client.query("commit");
    return NextResponse.json({ ok: true, chartId });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    const message =
      error instanceof Error ? error.message : "그래프 생성에 실패했습니다.";
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

