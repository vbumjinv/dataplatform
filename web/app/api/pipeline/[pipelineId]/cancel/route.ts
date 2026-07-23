import { NextResponse } from "next/server";
import { connectWithTimeout, createPipelineClientFromRequest } from "../../_lib/db";
import { getRun } from "../../../_shared/cancel-registry";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId: raw } = await context.params;
  const pipelineId = Number(raw);
  if (!Number.isFinite(pipelineId)) {
    return NextResponse.json({ ok: false, error: "잘못된 파이프라인 ID 입니다." }, { status: 400 });
  }

  const handle = getRun(`pipeline:${Math.trunc(pipelineId)}`);
  if (!handle) {
    return NextResponse.json({
      ok: true,
      cancelled: false,
      message: "이미 종료되었거나 실행 중이 아닌 파이프라인입니다.",
    });
  }

  // 1) 진행 중 작업 abort (API fetch 등)
  try {
    handle.abort.abort();
  } catch {
    // ignore
  }

  // 2) DB 백엔드 쿼리 취소
  let dbCancelRequested = false;
  if (handle.pids.size > 0) {
    const client = await createPipelineClientFromRequest(request);
    if (client) {
      try {
        await connectWithTimeout(client);
        for (const pid of handle.pids) {
          try {
            await client.query("select pg_cancel_backend($1)", [pid]);
            dbCancelRequested = true;
          } catch {
            // ignore individual pid errors
          }
        }
      } catch {
        // ignore
      } finally {
        try {
          await client.end();
        } catch {
          // ignore
        }
      }
    }
  }

  return NextResponse.json({ ok: true, cancelled: true, dbCancelRequested });
}
