import { NextResponse } from "next/server";
import { resolveNewsDateToken } from "../_lib/news-date-token";
import { readNytArticles, readNytJob, startNytNewsJob } from "../_lib/nyt-news";

export const runtime = "nodejs";

const parseDbSettingId = (value: unknown) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return null;
};

const resolveRangeDate = (value: string) => resolveNewsDateToken(value) ?? value;
const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const startDate = resolveRangeDate((url.searchParams.get("startDate") ?? "").trim());
  const endDate = resolveRangeDate((url.searchParams.get("endDate") ?? startDate).trim());
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
    return NextResponse.json(
      { ok: false, error: "날짜를 확인하세요. YYYY-MM-DD, __TODAY__, __TODAY_MINUS_1D__ 를 사용할 수 있습니다." },
      { status: 400 },
    );
  }
  try {
    const snapshot = await readNytArticles(startDate, endDate, parseDbSettingId(url.searchParams.get("dbSettingId")));
    return NextResponse.json({ ok: true, job: readNytJob(), ...snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "NYT 뉴스 현황 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let payload: { startDate?: string; endDate?: string; dbSettingId?: unknown } = {};
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    payload = {};
  }
  const startDate = resolveRangeDate((payload.startDate ?? "").trim());
  const endDate = resolveRangeDate((payload.endDate ?? startDate).trim());
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
    return NextResponse.json(
      { ok: false, error: "날짜를 확인하세요. YYYY-MM-DD, __TODAY__, __TODAY_MINUS_1D__ 를 사용할 수 있습니다." },
      { status: 400 },
    );
  }
  const result = startNytNewsJob(startDate, endDate, parseDbSettingId(payload.dbSettingId));
  if (!result.started) {
    return NextResponse.json({ ok: false, error: "이미 수집이 진행 중입니다.", job: result.job }, { status: 409 });
  }
  return NextResponse.json({ ok: true, job: result.job });
}
