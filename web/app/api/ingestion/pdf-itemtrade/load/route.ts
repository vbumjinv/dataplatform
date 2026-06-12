import { NextResponse } from "next/server";
import { previousReportMonth, runItemTradeLoad } from "../../_lib/pdf-itemtrade-loader";

export const runtime = "nodejs";

type LoadRequest = {
  year?: number | string;
  month?: number | string;
  dbSettingId?: number | string;
};

const toInt = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

export async function POST(request: Request) {
  let payload: LoadRequest = {};
  try {
    payload = (await request.json()) as LoadRequest;
  } catch {
    payload = {};
  }

  const fallback = previousReportMonth();
  const year = toInt(payload.year) ?? fallback.year;
  const month = toInt(payload.month) ?? fallback.month;
  if (month < 1 || month > 12 || year < 2000 || year > 2100) {
    return NextResponse.json(
      { ok: false, error: "연/월 값이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  const settingId = toInt(payload.dbSettingId);

  try {
    const result = await runItemTradeLoad({
      year,
      month,
      settingId,
      triggerType: "manual",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "적재에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
