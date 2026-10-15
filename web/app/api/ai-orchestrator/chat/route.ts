import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { canUseDb } from "@/app/api/ai-forecast/_lib/db";
import {
  ensureSession,
  getMessages,
  insertMessage,
  withChatDb,
} from "@/app/api/ai-forecast-agent/_lib/chat-db";
import { requireAdminSession } from "../../data-agent/_lib/auth";
import {
  OPENAI_MODEL,
  type OpenAiMessage,
} from "../../data-agent/_lib/llm";
import { SYSTEM_PROMPT } from "../../data-agent/_lib/system-prompt";
import { internalFetch } from "../../data-agent/_lib/internal";
import { runDatasetEngineeringWorker } from "../../data-agent/_lib/dataset-worker";
import { runDataAgentSessionWorker } from "../../data-agent/_lib/session-worker";
import { runDataReadinessWorker } from "../../data-agent/_lib/worker";
import {
  WORKER_CONTRACT_VERSION,
  type WorkerId,
  type WorkerResponse,
} from "../_lib/worker-contract";
import {
  classifyIntent,
  createPlan,
  unsupportedMessage,
  type OrchestratorIntent,
  type RoutingContext,
} from "../_lib/intent";
import {
  applyProposalToState,
  inferCollectionInput,
  publicWorkflow,
  shouldStartCollectionWorkflow,
  stageForAction,
  workflowContextText,
} from "../_lib/collection-workflow";
import {
  createCollectionWorkflow,
  getActiveCollectionWorkflow,
  updateCollectionWorkflow,
} from "../_lib/workflow-db";

export const runtime = "nodejs";

type ChatBody = {
  sessionId?: string;
  message?: string;
  chatModel?: string;
  dbSettingId?: number | string;
};

const APP = "ai-orchestrator";
const FSM_VERSION = "1.0";

const toId = (value: unknown): number | null => {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const workerText = (response: WorkerResponse) => {
  if (response.mode === "answer") return response.text;
  if (response.mode === "needs_input") {
    return response.text ?? response.questions.map((q) => q.prompt).join("\n");
  }
  if (response.mode === "error") return response.error;
  return response.pendingAction.summary;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const isWorkerId = (value: unknown): value is WorkerId =>
  value === "data_readiness" ||
  value === "dataset_engineering" ||
  value === "analytics" ||
  value === "prediction" ||
  value === "viz_report";

const isIntent = (value: unknown): value is OrchestratorIntent =>
  value === "collection" ||
  value === "dataset" ||
  value === "mixed" ||
  value === "unknown";

const deriveRoutingContext = (
  history: Array<{ metadata: Record<string, unknown> | null }>,
): RoutingContext => {
  for (const message of [...history].reverse()) {
    const meta = asRecord(message.metadata);
    if (isWorkerId(meta.workerId)) return { lastWorkerId: meta.workerId };

    const fsm = asRecord(meta.fsm);
    const plan = asRecord(fsm.plan);
    if (isIntent(plan.intent) && plan.intent !== "unknown") {
      return { lastIntent: plan.intent };
    }

    const pendingAction = asRecord(meta.pendingAction);
    if (isWorkerId(pendingAction.workerId)) {
      return { lastWorkerId: pendingAction.workerId };
    }
  }
  return {};
};

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: ChatBody | null = null;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const message = (body?.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ ok: false, error: "메시지를 입력하세요." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }

  const userId = String(auth.session.userId);
  const sessionId = (body?.sessionId ?? "").trim() || randomUUID();
  const dbSettingId = toId(body?.dbSettingId);
  const model =
    (body?.chatModel && String(body.chatModel).trim()) || OPENAI_MODEL || "gpt-4o-mini";

  try {
    return await withChatDb(async (client) => {
      await ensureSession(client, { sessionId, userId, title: message.slice(0, 40) });
      await insertMessage(client, {
        sessionId,
        role: "user",
        content: message,
        metadata: { app: APP },
      });

      const history = await getMessages(client, sessionId, 30);
      const routingContext = deriveRoutingContext(history);
      let collectionWorkflow = await getActiveCollectionWorkflow(
        client,
        sessionId,
        userId,
      );
      let effectiveDbSettingId =
        dbSettingId ?? collectionWorkflow?.dbSettingId ?? null;
      const inferredContext: RoutingContext = collectionWorkflow
        ? { ...routingContext, lastWorkerId: "data_readiness", lastIntent: "collection" }
        : routingContext;
      const intentResult = classifyIntent(message, inferredContext);
      if (intentResult.intent === "collection") {
        if (!collectionWorkflow && shouldStartCollectionWorkflow(message)) {
          collectionWorkflow = await createCollectionWorkflow(client, {
            workflowId: randomUUID(),
            sessionId,
            userId,
            dbSettingId: effectiveDbSettingId,
            state: inferCollectionInput(message, { version: "1.0" }),
          });
          effectiveDbSettingId = collectionWorkflow.dbSettingId;
        } else if (collectionWorkflow) {
          const inferredState = inferCollectionInput(
            message,
            collectionWorkflow.state,
          );
          const updated = await updateCollectionWorkflow(client, {
            workflowId: collectionWorkflow.workflowId,
            userId,
            expectedRevision: collectionWorkflow.revision,
            stage: collectionWorkflow.stage,
            state: inferredState,
          });
          if (!updated) {
            throw new Error("수집 워크플로가 다른 요청에서 갱신되었습니다. 다시 시도해 주세요.");
          }
          collectionWorkflow = updated;
        }
      }
      const plan = createPlan(intentResult.intent, message);
      const baseFsm = {
        version: FSM_VERSION,
        state: "planning",
        plan,
        routing: {
          confidence: intentResult.confidence,
          reason: intentResult.reason,
          context: routingContext,
        },
        updatedAt: new Date().toISOString(),
      };

      if (intentResult.intent === "unknown") {
        const text = intentResult.needsClarification
          ? intentResult.clarificationText ?? unsupportedMessage(intentResult.unsupportedArea)
          : unsupportedMessage(intentResult.unsupportedArea);
        const fsmState = intentResult.needsClarification ? "awaiting_user" : "done";
        const workerResponse: WorkerResponse | null = intentResult.needsClarification
          ? {
              mode: "needs_input",
              text,
              questions: [
                {
                  id: "intent",
                  prompt: text,
                  inputType: "choice",
                  choices: ["수집 설정", "매핑/가공 전처리"],
                  required: true,
                },
              ],
            }
          : null;
        await insertMessage(client, {
          sessionId,
          role: "assistant",
          content: text,
          metadata: {
            app: APP,
            contractVersion: WORKER_CONTRACT_VERSION,
            fsm: { ...baseFsm, state: fsmState },
            workerResponse,
          },
        });
        return NextResponse.json({
          ok: true,
          sessionId,
          mode: intentResult.needsClarification ? "needs_input" : "answer",
          text,
          intent: intentResult.intent,
          unsupportedArea: intentResult.unsupportedArea,
          routing: {
            confidence: intentResult.confidence,
            reason: intentResult.reason,
            context: routingContext,
          },
          plan,
          fsm: { ...baseFsm, state: fsmState },
          workerResponse,
          contractVersion: WORKER_CONTRACT_VERSION,
        });
      }

      const priorMsgs: OpenAiMessage[] = history
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const messages: OpenAiMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...(collectionWorkflow
          ? [{ role: "system" as const, content: workflowContextText(collectionWorkflow) }]
          : []),
        ...priorMsgs,
      ];

      const common = {
        model,
        messages,
        ctx: { request, dbSettingId: effectiveDbSettingId },
        newToken: () => randomUUID(),
      };

      const workerResponse =
        intentResult.intent === "collection"
          ? await runDataReadinessWorker(common)
          : intentResult.intent === "dataset"
            ? await runDatasetEngineeringWorker(common)
            : await runDataAgentSessionWorker(common);

      if (workerResponse.mode === "proposal") {
        const { pendingAction } = workerResponse;
        const proposedTable = String(pendingAction.args.table ?? "").trim();
        if (
          pendingAction.type === "create_staging_table" &&
          (!proposedTable || /^example_?lrd$/i.test(proposedTable))
        ) {
          const text =
            "테이블명 없이 예시명(example_LRD)으로는 생성할 수 없습니다. 실제 _LRD 테이블명을 알려주세요. 예: bok_121y015_lrd";
          await insertMessage(client, {
            sessionId,
            role: "assistant",
            content: text,
            metadata: {
              app: APP,
              workerId: pendingAction.workerId,
              collectionWorkflow: collectionWorkflow
                ? publicWorkflow(collectionWorkflow)
                : null,
            },
          });
          return NextResponse.json({
            ok: true,
            sessionId,
            mode: "needs_input",
            text,
            collectionWorkflow: collectionWorkflow
              ? publicWorkflow(collectionWorkflow)
              : null,
          });
        }
        if (
          collectionWorkflow &&
          pendingAction.type === "register_source" &&
          !collectionWorkflow.state.preview?.checked
        ) {
          const sourceArg = asRecord(pendingAction.args.source);
          const provider = String(sourceArg.provider ?? "").toLowerCase();
          const configPath = `/api/ingestion/api-config${
            effectiveDbSettingId ? `?dbSettingId=${effectiveDbSettingId}` : ""
          }`;
          const config = await internalFetch(request, configPath);
          const sources =
            (asRecord(config.json).sources as Array<Record<string, unknown>>) ??
            [];
          const source = sources.find(
            (item) =>
              String(item.provider ?? "").toLowerCase() === provider &&
              Number(item.id) > 0,
          );
          const sourceId = Number(source?.id);
          const draft = sourceId
            ? await internalFetch(request, "/api/data-agent/preview-draft", {
                method: "POST",
                body: JSON.stringify({
                  sourceId,
                  params: pendingAction.args.params,
                  dbSettingId: effectiveDbSettingId ?? undefined,
                }),
              })
            : null;
          const draftBody = asRecord(draft?.json);
          if (!draft?.ok || !draftBody.ok) {
            const errorText = sourceId
              ? String(
                  draftBody.error ??
                    "등록 전 샘플 확인에 실패했습니다. 파라미터를 확인해 주세요.",
                )
              : "기존 기관 설정을 찾지 못했습니다. 기관을 먼저 등록한 뒤 API 등록을 진행해 주세요.";
            const failed = await updateCollectionWorkflow(client, {
              workflowId: collectionWorkflow.workflowId,
              userId,
              expectedRevision: collectionWorkflow.revision,
              stage: "preview_draft",
              state: {
                ...collectionWorkflow.state,
                sourceId: sourceId || collectionWorkflow.state.sourceId,
                lastError: errorText,
              },
            });
            if (!failed) {
              throw new Error("수집 워크플로가 다른 요청에서 갱신되었습니다.");
            }
            collectionWorkflow = failed;
            await insertMessage(client, {
              sessionId,
              role: "assistant",
              content: errorText,
              metadata: {
                app: APP,
                workerId: pendingAction.workerId,
                collectionWorkflow: publicWorkflow(collectionWorkflow),
              },
            });
            return NextResponse.json({
              ok: true,
              sessionId,
              mode: "answer",
              text: errorText,
              collectionWorkflow: publicWorkflow(collectionWorkflow),
            });
          }
          const previewed = await updateCollectionWorkflow(client, {
            workflowId: collectionWorkflow.workflowId,
            userId,
            expectedRevision: collectionWorkflow.revision,
            stage: "preview_draft",
            state: {
              ...collectionWorkflow.state,
              sourceId,
              preview: {
                checked: true,
                header: (draftBody.header as string[]) ?? [],
                columns:
                  (draftBody.columns as Array<{ name: string; type: string }>) ??
                  [],
                sample:
                  (draftBody.sample as Array<Record<string, unknown>>) ?? [],
              },
              lastError: undefined,
            },
          });
          if (!previewed) {
            throw new Error("수집 워크플로가 다른 요청에서 갱신되었습니다.");
          }
          collectionWorkflow = previewed;
        }
        if (collectionWorkflow && pendingAction.workerId === "data_readiness") {
          const actionStage = stageForAction(pendingAction.type);
          if (actionStage) {
            const proposedState = applyProposalToState(
              collectionWorkflow.state,
              pendingAction.type,
              pendingAction.args,
            );
            proposedState.pending = {
              token: pendingAction.token,
              actionType: pendingAction.type,
              stage: actionStage,
              revision: collectionWorkflow.revision,
            };
            const updated = await updateCollectionWorkflow(client, {
              workflowId: collectionWorkflow.workflowId,
              userId,
              expectedRevision: collectionWorkflow.revision,
              stage: actionStage,
              state: proposedState,
            });
            if (!updated) {
              throw new Error("수집 워크플로가 다른 요청에서 갱신되었습니다. 다시 시도해 주세요.");
            }
            collectionWorkflow = updated;
          }
        }
        const activeStep = plan.steps.find((step) => step.workerId === pendingAction.workerId);
        const nextPlan = {
          ...plan,
          steps: plan.steps.map((step) =>
            step.id === activeStep?.id ? { ...step, status: "awaiting_confirm" as const } : step,
          ),
        };
        const fsm = {
          ...baseFsm,
          state: "awaiting_confirm",
          plan: nextPlan,
          activeStepId: activeStep?.id,
          pendingToken: pendingAction.token,
          updatedAt: new Date().toISOString(),
        };
        await insertMessage(client, {
          sessionId,
          role: "assistant",
          content: pendingAction.summary,
          metadata: {
            app: APP,
            workerId: pendingAction.workerId,
            contractVersion: WORKER_CONTRACT_VERSION,
            fsm,
            pendingAction: {
              ...pendingAction,
              status: "pending",
              createdAt: new Date().toISOString(),
            },
            collectionWorkflow: collectionWorkflow
              ? publicWorkflow(collectionWorkflow)
              : null,
          },
        });
        return NextResponse.json({
          ok: true,
          sessionId,
          mode: "proposal",
          intent: intentResult.intent,
          routing: {
            confidence: intentResult.confidence,
            reason: intentResult.reason,
            context: routingContext,
          },
          plan: nextPlan,
          pendingAction,
          workerId: pendingAction.workerId,
          workerResponse,
          fsm,
          collectionWorkflow: collectionWorkflow
            ? publicWorkflow(collectionWorkflow)
            : null,
          contractVersion: WORKER_CONTRACT_VERSION,
        });
      }

      const text = workerText(workerResponse);
      const fsm = { ...baseFsm, state: "done", updatedAt: new Date().toISOString() };
      await insertMessage(client, {
        sessionId,
        role: "assistant",
        content: text,
        metadata: {
          app: APP,
          contractVersion: WORKER_CONTRACT_VERSION,
          fsm,
          workerResponse,
          collectionWorkflow: collectionWorkflow
            ? publicWorkflow(collectionWorkflow)
            : null,
        },
      });
      return NextResponse.json({
        ok: true,
        sessionId,
        mode: workerResponse.mode === "needs_input" ? "needs_input" : "answer",
        text,
        intent: intentResult.intent,
        routing: {
          confidence: intentResult.confidence,
          reason: intentResult.reason,
          context: routingContext,
        },
        plan,
        workerResponse,
        fsm,
        collectionWorkflow: collectionWorkflow
          ? publicWorkflow(collectionWorkflow)
          : null,
        contractVersion: WORKER_CONTRACT_VERSION,
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
