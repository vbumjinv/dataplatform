import { NextResponse } from "next/server";
import { connectWithTimeout, createPipelineClientFromRequest } from "../../_lib/db";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId: raw } = await context.params;
  const pipelineId = Number(raw);
  if (!Number.isFinite(pipelineId)) {
    return NextResponse.json({ ok: false, error: "잘못된 파이프라인 ID 입니다." }, { status: 400 });
  }
  const client = await createPipelineClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `select run_log_id, trigger_type, status, started_at, finished_at, elapsed_ms, step_results, error_message
       from dp.api_pipeline_run_log
       where pipeline_id = $1
       order by started_at desc
       limit 20`,
      [Math.trunc(pipelineId)],
    );
    return NextResponse.json({ ok: true, runs: result.rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "실행 이력 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
