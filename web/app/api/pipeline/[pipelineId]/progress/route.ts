import { NextResponse } from "next/server";
import { getRun } from "../../../_shared/cancel-registry";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId: raw } = await context.params;
  const pipelineId = Number(raw);
  if (!Number.isFinite(pipelineId)) {
    return NextResponse.json({ ok: false, error: "잘못된 파이프라인 ID 입니다." }, { status: 400 });
  }
  const handle = getRun(`pipeline:${Math.trunc(pipelineId)}`);
  return NextResponse.json({
    ok: true,
    running: Boolean(handle),
    progress: handle?.progress ?? null,
  });
}
