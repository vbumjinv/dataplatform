import { NextResponse } from "next/server";
import { appendForecastLog } from "../../kospi-forecast/_lib/run-log";
import { executeKospiForecast5, isTimePoint, resolveForecastDate } from "../_lib/execute";

export const runtime = "nodejs";
export const maxDuration = 3600;

type RunBody = {
  runDate?: string;
  autoDate?: boolean;
  timePoint?: string;
  dbSettingId?: number | string | null;
  llm?: boolean;
};

export async function POST(request: Request) {
  let body: RunBody = {};
  try {
    body = (await request.json()) as RunBody;
  } catch {
    body = {};
  }

  const requestedDate = resolveForecastDate(body.runDate);
  const followClock = body.autoDate === true;
  const timePoint = typeof body.timePoint === "string" ? body.timePoint.trim().toUpperCase() : "";
  if (!isTimePoint(timePoint)) {
    return NextResponse.json({ ok: false, error: "예측 시점은 W0, W2 중 하나여야 합니다." }, { status: 400 });
  }
  if (!followClock && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return NextResponse.json({ ok: false, error: "실행일을 YYYY-MM-DD 형식으로 입력하세요." }, { status: 400 });
  }
  const settingId = Number(body.dbSettingId);
  if (!Number.isFinite(settingId) || settingId <= 0) {
    return NextResponse.json({ ok: false, error: "DB 연결을 선택하세요." }, { status: 400 });
  }

  const startedAt = new Date().toISOString();
  const llm = body.llm === true;
  try {
    const result = await executeKospiForecast5({
      timePoint,
      runDate: followClock ? "" : requestedDate,
      autoDate: followClock,
      dbSettingId: Math.trunc(settingId),
      llm,
    });
    const saved = await appendForecastLog({
      timePoint,
      trigger: "manual",
      target: result.target,
      llm,
      status: "success",
      startedAt,
      output: result.output,
      dbSettingId: Math.trunc(settingId),
    });
    return NextResponse.json({ ok: true, ...result, logError: saved.dbError });
  } catch (error) {
    const message = error instanceof Error ? error.message : "5거래일 예측 실행에 실패했습니다.";
    const saved = await appendForecastLog({
      timePoint,
      trigger: "manual",
      target: "",
      llm,
      status: "failure",
      startedAt,
      output: message.slice(-12000),
      dbSettingId: Math.trunc(settingId),
    });
    if (saved.dbError) console.error("[kospi-forecast5] 실패 로그 DB 저장:", saved.dbError);
    return NextResponse.json({ ok: false, error: message.slice(-4000), logError: saved.dbError }, { status: 500 });
  }
}
