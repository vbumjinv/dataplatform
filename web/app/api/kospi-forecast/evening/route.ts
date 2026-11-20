import { NextResponse } from "next/server";
import { readEveningSchedule, writeEveningSchedule } from "../_lib/evening-schedule";
import { initializeKospiForecastScheduler, refreshKospiForecastScheduler, runEvening } from "../_lib/scheduler";

export const runtime = "nodejs";
export const maxDuration = 3600;

const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const settingIdOf = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
};

export async function GET() {
  await initializeKospiForecastScheduler();
  return NextResponse.json({ ok: true, evening: await readEveningSchedule() });
}

export async function PUT(request: Request) {
  await initializeKospiForecastScheduler();
  let body: { enabled?: boolean; time?: string; dbSettingId?: number | string | null } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const time = typeof body.time === "string" ? body.time.trim() : "";
  if (!isTime(time)) {
    return NextResponse.json({ ok: false, error: "스케줄 시각은 HH:mm 형식이어야 합니다." }, { status: 400 });
  }
  const dbSettingId = settingIdOf(body.dbSettingId);
  if (body.enabled && !dbSettingId) {
    return NextResponse.json({ ok: false, error: "스케줄을 켜려면 DB 연결을 선택하세요." }, { status: 400 });
  }
  const evening = await writeEveningSchedule({
    enabled: Boolean(body.enabled),
    time,
    dbSettingId,
  });
  await refreshKospiForecastScheduler();
  return NextResponse.json({ ok: true, evening });
}

export async function POST(request: Request) {
  await initializeKospiForecastScheduler();
  let body: { dbSettingId?: number | string | null } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const dbSettingId = settingIdOf(body.dbSettingId);
  if (!dbSettingId) {
    return NextResponse.json({ ok: false, error: "DB 연결을 선택하세요." }, { status: 400 });
  }
  const current = await readEveningSchedule();
  const result = await runEvening({ ...current, dbSettingId }, "manual");
  const evening = await readEveningSchedule();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, evening }, { status: 500 });
  }
  return NextResponse.json({ ok: true, evening, output: result.output });
}
