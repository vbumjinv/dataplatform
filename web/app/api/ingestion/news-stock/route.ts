import { NextResponse } from "next/server";
import { resolveNewsDateToken } from "../_lib/news-date-token";
import { isCrawlDate, listCrawlDates, readStockNewsDay } from "../_lib/naver-stock-news";
import { readStockNewsJob, startStockNewsJob } from "../_lib/naver-stock-news-job";
import { ensureNewsStockScheduler } from "../_lib/news-stock-scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

const parseDbSettingId = (value: unknown) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return null;
};

const rangeError = (error: unknown) =>
  error instanceof Error ? error.message : "날짜를 확인하세요.";

const resolveRangeDate = (value: string) => resolveNewsDateToken(value) ?? value;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const startRaw = (url.searchParams.get("startDate") ?? url.searchParams.get("date") ?? "").trim();
  const endRaw = (url.searchParams.get("endDate") ?? startRaw).trim();
  const startDate = resolveRangeDate(startRaw);
  const endDate = resolveRangeDate(endRaw);
  if (!isCrawlDate(startDate) || !isCrawlDate(endDate)) {
    return NextResponse.json({ ok: false, error: "날짜를 확인하세요. YYYY-MM-DD, __TODAY__, __TODAY_MINUS_1D__ 를 사용할 수 있습니다." }, { status: 400 });
  }
  try {
    listCrawlDates(startDate, endDate);
  } catch (error) {
    return NextResponse.json({ ok: false, error: rangeError(error) }, { status: 400 });
  }
  try {
    void ensureNewsStockScheduler();
    const snapshot = await readStockNewsDay(
      startDate,
      endDate,
      parseDbSettingId(url.searchParams.get("dbSettingId")),
    );
    return NextResponse.json({ ok: true, job: readStockNewsJob(), ...snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "수집 현황 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let payload: { startDate?: string; endDate?: string; date?: string; dbSettingId?: unknown } = {};
  try {
    payload = (await request.json()) as {
      startDate?: string;
      endDate?: string;
      date?: string;
      dbSettingId?: unknown;
    };
  } catch {
    payload = {};
  }
  const startRaw = (payload.startDate ?? payload.date ?? "").trim();
  const endRaw = (payload.endDate ?? startRaw).trim();
  const startDate = resolveRangeDate(startRaw);
  const endDate = resolveRangeDate(endRaw);
  if (!isCrawlDate(startDate) || !isCrawlDate(endDate)) {
    return NextResponse.json({ ok: false, error: "날짜를 확인하세요. YYYY-MM-DD, __TODAY__, __TODAY_MINUS_1D__ 를 사용할 수 있습니다." }, { status: 400 });
  }
  try {
    listCrawlDates(startDate, endDate);
  } catch (error) {
    return NextResponse.json({ ok: false, error: rangeError(error) }, { status: 400 });
  }
  const result = startStockNewsJob(startDate, endDate, parseDbSettingId(payload.dbSettingId));
  if (!result.started) {
    return NextResponse.json(
      { ok: false, error: "이미 수집이 진행 중입니다.", job: result.job },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, job: result.job });
}
