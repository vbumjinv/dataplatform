import { NextResponse } from "next/server";
import cron from "node-cron";
import { resolveNewsDateToken } from "../../_lib/news-date-token";
import { refreshDartSchedule } from "../../_lib/dart-scheduler";
import { readDartSource, saveDartSource, type DartScheduleType } from "../../_lib/dart-source";

export const runtime = "nodejs";

const parseDbSettingId = (value: unknown) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return null;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const setting = await readDartSource(parseDbSettingId(url.searchParams.get("dbSettingId")));
    return NextResponse.json({ ok: true, setting });
  } catch (error) {
    const message = error instanceof Error ? error.message : "DART 설정을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  let payload: {
    dbSettingId?: unknown;
    startExpr?: string;
    endExpr?: string;
    apiKey?: string;
    schedule?: {
      enabled?: boolean;
      type?: string;
      intervalMinutes?: number | null;
      cronExpr?: string | null;
    };
  } = {};
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    payload = {};
  }
  const settingId = parseDbSettingId(payload.dbSettingId);
  const patch: {
    startExpr?: string;
    endExpr?: string;
    scheduleEnabled?: boolean;
    scheduleType?: DartScheduleType;
    scheduleIntervalMinutes?: number | null;
    scheduleCronExpr?: string;
    apiKey?: string;
  } = {};
  if (typeof payload.apiKey === "string") {
    patch.apiKey = payload.apiKey.trim();
  }
  if (typeof payload.startExpr === "string" || typeof payload.endExpr === "string") {
    const startExpr = (payload.startExpr ?? "").trim();
    const endExpr = (payload.endExpr ?? "").trim();
    if (!resolveNewsDateToken(startExpr) || !resolveNewsDateToken(endExpr)) {
      return NextResponse.json(
        { ok: false, error: "날짜를 확인하세요. YYYY-MM-DD, __TODAY__, __TODAY_MINUS_1D__ 를 사용할 수 있습니다." },
        { status: 400 },
      );
    }
    patch.startExpr = startExpr;
    patch.endExpr = endExpr;
  }
  if (payload.schedule) {
    const enabled = Boolean(payload.schedule.enabled);
    const type: DartScheduleType = payload.schedule.type === "interval" ? "interval" : "cron";
    const intervalMinutes = type === "interval" ? Math.max(1, Number(payload.schedule.intervalMinutes) || 0) : null;
    const cronExpr = type === "cron" ? (payload.schedule.cronExpr ?? "").trim() : "";
    if (enabled && type === "interval" && !intervalMinutes) {
      return NextResponse.json({ ok: false, error: "실행 주기(분)를 입력하세요." }, { status: 400 });
    }
    if (enabled && type === "cron" && !cronExpr) {
      return NextResponse.json({ ok: false, error: "CRON 표현식을 입력하세요." }, { status: 400 });
    }
    if (enabled && type === "cron" && !cron.validate(cronExpr)) {
      return NextResponse.json({ ok: false, error: "CRON 표현식을 확인하세요." }, { status: 400 });
    }
    patch.scheduleEnabled = enabled;
    patch.scheduleType = type;
    patch.scheduleIntervalMinutes = intervalMinutes;
    patch.scheduleCronExpr = cronExpr;
  }
  try {
    const setting = await saveDartSource(patch, settingId);
    await refreshDartSchedule();
    return NextResponse.json({ ok: true, setting });
  } catch (error) {
    const message = error instanceof Error ? error.message : "DART 설정을 저장하지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
