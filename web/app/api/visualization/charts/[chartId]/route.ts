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

type ChartReferenceLinePayload = {
  lineType?: "horizontal" | "vertical";
  lineLabel?: string | null;
  lineValue?: number | string | null;
  lineDate?: string | null;
  lineColor?: string | null;
  lineWidth?: number | string | null;
  lineDash?: string | null;
};

type ChartSeriesOptionPayload = {
  seriesId?: string;
  yAxisSide?: "left" | "right" | string | null;
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

export async function GET(
  _request: Request,
  context: { params: Promise<{ chartId: string }> },
) {
  const params = await context.params;
  const chartId = Number(params.chartId);
  if (!Number.isFinite(chartId) || chartId <= 0) {
    return NextResponse.json(
      { ok: false, error: "chartId가 올바르지 않습니다." },
      { status: 400 },
    );
  }
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

    const chartResult = await client.query(
      `
        select
          chart_id,
          chart_name,
          chart_type,
          x_axis_label,
          y_axis_label,
          is_public,
          created_by,
          created_at,
          updated_at
        from dp.viz_chart
        where chart_id = $1
        limit 1
      `,
      [chartId],
    );
    if (!chartResult.rowCount) {
      return NextResponse.json(
        { ok: false, error: "그래프를 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    const chartRow = chartResult.rows[0];
    const chartSeriesResult = await client.query(
      `
        select
          cs.series_id,
          cs.display_order,
          cs.line_color,
          cs.y_axis_side
        from dp.viz_chart_series cs
        where cs.chart_id = $1
        order by cs.display_order asc, cs.series_id asc
      `,
      [chartId],
    );

    const chartSeriesRows = chartSeriesResult.rows.map((row) => ({
      seriesId: (row.series_id as string) ?? "",
      displayOrder: Number(row.display_order ?? 0),
      lineColor: (row.line_color as string | null) ?? null,
      yAxisSide: (row.y_axis_side as string) || "left",
    }));
    const mapIds = Array.from(
      new Set(
        chartSeriesRows
          .map((item) => parseMapIdFromSeriesId(item.seriesId))
          .filter((value): value is number => value != null),
      ),
    );
    const mappings = await fetchMappings(client, mapIds);
    const mappingBySeriesId = new Map(
      mappings.map((item) => [toSeriesIdFromMapId(item.mapId), item] as const),
    );

    const refLineResult = await client.query(
      `
        select
          ref_line_id,
          line_type,
          line_label,
          line_value,
          line_date::text as line_date,
          line_color,
          line_width,
          line_dash,
          display_order
        from dp.viz_chart_ref_line
        where chart_id = $1
        order by display_order asc, ref_line_id asc
      `,
      [chartId],
    );

    const pointsBySeries = new Map<string, Array<{ obsDate: string; obsValue: number }>>();
    for (const item of chartSeriesRows) {
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
        chartId: Number(chartRow.chart_id),
        chartName: chartRow.chart_name as string,
        chartType: chartRow.chart_type as string,
        xAxisLabel: (chartRow.x_axis_label as string | null) ?? null,
        yAxisLabel: (chartRow.y_axis_label as string | null) ?? null,
        isPublic: Boolean(chartRow.is_public),
        createdBy: (chartRow.created_by as string | null) ?? null,
        createdAt: (chartRow.created_at as Date).toISOString(),
        updatedAt: (chartRow.updated_at as Date).toISOString(),
      },
      series: chartSeriesRows.map((row) => {
        const mapping = mappingBySeriesId.get(row.seriesId);
        return {
          seriesId: row.seriesId,
          seriesName: mapping?.seriesName ?? "(미존재 매핑)",
          unitName: mapping?.unitName ?? null,
          freq: mapping?.freq ?? "M",
          displayOrder: row.displayOrder,
          lineColor: row.lineColor,
          yAxisSide: row.yAxisSide,
          points: pointsBySeries.get(row.seriesId) ?? [],
        };
      }),
      referenceLines: refLineResult.rows.map((row) => ({
        refLineId: Number(row.ref_line_id),
        lineType: row.line_type as "horizontal" | "vertical",
        lineLabel: (row.line_label as string | null) ?? null,
        lineValue: row.line_value === null ? null : Number(row.line_value),
        lineDate: toDateText(row.line_date),
        lineColor: (row.line_color as string | null) ?? null,
        lineWidth: Number(row.line_width ?? 1.2),
        lineDash: (row.line_dash as string | null) ?? "6 4",
        displayOrder: Number(row.display_order ?? 0),
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "그래프 상세를 불러오지 못했습니다.";
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

type ChartUpdatePayload = {
  chartName?: string;
  seriesIds?: string[];
  seriesOptions?: ChartSeriesOptionPayload[];
  referenceLines?: ChartReferenceLinePayload[];
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ chartId: string }> },
) {
  const params = await context.params;
  const chartId = Number(params.chartId);
  if (!Number.isFinite(chartId) || chartId <= 0) {
    return NextResponse.json(
      { ok: false, error: "chartId가 올바르지 않습니다." },
      { status: 400 },
    );
  }
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

  let payload: ChartUpdatePayload | null = null;
  try {
    payload = (await request.json()) as ChartUpdatePayload;
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
  const hasSeriesPayload = Array.isArray(payload?.seriesIds) || Array.isArray(payload?.seriesOptions);
  const hasReferenceLinesPayload = Array.isArray(payload?.referenceLines);
  const seriesItems = hasSeriesPayload
    ? parseSeriesOptions(payload?.seriesIds, payload?.seriesOptions)
    : [];
  const referenceLines = hasReferenceLinesPayload ? parseReferenceLines(payload?.referenceLines ?? []) : [];
  if (hasSeriesPayload && !seriesItems.length) {
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
    const result = await client.query(
      `
        update dp.viz_chart
        set chart_name = $2
        where chart_id = $1
        returning chart_id
      `,
      [chartId, payload.chartName.trim()],
    );
    if (!result.rowCount) {
      await client.query("rollback");
      return NextResponse.json(
        { ok: false, error: "그래프를 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    if (hasSeriesPayload) {
      await client.query(
        `
          delete from dp.viz_chart_series
          where chart_id = $1
        `,
        [chartId],
      );

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
    }

    if (hasReferenceLinesPayload) {
      await client.query(
        `
          delete from dp.viz_chart_ref_line
          where chart_id = $1
        `,
        [chartId],
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
      error instanceof Error ? error.message : "그래프 수정에 실패했습니다.";
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
  context: { params: Promise<{ chartId: string }> },
) {
  const params = await context.params;
  const chartId = Number(params.chartId);
  if (!Number.isFinite(chartId) || chartId <= 0) {
    return NextResponse.json(
      { ok: false, error: "chartId가 올바르지 않습니다." },
      { status: 400 },
    );
  }
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

    await client.query("begin");
    await client.query(
      `
        delete from dp.viz_chart_series
        where chart_id = $1
      `,
      [chartId],
    );
    const deleted = await client.query(
      `
        delete from dp.viz_chart
        where chart_id = $1
        returning chart_id
      `,
      [chartId],
    );
    if (!deleted.rowCount) {
      await client.query("rollback");
      return NextResponse.json(
        { ok: false, error: "그래프를 찾을 수 없습니다." },
        { status: 404 },
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
      error instanceof Error ? error.message : "그래프 삭제에 실패했습니다.";
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

