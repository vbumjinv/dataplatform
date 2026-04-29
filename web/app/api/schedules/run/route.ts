import { NextResponse } from "next/server";
import { initializeScheduler, triggerSchedule } from "../scheduler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  await initializeScheduler();
  let payload: { id?: string } | null = null;
  try {
    payload = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }
  if (!payload?.id) {
    return NextResponse.json(
      { ok: false, error: "id 파라미터가 필요합니다." },
      { status: 400 },
    );
  }
  try {
    await triggerSchedule(payload.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스케줄 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
