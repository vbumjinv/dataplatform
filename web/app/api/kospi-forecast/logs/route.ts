import { NextResponse } from "next/server";
import { readForecastLogs, readForecastLogsFromDb } from "../_lib/run-log";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const settingId = Number(new URL(request.url).searchParams.get("dbSettingId"));
  if (Number.isFinite(settingId) && settingId > 0) {
    try {
      const logs = await readForecastLogsFromDb(Math.trunc(settingId));
      return NextResponse.json({ ok: true, logs });
    } catch (error) {
      const message = error instanceof Error ? error.message : "수행 로그를 불러오지 못했습니다.";
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  }
  const logs = await readForecastLogs();
  return NextResponse.json({ ok: true, logs });
}
