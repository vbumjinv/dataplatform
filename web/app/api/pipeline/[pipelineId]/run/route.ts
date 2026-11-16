import { NextResponse } from "next/server";
import { parseDbSettingIdFromRequest } from "../../_lib/db";
import { runPipeline } from "../../_lib/pipeline-runner";

export const runtime = "nodejs";
// 뉴스 수집+LLM 가공까지 한 번에 돌릴 수 있어 여유 있게
export const maxDuration = 3600;

export async function POST(
  request: Request,
  context: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId: raw } = await context.params;
  const pipelineId = Number(raw);
  if (!Number.isFinite(pipelineId)) {
    return NextResponse.json({ ok: false, error: "잘못된 파이프라인 ID 입니다." }, { status: 400 });
  }
  try {
    const dbSettingId = parseDbSettingIdFromRequest(request);
    const result = await runPipeline(Math.trunc(pipelineId), "manual", { dbSettingId });
    return NextResponse.json({ ok: result.ok, stepResults: result.stepResults });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파이프라인 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
