import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient, isNonEmpty } from "../../_lib/db";

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
  isActive?: boolean;
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ mapId: string }> },
) {
  const params = await context.params;
  const mapId = Number(params.mapId);
  if (!Number.isFinite(mapId) || mapId <= 0) {
    return NextResponse.json(
      { ok: false, error: "mapId가 올바르지 않습니다." },
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
        update dp.viz_map_mst
        set
          source_org = $2,
          api_name = $3,
          source_table = $4,
          series_name = $5,
          series_key = $6,
          date_column = $7,
          date_format = $8,
          value_column = $9,
          where_clause = $10,
          unit_name = $11,
          freq = $12,
          is_active = $13,
          updated_at = now()
        where map_id = $1
        returning map_id
      `,
      [
        mapId,
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
        payload?.isActive ?? true,
      ],
    );
    if (!result.rowCount) {
      return NextResponse.json(
        { ok: false, error: "매핑을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, mapId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "매핑 수정에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

