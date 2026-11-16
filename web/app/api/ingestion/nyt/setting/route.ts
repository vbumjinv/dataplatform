import { NextResponse } from "next/server";
import cron from "node-cron";
import { resolveNewsDateToken } from "../../_lib/news-date-token";
import { refreshNytSchedule } from "../../_lib/nyt-scheduler";
import { readNytSource, saveNytSource, type NytScheduleType } from "../../_lib/nyt-source";
import { nytKeywordTerms } from "../../_lib/nyt-news";

export const runtime = "nodejs";

const parseDbSettingId = (value: unknown) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return null;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const setting = await readNytSource(parseDbSettingId(url.searchParams.get("dbSettingId")));
    return NextResponse.json({ ok: true, setting });
  } catch (error) {
    const message = error instanceof Error ? error.message : "NYT 설정을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  let payload: {
    dbSettingId?: unknown;
    startExpr?: string;
    endExpr?: string;
    apiKey?: string;
    keywords?: string;
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
    scheduleType?: NytScheduleType;
    scheduleIntervalMinutes?: number | null;
    scheduleCronExpr?: string;
    apiKey?: string;
    keywords?: string;
  } = {};
  if (typeof payload.apiKey === "string") patch.apiKey = payload.apiKey.trim();
  if (typeof payload.keywords === "string") {
    const keywords = payload.keywords
      .split(/[\n,]/)
      .map((term) => term.trim())
      .filter(Boolean)
      .join("\n");
    if (!nytKeywordTerms(keywords).length) {
      return NextResponse.json({ ok: false, error: "키워드를 하나 이상 입력하세요." }, { status: 400 });
    }
    patch.keywords = keywords;
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
    const type: NytScheduleType = payload.schedule.type === "interval" ? "interval" : "cron";
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
    const setting = await saveNytSource(patch, settingId);
    await refreshNytSchedule();
    return NextResponse.json({ ok: true, setting });
  } catch (error) {
    const message = error instanceof Error ? error.message : "NYT 설정을 저장하지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
