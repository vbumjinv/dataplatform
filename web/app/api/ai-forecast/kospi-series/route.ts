import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";

export const runtime = "nodejs";

const toPositiveInt = (value: string | null, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : fallback;
};

const dateFmtKst = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const toIsoDateText = (value: unknown) => {
  if (value instanceof Date) return dateFmtKst.format(value);
  const parsed = new Date(String(value));
  if (!Number.isNaN(parsed.getTime())) return dateFmtKst.format(parsed);
  return String(value).slice(0, 10);
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mapId = toPositiveInt(searchParams.get("mapId"), 2);
  const lookbackDays = toPositiveInt(searchParams.get("lookbackDays"), 365);

  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const client = createDbClient();
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `
        SELECT
          obs_date::date AS ds,
          obs_value::numeric(20,8) AS y
        FROM dp.viz_map_data
        WHERE map_id = $1
          AND obs_value IS NOT NULL
          AND obs_date::date >= current_date - ($2::int || ' days')::interval
        ORDER BY obs_date ASC
      `,
      [mapId, lookbackDays],
    );

    return NextResponse.json({
      ok: true,
      mapId,
      lookbackDays,
      points: result.rows.map((row) => ({
        ds: toIsoDateText(row.ds),
        y: Number(row.y),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "코스피 시계열 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
