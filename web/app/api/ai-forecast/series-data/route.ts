import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";
import type { SeriesMeta, TimeSeriesPoint } from "../_lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const seriesId = (url.searchParams.get("seriesId") ?? "").trim();
  if (!seriesId) {
    return NextResponse.json(
      { ok: false, error: "seriesId가 필요합니다." },
      { status: 400 },
    );
  }

  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const client = createDbClient();
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    await connectWithTimeout(client);
    const metaResult = await client.query(
      `
        select
          series_id,
          series_name_ko,
          unit_name,
          freq_cd,
          domain_large,
          domain_small,
          is_representative
        from dp.ts_monthly_series_mst
        where series_id = $1
        limit 1
      `,
      [seriesId],
    );
    if (!metaResult.rowCount) {
      return NextResponse.json(
        { ok: false, error: "시계열 메타를 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const dataResult = await client.query(
      `
        select
          base_date::text as base_date,
          value_num
        from dp.ts_monthly_series_data
        where series_id = $1
          and value_num is not null
        order by base_date asc
      `,
      [seriesId],
    );

    const metaRow = metaResult.rows[0];
    const meta: SeriesMeta = {
      seriesId: String(metaRow.series_id),
      seriesNameKo: (metaRow.series_name_ko as string | null) ?? null,
      unitName: (metaRow.unit_name as string | null) ?? null,
      freqCd: (metaRow.freq_cd as string | null) ?? null,
      domainLarge: (metaRow.domain_large as string | null) ?? null,
      domainSmall: (metaRow.domain_small as string | null) ?? null,
      isRepresentative: String(metaRow.is_representative ?? "N") === "Y",
    };
    const points: TimeSeriesPoint[] = dataResult.rows.map((row) => ({
      ds: String(row.base_date).slice(0, 10),
      y: Number(row.value_num),
    }));
    const latest = points.length ? points[points.length - 1] : null;

    return NextResponse.json({
      ok: true,
      meta,
      points,
      latest,
      count: points.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "시계열 데이터 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

