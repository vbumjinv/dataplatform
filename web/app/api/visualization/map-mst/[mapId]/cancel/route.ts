import { NextResponse } from "next/server";
import { connectWithTimeout, createDbClientFromRequest } from "../../../_lib/db";
import { getRun } from "../../../../_shared/cancel-registry";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ mapId: string }> },
) {
  const { mapId: raw } = await context.params;
  const mapId = Number(raw);
  if (!Number.isFinite(mapId)) {
    return NextResponse.json({ ok: false, error: "mapId가 올바르지 않습니다." }, { status: 400 });
  }

  const handle = getRun(`map:${Math.trunc(mapId)}`);
  if (!handle) {
    return NextResponse.json({
      ok: true,
      cancelled: false,
      message: "이미 종료되었거나 생성 중이 아닌 매핑입니다.",
    });
  }

  try {
    handle.abort.abort();
  } catch {
    // ignore
  }

  let dbCancelRequested = false;
  if (handle.pids.size > 0) {
    const client = await createDbClientFromRequest(request);
    if (client) {
      try {
        await connectWithTimeout(client);
        for (const pid of handle.pids) {
          try {
            await client.query("select pg_cancel_backend($1)", [pid]);
            dbCancelRequested = true;
          } catch {
            // ignore
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
