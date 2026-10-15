import { openAiChat, type OpenAiMessage, type OpenAiTool } from "./llm";
import {
  AGENT_TOOLS,
  PROPOSE_MAP,
  runReadTool,
  workerIdForProposeTool,
  type ToolContext,
} from "./tools";
import {
  DATA_READINESS_WORKER_ID,
  type PendingAction,
  type WorkerId,
} from "@/app/api/ai-orchestrator/_lib/worker-contract";

export type ToolLoopResult = {
  pendingAction: PendingAction | null;
  answerText: string | null;
};

const safeParse = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const DEFER_WITHOUT_ACTION_PATTERN =
  /(잠시만\s*(기다려|기다려\s*주세요)|확인한\s*(후|뒤).*(진행|요청|알려)|먼저.*확인.*하겠습니다)/i;

// OpenAI tool-calling 루프: READ 도구는 자동 실행하고 결과를 다시 넣어 반복.
// propose_* 도구를 만나면 실행하지 않고 PendingAction 을 반환하고 종료(승인 대기).
export const runToolLoop = async (params: {
  model: string;
  messages: OpenAiMessage[];
  ctx: ToolContext;
  newToken: () => string;
  tools?: OpenAiTool[];
  defaultWorkerId?: WorkerId;
  maxSteps?: number;
}): Promise<ToolLoopResult> => {
  const messages: OpenAiMessage[] = [...params.messages];
  const maxSteps = params.maxSteps ?? 8;
  const tools = params.tools ?? AGENT_TOOLS;
  const defaultWorkerId = params.defaultWorkerId ?? DATA_READINESS_WORKER_ID;

  for (let step = 0; step < maxSteps; step += 1) {
    const msg = await openAiChat({
      model: params.model,
      messages,
      tools,
    });

    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls,
      });
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        const args = safeParse(call.function.arguments);
        if (PROPOSE_MAP[name]) {
          return {
            pendingAction: {
              token: params.newToken(),
              type: PROPOSE_MAP[name],
              args,
              summary: String(args.summary ?? "실행을 진행할까요?"),
              workerId: workerIdForProposeTool(name, defaultWorkerId),
            },
            answerText: null,
          };
        }
        const result = await runReadTool(name, args, params.ctx);
        messages.push({
          role: "tool",
          content: JSON.stringify(result).slice(0, 8000),
          tool_call_id: call.id,
        });
      }
      continue;
    }

    const answerText = (msg.content ?? "").trim();
    if (DEFER_WITHOUT_ACTION_PATTERN.test(answerText) && step < maxSteps - 1) {
      messages.push({ role: "assistant", content: answerText });
      messages.push({
        role: "system",
        content:
          "사용자에게 기다리라고 말한 채 종료하지 마세요. 지금 필요한 조회 도구를 즉시 호출하고, 결과까지 같은 응답에서 제공하세요. 대상 ID가 없으면 list_sources를 호출하세요.",
      });
      continue;
    }
    return {
      pendingAction: null,
      answerText: answerText || "무엇을 도와드릴까요?",
    };
  }

  return {
    pendingAction: null,
    answerText:
      "요청이 복잡해 한 번에 처리하지 못했습니다. 조금 더 구체적으로 말씀해 주세요.",
  };
};
