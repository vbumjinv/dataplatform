import { NextResponse } from "next/server";

export const runtime = "nodejs";

// UN Population Division Data Portal - 공개 메타데이터 엔드포인트(토큰 불필요).
// 지역 목록은 100건씩 페이지네이션되므로 nextPage 를 따라가며 전량 수집한다.
const UNDP_API_BASE = "https://population.un.org/dataportalapi/api/v1";
const FETCH_TIMEOUT_MS = 20000;
const MAX_PAGES = 50;

type UndpPagedResponse = {
  nextPage?: string | null;
  data?: unknown;
};

// nextPage 는 http:// 절대 URL 로 내려오는 경우가 있어 https 로 정규화한다.
const toHttps = (raw: string) => raw.replace(/^http:\/\//i, "https://");

const fetchAllPages = async (firstUrl: string): Promise<Record<string, unknown>[]> => {
  const rows: Record<string, unknown>[] = [];
  let nextUrl: string | null = firstUrl;
  let guard = 0;
  while (nextUrl && guard < MAX_PAGES) {
    guard += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let payload: UndpPagedResponse;
    try {
      const response = await fetch(nextUrl, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`UN API 응답 오류(${response.status})`);
      }
      payload = (await response.json()) as UndpPagedResponse;
    } finally {
      clearTimeout(timer);
    }
    const pageRows = Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>[])
      : [];
    rows.push(...pageRows);
    const next = payload.nextPage;
    nextUrl = typeof next === "string" && next.trim() ? toHttps(next.trim()) : null;
  }
  return rows;
};

export async function GET() {
  try {
    const rows = await fetchAllPages(`${UNDP_API_BASE}/locations/`);
    const items = rows
      .map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        iso3: String(row.iso3 ?? ""),
        iso2: String(row.iso2 ?? ""),
      }))
      .filter((item) => item.id && item.name)
      .sort((a, b) => a.name.localeCompare(b.name, "en"));

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "UN 지역 목록을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
