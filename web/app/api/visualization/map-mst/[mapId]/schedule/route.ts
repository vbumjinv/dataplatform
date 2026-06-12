import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClientFromRequest } from "../../../_lib/db";
import { initializeMapScheduler, refreshMapSchedule } from "../../scheduler";

type SchedulePayload = {
  enabled?: boolean;
  type?: "interval" | "cron";
  intervalMinutes?: number | null;
  cronExpr?: string | null;
};

export const runtime = "nodejs";

const normalizeSchedulePayload = (payload: SchedulePayload) => {
  const enabled = Boolean(payload.enabled);
  const type = payload.type === "cron" ? "cron" : "interval";
  const intervalMinutes = Number.isFinite(payload.intervalMinutes)
    ? Math.max(1, Number(payload.intervalMinutes))
    : 60;
  const cronExpr = (payload.cronExpr ?? "").trim();
  if (enabled && type === "cron" && !cronExpr) {
    throw new Error("CRON 표현식을 입력하세요.");
  }
  return {
    enabled,
    type,
    intervalMinutes: type === "interval" ? intervalMinutes : null,
    cronExpr: type === "cron" ? cronExpr : null,
  };
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ mapId: string }> },
) {
  await initializeMapScheduler();
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

  let payload: SchedulePayload | null = null;
  try {
    payload = (await request.json()) as SchedulePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  let normalized: ReturnType<typeof normalizeSchedulePayload>;
  try {
    normalized = normalizeSchedulePayload(payload ?? {});
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "입력값이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `
        update dp.viz_map_mst
        set
          schedule_enabled = $2,
          schedule_type = $3,
          schedule_interval_minutes = $4,
          schedule_cron_expr = $5,
          updated_at = now()
        where map_id = $1
        returning map_id
      `,
      [
        mapId,
        normalized.enabled,
        normalized.type,
        normalized.intervalMinutes,
        normalized.cronExpr,
      ],
    );
    if (!result.rowCount) {
      return NextResponse.json(
        { ok: false, error: "매핑을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    await refreshMapSchedule(mapId);
    return NextResponse.json({ ok: true, mapId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스케줄 저장에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
