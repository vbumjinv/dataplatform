import {
  DATA_READINESS_WORKER_ID,
  type WorkerResponse,
} from "@/app/api/ai-orchestrator/_lib/worker-contract";
import type { OpenAiMessage } from "./llm";
import { runToolLoop } from "./tool-loop";
import { DATA_READINESS_TOOLS, type ToolContext } from "./tools";

export const dataReadinessAnswer = (text: string): WorkerResponse => ({
  mode: "answer",
  text,
});

/** Data Readiness 전용 워커 — 수집/기관/적재 도구만 노출 */
export const runDataReadinessWorker = async (params: {
  model: string;
  messages: OpenAiMessage[];
  ctx: ToolContext;
  newToken: () => string;
  maxSteps?: number;
}): Promise<WorkerResponse> => {
  const result = await runToolLoop({
    model: params.model,
    messages: params.messages,
    ctx: params.ctx,
    newToken: params.newToken,
    maxSteps: params.maxSteps,
    tools: DATA_READINESS_TOOLS,
    defaultWorkerId: DATA_READINESS_WORKER_ID,
  });

  if (result.pendingAction) {
    return {
      mode: "proposal",
      pendingAction: {
        ...result.pendingAction,
        workerId: result.pendingAction.workerId ?? DATA_READINESS_WORKER_ID,
      },
    };
  }

  return dataReadinessAnswer(result.answerText ?? "무엇을 도와드릴까요?");
};
