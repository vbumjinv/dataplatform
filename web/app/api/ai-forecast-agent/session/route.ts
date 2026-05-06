import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { canUseDb } from "../../ai-forecast/_lib/db";
import { ensureSession, getMessages, listSessions, withChatDb } from "../_lib/chat-db";

export const runtime = "nodejs";

type SessionPayload = {
  userId?: string;
  sessionId?: string;
  title?: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = (url.searchParams.get("userId") ?? "").trim();
  const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
  const withMessages = (url.searchParams.get("withMessages") ?? "false") === "true";
  if (!userId) {
    return NextResponse.json({ ok: false, error: "userId가 필요합니다." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }

  try {
    return await withChatDb(async (client) => {
      if (sessionId) {
        const session = await ensureSession(client, { sessionId, userId });
        const messages = withMessages ? await getMessages(client, session.sessionId, 200) : [];
        return NextResponse.json({ ok: true, session, messages });
      }
      const sessions = await listSessions(client, userId, 40);
      return NextResponse.json({ ok: true, sessions });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "세션 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let payload: SessionPayload | null = null;
  try {
    payload = (await request.json()) as SessionPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "요청 본문이 비어있습니다." }, { status: 400 });
  }

  const userId = (payload?.userId ?? "").trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "userId가 필요합니다." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }

  const sessionId = (payload?.sessionId ?? "").trim() || randomUUID();
  const title = (payload?.title ?? "").trim() || null;

  try {
    return await withChatDb(async (client) => {
      const session = await ensureSession(client, { sessionId, userId, title });
      return NextResponse.json({ ok: true, session });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "세션 생성에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
