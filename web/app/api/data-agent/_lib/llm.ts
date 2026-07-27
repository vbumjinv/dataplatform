// data-agent 전용 LLM 호출 헬퍼. 기존 ai-forecast-agent 의 패턴을 그대로 복제해
// 기존 파일을 수정하지 않고 재사용한다. (OpenAI tool-calling + Ollama 텍스트)

export const OLLAMA_URL = process.env.OLLAMA_URL;
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const OPENAI_MODEL = process.env.OPENAI_MODEL;
export const OPENAI_BASE_URL = (
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/$/, "");

export const fetchWithTimeout = async (
  input: string,
  init: RequestInit,
  timeoutMs: number,
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

export const parseJsonSafe = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export const openAiChat = async (args: {
  model: string;
  messages: OpenAiMessage[];
  tools?: OpenAiTool[];
}): Promise<OpenAiMessage> => {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
  const body: Record<string, unknown> = {
    model: args.model,
    temperature: 0.1,
    messages: args.messages,
  };
  if (args.tools && args.tools.length) {
    body.tools = args.tools;
    body.tool_choice = "auto";
  }
  const response = await fetchWithTimeout(
    `${OPENAI_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    60000,
  );
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI 호출 실패: ${raw.slice(0, 300)}`);
  const parsed = parseJsonSafe(raw) as
    | { choices?: Array<{ message?: OpenAiMessage }> }
    | null;
  const message = parsed?.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI 응답을 해석하지 못했습니다.");
  return message;
};

export const ollamaChat = async (
  model: string,
  prompt: string,
): Promise<string> => {
  if (!OLLAMA_URL) throw new Error("OLLAMA_URL이 설정되지 않았습니다.");
  const response = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
    },
    60000,
  );
  const raw = await response.text();
  if (!response.ok) throw new Error(`Ollama 호출 실패: ${raw.slice(0, 300)}`);
  const parsed = parseJsonSafe(raw) as { response?: string } | null;
  return (parsed?.response ?? "").trim();
};
