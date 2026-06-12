import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClientFromRequest } from "../../../_lib/db";
import { fetchMappings, fetchPreviewForMapping } from "../../../_lib/mapping-query";

export const runtime = "nodejs";

export async function GET(
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
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const limitText = (url.searchParams.get("limit") ?? "10").trim();
  const limit = Number(limitText);

  try {
    await connectWithTimeout(client);
    const mappings = await fetchMappings(client, [mapId], false);
    const mapping = mappings[0];
    if (!mapping) {
      return NextResponse.json(
        { ok: false, error: "매핑을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    const rows = await fetchPreviewForMapping(client, mapping, Number.isFinite(limit) ? limit : 10);
    return NextResponse.json({
      ok: true,
      mapId,
      rows,
      sampledCount: rows.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "미리보기 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

