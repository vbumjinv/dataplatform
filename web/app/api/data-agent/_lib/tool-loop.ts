import { openAiChat, type OpenAiMessage } from "./llm";
import { AGENT_TOOLS, PROPOSE_MAP, runReadTool, type ToolContext } from "./tools";

export type PendingAction = {
  token: string;
  type: string;
  args: Record<string, unknown>;
  summary: string;
};

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

// OpenAI tool-calling 루프: READ 도구는 자동 실행하고 결과를 다시 넣어 반복.
// propose_* 도구를 만나면 실행하지 않고 PendingAction 을 반환하고 종료(승인 대기).
export const runToolLoop = async (params: {
  model: string;
  messages: OpenAiMessage[];
  ctx: ToolContext;
  newToken: () => string;
  maxSteps?: number;
}): Promise<ToolLoopResult> => {
  const messages: OpenAiMessage[] = [...params.messages];
  const maxSteps = params.maxSteps ?? 6;

  for (let step = 0; step < maxSteps; step += 1) {
    const msg = await openAiChat({
      model: params.model,
      messages,
      tools: AGENT_TOOLS,
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

    return {
      pendingAction: null,
      answerText: (msg.content ?? "").trim() || "무엇을 도와드릴까요?",
    };
  }

  return {
    pendingAction: null,
    answerText:
      "요청이 복잡해 한 번에 처리하지 못했습니다. 조금 더 구체적으로 말씀해 주세요.",
  };
};
