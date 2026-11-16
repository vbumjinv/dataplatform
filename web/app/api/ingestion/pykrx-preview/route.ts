import { NextResponse } from "next/server";
import { runPykrxCollect } from "../_lib/pykrx-run";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { dataset?: string; start?: string; end?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }

  const dataset = (body.dataset ?? "").trim();
  const start = (body.start ?? "").trim();
  const end = (body.end ?? "").trim();
  if (!dataset || !start || !end) {
    return NextResponse.json(
      { ok: false, error: "dataset/start/end 를 모두 입력하세요." },
      { status: 400 },
    );
  }

  try {
    const rows = await runPykrxCollect({ dataset, start, end, sample: true });
    return NextResponse.json({ ok: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "pykrx 미리보기 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
