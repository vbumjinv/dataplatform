import { NextResponse } from "next/server";
import { canUseDb } from "@/app/api/ai-forecast/_lib/db";
import {
  getMessages,
  withChatDb,
} from "@/app/api/ai-forecast-agent/_lib/chat-db";
import { requireAdminSession } from "../../data-agent/_lib/auth";
import { publicWorkflow } from "../_lib/collection-workflow";
import { getActiveCollectionWorkflow } from "../_lib/workflow-db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status },
    );
  }
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }

  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "sessionId가 필요합니다." },
      { status: 400 },
    );
  }
  const userId = String(auth.session.userId);

  try {
    return await withChatDb(async (client) => {
      const owned = await client.query(
        `select 1
           from dp.ai_forecast_chat_session
          where session_id = $1::uuid and user_id = $2::text
          limit 1`,
        [sessionId, userId],
      );
      if (!owned.rowCount) {
        return NextResponse.json(
          { ok: false, error: "세션을 찾을 수 없습니다." },
          { status: 404 },
        );
      }
      const [messages, workflow] = await Promise.all([
        getMessages(client, sessionId, 200),
        getActiveCollectionWorkflow(client, sessionId, userId),
      ]);
      const pendingAction = [...messages]
        .reverse()
        .map(
          (message) =>
            (
              message.metadata as {
                pendingAction?: Record<string, unknown>;
              } | null
            )?.pendingAction,
        )
        .find((action) => action?.status === "pending");
      const nextActions = [...messages]
        .reverse()
        .map(
          (message) =>
            (
              message.metadata as {
                nextActions?: Array<Record<string, unknown>>;
              } | null
            )?.nextActions,
        )
        .find((actions) => Array.isArray(actions) && actions.length > 0);
      return NextResponse.json({
        ok: true,
        sessionId,
        messages,
        pendingAction: pendingAction ?? null,
        nextActions: pendingAction ? [] : (nextActions ?? []),
        collectionWorkflow: workflow ? publicWorkflow(workflow) : null,
      });
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "세션 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
