import type { WorkerResponse } from "@/app/api/ai-orchestrator/_lib/worker-contract";
import type { OpenAiMessage } from "./llm";
import { runToolLoop } from "./tool-loop";
import { AGENT_TOOLS, type ToolContext } from "./tools";
import { dataReadinessAnswer } from "./worker";

/**
 * /data-agent 통합 진입점용 파사드.
 * 수집+전처리 도구를 한 세션에서 쓰되, propose 시 workerId 로 책임을 구분한다.
 * 기존 수집/시각화 메뉴·엔진은 수정하지 않는다.
 */
export const runDataAgentSessionWorker = async (params: {
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
    tools: AGENT_TOOLS,
  });

  if (result.pendingAction) {
    return {
      mode: "proposal",
      pendingAction: result.pendingAction,
    };
  }

  return dataReadinessAnswer(result.answerText ?? "무엇을 도와드릴까요?");
};
