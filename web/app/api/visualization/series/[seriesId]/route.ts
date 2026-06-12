import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClientFromRequest } from "../../_lib/db";
import { parseMapIdFromSeriesId, toSeriesIdFromMapId } from "../../_lib/mapping-query";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ seriesId: string }> },
) {
  const params = await context.params;
  const seriesId = (params.seriesId ?? "").trim();
  const mapId = parseMapIdFromSeriesId(seriesId);
  if (!mapId) {
    return NextResponse.json(
      { ok: false, error: "seriesId가 올바르지 않습니다." },
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
  try {
    await connectWithTimeout(client);
    await client.query("begin");
    await client.query(
      `
        delete from dp.viz_chart_series
        where series_id = $1
      `,
      [toSeriesIdFromMapId(mapId)],
    );
    await client.query(
      `
        delete from dp.viz_analysis_series
        where series_id = $1
      `,
      [toSeriesIdFromMapId(mapId)],
    );
    const deleted = await client.query(
      `
        delete from dp.viz_map_mst
        where map_id = $1
        returning map_id
      `,
      [mapId],
    );
    if (!deleted.rowCount) {
      await client.query("rollback");
      return NextResponse.json(
        { ok: false, error: "시리즈 매핑을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    await client.query("commit");

    return NextResponse.json({ ok: true, seriesId: toSeriesIdFromMapId(mapId) });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    const message =
      error instanceof Error ? error.message : "파생 시리즈 삭제에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

