import { NextResponse } from "next/server";
import { canUseDb } from "@/app/api/ai-forecast/_lib/db";
import { getMessages, withChatDb } from "@/app/api/ai-forecast-agent/_lib/chat-db";
import { requireAdminSession } from "../_lib/auth";

export const runtime = "nodejs";

// data-agent 세션 목록/메시지 조회. chat 테이블은 forecast 와 공유하므로,
// metadata.app='data-agent' 마커가 있는 세션만 필터한다. userId 는 서버 세션에서 취득.
export async function GET(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
  const userId = String(auth.session.userId);

  try {
    return await withChatDb(async (client) => {
      if (sessionId) {
        const own = await client.query(
          `select 1 from dp.ai_forecast_chat_session
             where session_id = $1::uuid and user_id = $2::text limit 1`,
          [sessionId, userId],
        );
        if (!own.rowCount) {
          return NextResponse.json(
            { ok: false, error: "세션을 찾을 수 없습니다." },
            { status: 404 },
          );
        }
        const messages = await getMessages(client, sessionId, 200);
        return NextResponse.json({ ok: true, sessionId, messages });
      }

      const result = await client.query(
        `
          select s.session_id, s.title, s.last_message_at
          from dp.ai_forecast_chat_session s
          where s.user_id = $1::text
            and s.is_active = true
            and exists (
              select 1 from dp.ai_forecast_chat_message m
              where m.session_id = s.session_id
                and m.metadata->>'app' = 'data-agent'
            )
          order by s.last_message_at desc
          limit 50
        `,
        [userId],
      );
      const sessions = result.rows.map((r) => ({
        sessionId: String(r.session_id),
        title: (r.title as string | null) ?? null,
        lastMessageAt: String(r.last_message_at),
      }));
      return NextResponse.json({ ok: true, sessions });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "세션 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
