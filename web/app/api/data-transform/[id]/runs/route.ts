import { NextResponse } from "next/server";
import { connectWithTimeout, createDbClientFromRequest } from "../../../visualization/_lib/db";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await context.params;
  const transformId = Number(raw);
  if (!Number.isFinite(transformId)) {
    return NextResponse.json({ ok: false, error: "잘못된 가공 ID 입니다." }, { status: 400 });
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `select run_log_id, trigger_type, status, started_at, finished_at,
              elapsed_ms, affected_count, error_message
       from dp.api_transform_run_log
       where transform_id = $1
       order by started_at desc
       limit 20`,
      [Math.trunc(transformId)],
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
