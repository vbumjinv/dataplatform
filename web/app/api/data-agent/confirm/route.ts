import { NextResponse } from "next/server";
import { canUseDb } from "@/app/api/ai-forecast/_lib/db";
import {
  getMessages,
  insertMessage,
  withChatDb,
} from "@/app/api/ai-forecast-agent/_lib/chat-db";
import {
  DATA_READINESS_WORKER_ID,
  WORKER_CONTRACT_VERSION,
  type ConfirmResponse,
  type WorkerId,
} from "@/app/api/ai-orchestrator/_lib/worker-contract";
import { requireAdminSession } from "../_lib/auth";
import { executeAction } from "../_lib/tools";

export const runtime = "nodejs";

type ConfirmBody = {
  sessionId?: string;
  token?: string;
  decision?: string;
  dbSettingId?: number | string;
};

type PendingActionMeta = {
  token?: string;
  status?: string;
  type?: string;
  args?: Record<string, unknown>;
  summary?: string;
  workerId?: WorkerId;
};

const toId = (value: unknown): number | null => {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const setStatus = async (
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  messageId: number,
  status: string,
) => {
  await client.query(
    `update dp.ai_forecast_chat_message
       set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{pendingAction,status}', to_jsonb($2::text))
     where message_id = $1::bigint`,
    [messageId, status],
  );
};

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: ConfirmBody | null = null;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const sessionId = (body?.sessionId ?? "").trim();
  const token = (body?.token ?? "").trim();
  const decision = body?.decision === "cancel" ? "cancel" : "confirm";
  const dbSettingId = toId(body?.dbSettingId);
  if (!sessionId || !token) {
    return NextResponse.json(
      { ok: false, error: "세션/토큰이 필요합니다." },
      { status: 400 },
    );
  }
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    return await withChatDb(async (client) => {
      const messages = await getMessages(client, sessionId, 100);
      const target = messages.find((m) => {
        const pa = (m.metadata as { pendingAction?: PendingActionMeta } | null)?.pendingAction;
        return pa?.token === token && pa?.status === "pending";
      });
      if (!target) {
        return NextResponse.json(
          { ok: false, error: "만료되었거나 찾을 수 없는 요청입니다." },
          { status: 404 },
        );
      }
      const pa = (target.metadata as { pendingAction: PendingActionMeta }).pendingAction;

      if (decision === "cancel") {
        await setStatus(client, target.messageId, "cancelled");
        const confirmResponse: ConfirmResponse = {
          ok: true,
          status: "cancelled",
          message: "요청을 취소했습니다.",
        };
        await insertMessage(client, {
          sessionId,
          role: "assistant",
          content: confirmResponse.message,
          metadata: {
            app: "data-agent",
            workerId: pa.workerId ?? DATA_READINESS_WORKER_ID,
            contractVersion: WORKER_CONTRACT_VERSION,
          },
        });
        return NextResponse.json({
          ok: true,
          cancelled: true,
          workerId: pa.workerId ?? DATA_READINESS_WORKER_ID,
          contractVersion: WORKER_CONTRACT_VERSION,
          confirmResponse,
        });
      }

      const result = await executeAction(pa.type ?? "", pa.args ?? {}, {
        request,
        dbSettingId,
      });
      await setStatus(client, target.messageId, result.ok ? "executed" : "failed");
      const summary = result.ok
        ? `✅ ${result.message ?? "실행 완료"}`
        : `❌ 실행 실패: ${result.error ?? "알 수 없는 오류"}`;
      const confirmResponse: ConfirmResponse = {
        ok: result.ok,
        status: result.ok ? "executed" : "failed",
        message: summary,
        result,
      };
      await insertMessage(client, {
        sessionId,
        role: "assistant",
        content: summary,
        metadata: {
          app: "data-agent",
          workerId: pa.workerId ?? DATA_READINESS_WORKER_ID,
          contractVersion: WORKER_CONTRACT_VERSION,
          executionResult: result as unknown as Record<string, unknown>,
        },
      });
      return NextResponse.json({
        ok: result.ok,
        executed: result.ok,
        message: summary,
        result,
        workerId: pa.workerId ?? DATA_READINESS_WORKER_ID,
        contractVersion: WORKER_CONTRACT_VERSION,
        confirmResponse,
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
