import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../../../_lib/db";
import { buildMapDataForMapping, fetchMappings } from "../../../_lib/mapping-query";

export const runtime = "nodejs";

type GeneratePayload = {
  mode?: "generate" | "regenerate";
};

export async function POST(
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

  let payload: GeneratePayload = {};
  try {
    payload = (await request.json()) as GeneratePayload;
  } catch {
    payload = {};
  }
  const mode = payload.mode === "regenerate" ? "regenerate" : "generate";

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
    const result = await buildMapDataForMapping(client, mapping, {
      replaceExisting: mode === "regenerate",
    });
    return NextResponse.json({
      ok: true,
      mapId,
      mode,
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "데이터 생성에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

