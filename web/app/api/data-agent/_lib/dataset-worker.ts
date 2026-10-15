import {
  DATASET_ENGINEERING_WORKER_ID,
  type WorkerResponse,
} from "@/app/api/ai-orchestrator/_lib/worker-contract";
import type { OpenAiMessage } from "./llm";
import { runToolLoop } from "./tool-loop";
import { DATASET_ENGINEERING_TOOLS, type ToolContext } from "./tools";

export const datasetEngineeringAnswer = (text: string): WorkerResponse => ({
  mode: "answer",
  text,
});

/** Dataset Engineering 전용 워커 — 매핑/가공 도구만 노출 (기존 map-mst·data-transform 엔진 호출만) */
export const runDatasetEngineeringWorker = async (params: {
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
    tools: DATASET_ENGINEERING_TOOLS,
    defaultWorkerId: DATASET_ENGINEERING_WORKER_ID,
  });

  if (result.pendingAction) {
    return {
      mode: "proposal",
      pendingAction: {
        ...result.pendingAction,
        workerId: result.pendingAction.workerId ?? DATASET_ENGINEERING_WORKER_ID,
      },
    };
  }

  return datasetEngineeringAnswer(result.answerText ?? "무엇을 도와드릴까요?");
};
