import { NextResponse } from "next/server";
import { isTimePoint, type TimePoint } from "../_lib/execute";
import { readPointSchedules, writePointSchedule } from "../_lib/schedule-store";
import { initializeKospiForecastScheduler, refreshKospiForecastScheduler } from "../_lib/scheduler";

export const runtime = "nodejs";

type Body = {
  timePoint?: string;
  enabled?: boolean;
  time?: string;
  llm?: boolean;
  dbSettingId?: number | string | null;
};

export async function GET() {
  await initializeKospiForecastScheduler();
  const points = await readPointSchedules();
  return NextResponse.json({ ok: true, points });
}

export async function PUT(request: Request) {
  await initializeKospiForecastScheduler();
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    body = {};
  }
  const timePoint = typeof body.timePoint === "string" ? body.timePoint.trim().toUpperCase() : "";
  if (!isTimePoint(timePoint)) {
    return NextResponse.json({ ok: false, error: "예측 시점은 T0, T1, T2 중 하나여야 합니다." }, { status: 400 });
  }
  const time = typeof body.time === "string" ? body.time.trim() : "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return NextResponse.json({ ok: false, error: "스케줄 시각은 HH:mm 형식이어야 합니다." }, { status: 400 });
  }
  const settingId = Number(body.dbSettingId);
  const dbSettingId = Number.isFinite(settingId) && settingId > 0 ? Math.trunc(settingId) : null;
  if (body.enabled && !dbSettingId) {
    return NextResponse.json({ ok: false, error: "스케줄을 켜려면 DB 연결을 선택하세요." }, { status: 400 });
  }
  const points = await writePointSchedule(timePoint as TimePoint, {
    enabled: Boolean(body.enabled),
    time,
    llm: body.llm === true,
    dbSettingId,
  });
  await refreshKospiForecastScheduler();
  return NextResponse.json({ ok: true, points });
}
