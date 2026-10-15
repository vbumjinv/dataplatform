import { NextResponse } from "next/server";
import { canUseDb } from "@/app/api/ai-forecast/_lib/db";
import {
  getMessages,
  insertMessage,
  withChatDb,
} from "@/app/api/ai-forecast-agent/_lib/chat-db";
import { requireAdminSession } from "../../data-agent/_lib/auth";
import { executeAction } from "../../data-agent/_lib/tools";
import {
  DATA_READINESS_WORKER_ID,
  WORKER_CONTRACT_VERSION,
  type ConfirmResponse,
  type WorkerId,
} from "../_lib/worker-contract";
import {
  applyExecutionResult,
  nextStageAfterAction,
  publicWorkflow,
} from "../_lib/collection-workflow";
import {
  getActiveCollectionWorkflow,
  updateCollectionWorkflow,
} from "../_lib/workflow-db";

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

type NextAction = {
  id: string;
  label: string;
  prompt: string;
  kind: "read" | "configure" | "execute";
};

const APP = "ai-orchestrator";

const toId = (value: unknown): number | null => {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const nextActionsFor = (
  actionType: string | undefined,
  ok: boolean,
): NextAction[] => {
  if (!ok) return [];
  if (actionType === "register_source") {
    return [
      {
        id: "preview-sample",
        label: "샘플 보기",
        prompt: "방금 등록한 API의 샘플 데이터를 보여줘",
        kind: "read",
      },
      {
        id: "create-table",
        label: "테이블 생성",
        prompt:
          "방금 등록한 API의 _LRD 테이블을 생성하려고 해. 먼저 실제 테이블명을 확인해줘",
        kind: "configure",
      },
      {
        id: "generate-ddl",
        label: "생성문 받기",
        prompt:
          "방금 등록한 API의 _LRD 테이블 생성문을 받고 싶어. 먼저 테이블명을 확인해줘",
        kind: "read",
      },
    ];
  }
  if (
    actionType === "create_staging_table" ||
    actionType === "update_group_target_table"
  ) {
    return [
      {
        id: "run-ingestion",
        label: "수집 적재 실행",
        prompt: "방금 테이블 설정한 API의 수집 적재를 실행해줘",
        kind: "execute",
      },
      {
        id: "preview-sample",
        label: "샘플 다시 보기",
        prompt: "방금 설정한 API의 샘플 데이터를 다시 보여줘",
        kind: "read",
      },
      {
        id: "create-mapping",
        label: "매핑 등록",
        prompt: "방금 적재 테이블을 시계열 매핑으로 등록하려고 해",
        kind: "configure",
      },
    ];
  }
  if (actionType === "run_collection") {
    return [
      {
        id: "create-mapping",
        label: "매핑 등록",
        prompt: "방금 적재한 테이블을 시계열 매핑으로 등록하려고 해",
        kind: "configure",
      },
      {
        id: "check-sample",
        label: "적재 테이블 확인",
        prompt: "방금 적재한 테이블의 컬럼과 샘플을 확인해줘",
        kind: "read",
      },
    ];
  }
  return [];
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
  const userId = String(auth.session.userId);
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
      const workerId = pa.workerId ?? DATA_READINESS_WORKER_ID;
      let collectionWorkflow = await getActiveCollectionWorkflow(
        client,
        sessionId,
        userId,
      );
      const effectiveDbSettingId =
        dbSettingId ?? collectionWorkflow?.dbSettingId ?? null;

      if (decision === "cancel") {
        await setStatus(client, target.messageId, "cancelled");
        if (collectionWorkflow?.state.pending?.token === token) {
          const updated = await updateCollectionWorkflow(client, {
            workflowId: collectionWorkflow.workflowId,
            userId,
            expectedRevision: collectionWorkflow.revision,
            stage: collectionWorkflow.stage,
            state: { ...collectionWorkflow.state, pending: undefined },
          });
          if (!updated) {
            return NextResponse.json(
              { ok: false, error: "수집 워크플로 revision이 변경되었습니다." },
              { status: 409 },
            );
          }
          collectionWorkflow = updated;
        }
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
            app: APP,
            workerId,
            contractVersion: WORKER_CONTRACT_VERSION,
            collectionWorkflow: collectionWorkflow
              ? publicWorkflow(collectionWorkflow)
              : null,
            confirmResponse,
          },
        });
        return NextResponse.json({
          ok: true,
          cancelled: true,
          workerId,
          collectionWorkflow: collectionWorkflow
            ? publicWorkflow(collectionWorkflow)
            : null,
          contractVersion: WORKER_CONTRACT_VERSION,
          confirmResponse,
        });
      }

      const result = await executeAction(pa.type ?? "", pa.args ?? {}, {
        request,
        dbSettingId: effectiveDbSettingId,
      });
      await setStatus(client, target.messageId, result.ok ? "executed" : "failed");
      if (collectionWorkflow?.state.pending?.token === token) {
        const nextState = applyExecutionResult(
          collectionWorkflow.state,
          pa.type ?? "",
          result,
        );
        const nextStage =
          nextStageAfterAction(pa.type ?? "", result.ok) ??
          collectionWorkflow.stage;
        const updated = await updateCollectionWorkflow(client, {
          workflowId: collectionWorkflow.workflowId,
          userId,
          expectedRevision: collectionWorkflow.revision,
          stage: nextStage,
          state: nextState,
          status: nextStage === "completed" ? "completed" : "active",
        });
        if (!updated) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "작업은 실행됐지만 수집 워크플로 revision 갱신에 실패했습니다. 상태를 다시 조회해 주세요.",
            },
            { status: 409 },
          );
        }
        collectionWorkflow = updated;
      }
      const summary = result.ok
        ? `✅ ${result.message ?? "실행 완료"}`
        : `❌ 실행 실패: ${result.error ?? "알 수 없는 오류"}`;
      const confirmResponse: ConfirmResponse = {
        ok: result.ok,
        status: result.ok ? "executed" : "failed",
        message: summary,
        result,
      };
      const nextActions = nextActionsFor(pa.type, result.ok);
      await insertMessage(client, {
        sessionId,
        role: "assistant",
        content: summary,
        metadata: {
          app: APP,
          workerId,
          contractVersion: WORKER_CONTRACT_VERSION,
          executionResult: result as unknown as Record<string, unknown>,
          collectionWorkflow: collectionWorkflow
            ? publicWorkflow(collectionWorkflow)
            : null,
          nextActions,
          confirmResponse,
        },
      });
      return NextResponse.json({
        ok: result.ok,
        executed: result.ok,
        message: summary,
        result,
        workerId,
        collectionWorkflow: collectionWorkflow
          ? publicWorkflow(collectionWorkflow)
          : null,
        nextActions,
        contractVersion: WORKER_CONTRACT_VERSION,
        confirmResponse,
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
