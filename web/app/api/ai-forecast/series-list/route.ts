import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";
import type { SeriesMeta } from "../_lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
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

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const representativeOnly = (url.searchParams.get("representativeOnly") ?? "true") !== "false";
  const limit = Math.max(10, Math.min(200, Number(url.searchParams.get("limit") ?? "60") || 60));

  try {
    await connectWithTimeout(client);
    const result = await client.query(
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
        where coalesce(use_yn, 'Y') = 'Y'
          and ($1::boolean = false or coalesce(is_representative, 'N') = 'Y')
          and (
            $2::text = ''
            or series_id ilike '%' || $2 || '%'
            or coalesce(series_name_ko, '') ilike '%' || $2 || '%'
          )
        order by
          case when coalesce(is_representative, 'N') = 'Y' then 0 else 1 end,
          coalesce(sort_ord, 999999),
          series_id
        limit $3
      `,
      [representativeOnly, q, limit],
    );

    const items: SeriesMeta[] = result.rows.map((row) => ({
      seriesId: String(row.series_id),
      seriesNameKo: (row.series_name_ko as string | null) ?? null,
      unitName: (row.unit_name as string | null) ?? null,
      freqCd: (row.freq_cd as string | null) ?? null,
      domainLarge: (row.domain_large as string | null) ?? null,
      domainSmall: (row.domain_small as string | null) ?? null,
      isRepresentative: String(row.is_representative ?? "N") === "Y",
    }));

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "시계열 목록 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

