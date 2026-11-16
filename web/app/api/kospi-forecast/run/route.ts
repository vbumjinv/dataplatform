import { NextResponse } from "next/server";
import { executeKospiForecast, isTimePoint, resolveForecastDate } from "../_lib/execute";
import { appendForecastLog } from "../_lib/run-log";

export const runtime = "nodejs";
export const maxDuration = 3600;

type RunBody = {
  target?: string;
  autoTarget?: boolean;
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

  const requestedTarget = resolveForecastDate(body.target);
  const followClock = body.autoTarget === true;
  const timePoint = typeof body.timePoint === "string" ? body.timePoint.trim().toUpperCase() : "";
  if (!isTimePoint(timePoint)) {
    return NextResponse.json({ ok: false, error: "예측 시점은 T0, T1, T2 중 하나여야 합니다." }, { status: 400 });
  }
  if (!followClock && !/^\d{4}-\d{2}-\d{2}$/.test(requestedTarget)) {
    return NextResponse.json({ ok: false, error: "예측 대상일을 YYYY-MM-DD 형식으로 입력하세요." }, { status: 400 });
  }
  const settingId = Number(body.dbSettingId);
  if (!Number.isFinite(settingId) || settingId <= 0) {
    return NextResponse.json({ ok: false, error: "DB 연결을 선택하세요." }, { status: 400 });
  }

  const startedAt = new Date().toISOString();
  const llm = body.llm === true;
  try {
    const result = await executeKospiForecast({
      timePoint,
      target: followClock ? "" : requestedTarget,
      autoTarget: followClock,
      dbSettingId: Math.trunc(settingId),
      llm,
    });
    await appendForecastLog({
      timePoint,
      trigger: "manual",
      target: result.target,
      llm,
      status: "success",
      startedAt,
      output: result.output,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "코스피 예측 실행에 실패했습니다.";
    await appendForecastLog({
      timePoint,
      trigger: "manual",
      target: requestedTarget,
      llm,
      status: "failure",
      startedAt,
      output: message.slice(-12000),
    });
    return NextResponse.json({ ok: false, error: message.slice(-4000) }, { status: 500 });
  }
}
