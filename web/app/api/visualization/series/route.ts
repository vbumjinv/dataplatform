import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";
import {
  fetchMappings,
  fetchPointsForMapping,
  parseMapIdFromSeriesId,
  toSeriesIdFromMapId,
} from "../_lib/mapping-query";

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
  const rawIds = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const ids = rawIds
    .map((seriesId) => parseMapIdFromSeriesId(seriesId))
    .filter((value): value is number => value != null);
  const withPoints = url.searchParams.get("withPoints") === "true";

  try {
    await connectWithTimeout(client);

    const mappings = await fetchMappings(client, ids.length > 0 ? ids : undefined, ids.length === 0);
    const series = mappings.map((item) => ({
      seriesId: toSeriesIdFromMapId(item.mapId),
      sourceOrg: item.sourceOrg,
      sourceTable: item.sourceTable,
      sourceKey: item.seriesKey,
      seriesName: item.seriesName,
      unitName: item.unitName,
      freq: item.freq ?? "M",
      isActive: item.isActive,
    }));

    if (!withPoints || !series.length) {
      return NextResponse.json({ ok: true, series });
    }

    const pointsBySeries = new Map<string, Array<{ obsDate: string; obsValue: number }>>();
    for (const mapping of mappings) {
      const seriesId = toSeriesIdFromMapId(mapping.mapId);
      const points = await fetchPointsForMapping(client, mapping);
      pointsBySeries.set(seriesId, points);
    }

    return NextResponse.json({
      ok: true,
      series: series.map((item) => ({
        ...item,
        points: pointsBySeries.get(item.seriesId) ?? [],
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "시리즈 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

