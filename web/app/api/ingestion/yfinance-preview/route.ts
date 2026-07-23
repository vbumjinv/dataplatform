import { NextResponse } from "next/server";

export const runtime = "nodejs";

// yfinance 수집은 Python(yfinance) 실행이라, 등록 마법사 미리보기도 이 라우트가
// 서버 측에서 python-forecast-api(/yfinance)를 호출해 샘플 시세를 돌려준다.
// (Python 서비스 URL을 클라이언트에 노출하지 않기 위해 서버 경유)
const PY_YFINANCE_API_URL =
  process.env.PY_YFINANCE_API_URL ?? "http://127.0.0.1:8001/yfinance";
const PY_YFINANCE_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.PY_YFINANCE_TIMEOUT_MS ?? 60000) || 60000,
);

type YfinanceRow = {
  date?: string;
  close?: number | null;
  adj_close?: number | null;
  ticker?: string;
};

export async function POST(request: Request) {
  let body: { ticker?: string; start?: string; end?: string; interval?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }

  const ticker = (body.ticker ?? "").trim();
  const start = (body.start ?? "").trim();
  const end = (body.end ?? "").trim();
  const interval = (body.interval ?? "1d").trim() || "1d";
  if (!ticker || !start || !end) {
    return NextResponse.json(
      { ok: false, error: "ticker/start/end 를 모두 입력하세요." },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PY_YFINANCE_TIMEOUT_MS);
  try {
    const response = await fetch(PY_YFINANCE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, start, end, interval }),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let parsed: { rows?: YfinanceRow[]; detail?: unknown } | null = null;
    try {
      parsed = JSON.parse(rawBody) as { rows?: YfinanceRow[]; detail?: unknown };
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail =
        typeof parsed?.detail === "string"
          ? parsed.detail
          : parsed?.detail
            ? JSON.stringify(parsed.detail)
            : rawBody || "yfinance 조회에 실패했습니다.";
      return NextResponse.json({ ok: false, error: detail }, { status: 502 });
    }
    return NextResponse.json({ ok: true, rows: parsed?.rows ?? [] });
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
    const message = aborted
      ? `yfinance 응답 시간 초과(${Math.round(PY_YFINANCE_TIMEOUT_MS / 1000)}초). python-forecast-api(8001) 기동을 확인하세요.`
      : `yfinance 호출 실패: ${error instanceof Error ? error.message : String(error)}. python-forecast-api(8001) 기동을 확인하세요.`;
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
