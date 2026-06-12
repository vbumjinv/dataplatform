import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../../ai-forecast/_lib/db";
import { buildForecastCompositeScore } from "../../ai-forecast/_lib/forecast-score";
import type { SeriesMeta, TimeSeriesPoint } from "../../ai-forecast/_lib/types";

export const runtime = "nodejs";

type RunPayload = {
  seriesId?: string;
  horizonMonths?: number;
  executionMode?: "llm_direct" | "llm_select_python";
  previewOnly?: boolean;
  useCodeInterpreter?: boolean;
  asyncExecution?: boolean;
  pollResponseId?: string;
  customPrompt?: string;
  enableLlmSummary?: boolean;
  forecastMethod?: string;
  forecastInstructionStrength?: string;
  provider?: "ollama" | "openai";
  ollamaModel?: string;
  openaiModel?: string;
  temperature?: number | string;
};

type LlmForecastItem = {
  ds: string;
  yhat: number;
  actual: number;
};

type TokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

type ForecastModelType =
  | "prophet"
  | "arima"
  | "sarima"
  | "linear_trend"
  | "chronos_bolt_base"
  | "chronos_2"
  | "timesfm_2_5_200m";

type PythonForecastResponse = {
  model: string;
  metrics: { mae: number | null; rmse: number | null; mape: number | null };
  history: TimeSeriesPoint[];
  forecast: Array<{
    ds: string;
    yhat: number;
    actual?: number | null;
    yhatLower?: number | null;
    yhatUpper?: number | null;
  }>;
  series_id: string;
  horizon_months: number;
  train_count: number;
  test_count: number;
  train_start: string | null;
  train_end: string | null;
  test_start: string | null;
  test_end: string | null;
  fallback_reason?: string | null;
};

const OLLAMA_URL = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const PYTHON_FORECAST_API_URL = process.env.PYTHON_FORECAST_API_URL ?? "http://127.0.0.1:8001/forecast";
const TIMESFM_FORECAST_API_URL =
  process.env.TIMESFM_FORECAST_API_URL ?? "http://127.0.0.1:8002/forecast";
const OLLAMA_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000) || 60000,
);
const PYTHON_FORECAST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.PYTHON_FORECAST_TIMEOUT_MS ?? 35000) || 35000,
);
const TIMESFM_FORECAST_TIMEOUT_MS = Math.max(
  60000,
  Number(process.env.TIMESFM_FORECAST_TIMEOUT_MS ?? 600000) || 600000,
);
const OPENAI_CODE_INTERPRETER_TIMEOUT_MS = Math.max(
  60000,
  Number(process.env.OPENAI_CODE_INTERPRETER_TIMEOUT_MS ?? 600000) || 600000,
);
const OPENAI_CODE_INTERPRETER_RETRIES = Math.max(
  0,
  Number(process.env.OPENAI_CODE_INTERPRETER_RETRIES ?? 1) || 1,
);
const ALLOWED_OLLAMA_MODELS = new Set([
  "qwen3:8b",
  "gemma3:4b",
  "gemma4:e4b",
  "llama3.2:latest",
  "llama3.2:lates",
]);
const ALLOWED_MODEL_TYPES = new Set<ForecastModelType>([
  "prophet",
  "arima",
  "sarima",
  "linear_trend",
  "chronos_bolt_base",
  "chronos_2",
  "timesfm_2_5_200m",
]);

const normalizeOllamaModelName = (name: string) => {
  if (name === "llama3.2:lates") return "llama3.2:latest";
  return name;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const buildTokenUsage = (promptTokens: unknown, completionTokens: unknown): TokenUsage => {
  const prompt = toFiniteNumber(promptTokens);
  const completion = toFiniteNumber(completionTokens);
  const total = prompt != null || completion != null ? (prompt ?? 0) + (completion ?? 0) : null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
};

const callOllama = async (model: string, prompt: string, temperature?: number | null) => {
  if (!OLLAMA_URL) {
    throw new Error("OLLAMA_URL 설정이 필요합니다.");
  }
  const ollamaResponse = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: "json",
        options:
          temperature == null
            ? undefined
            : {
                temperature,
              },
      }),
    },
    120000,
  );
  const rawBody = await ollamaResponse.text();
  const parsedEnvelope = parseJsonSafe(rawBody) as
    | { response?: string; error?: string; prompt_eval_count?: unknown; eval_count?: unknown }
    | null;
  if (!ollamaResponse.ok) {
    throw new Error(parsedEnvelope?.error || rawBody || "Ollama 호출 실패");
  }
  return {
    provider: "ollama" as const,
    model,
    text: (parsedEnvelope?.response ?? rawBody ?? "").trim(),
    tokenUsage: buildTokenUsage(parsedEnvelope?.prompt_eval_count, parsedEnvelope?.eval_count),
  };
};

const callOpenAi = async (model: string, prompt: string, temperature?: number | null) => {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 설정이 필요합니다.");
  }
  const openAiUrl = `${OPENAI_BASE_URL}/chat/completions`;
  const openAiResponse = await fetchWithTimeout(
    openAiUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        ...(temperature != null ? { temperature } : {}),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are a time-series forecaster. Return JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    },
    120000,
  );
  const rawBody = await openAiResponse.text();
  const parsed = parseJsonSafe(rawBody) as
    | {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
        };
      }
    | null;
  if (!openAiResponse.ok) {
    throw new Error(parsed?.error?.message || rawBody || "OpenAI 호출 실패");
  }
  const text = parsed?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI 응답에서 message content를 찾지 못했습니다.");
  }
  return {
    provider: "openai" as const,
    model,
    text,
    tokenUsage: buildTokenUsage(
      parsed?.usage?.prompt_tokens,
      parsed?.usage?.completion_tokens,
    ),
  };
};

const extractResponseOutputText = (parsed: unknown): string => {
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const chunks: string[] = [];
  output.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const message = item as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((part) => {
      if (!part || typeof part !== "object") return;
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string" && p.text.trim()) {
        chunks.push(p.text.trim());
        return;
      }
      if (typeof p.value === "string" && p.value.trim()) {
        chunks.push(p.value.trim());
      }
    });
  });
  return chunks.join("\n").trim();
};

type CodeInterpreterTraceItem = {
  label: string;
  content: string;
};

type MethodComplianceResult = {
  ok: boolean;
  reason: string | null;
};

const pushTrace = (
  bucket: CodeInterpreterTraceItem[],
  dedupe: Set<string>,
  label: string,
  content: unknown,
) => {
  if (typeof content !== "string") return;
  const normalized = content.trim();
  if (!normalized) return;
  const signature = `${label}:${normalized}`;
  if (dedupe.has(signature)) return;
  dedupe.add(signature);
  bucket.push({ label, content: normalized });
};

const extractCodeInterpreterTrace = (parsed: unknown): CodeInterpreterTraceItem[] => {
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  const traces: CodeInterpreterTraceItem[] = [];
  const dedupe = new Set<string>();

  output.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const outputItem = item as Record<string, unknown>;
    const outputType = typeof outputItem.type === "string" ? outputItem.type : "";

    if (/code_interpreter/i.test(outputType)) {
      pushTrace(traces, dedupe, "Python 코드", outputItem.code);
      pushTrace(traces, dedupe, "입력", outputItem.input);
      pushTrace(traces, dedupe, "로그", outputItem.logs);
      pushTrace(traces, dedupe, "stdout", outputItem.stdout);
      pushTrace(traces, dedupe, "stderr", outputItem.stderr);
    }

    const content = Array.isArray(outputItem.content) ? outputItem.content : [];
    content.forEach((part) => {
      if (!part || typeof part !== "object") return;
      const chunk = part as Record<string, unknown>;
      const chunkType = typeof chunk.type === "string" ? chunk.type : "";

      if (/code_interpreter/i.test(chunkType)) {
        pushTrace(traces, dedupe, "Python 코드", chunk.code);
        pushTrace(traces, dedupe, "입력", chunk.input);
        pushTrace(traces, dedupe, "로그", chunk.logs);
        pushTrace(traces, dedupe, "stdout", chunk.stdout);
        pushTrace(traces, dedupe, "stderr", chunk.stderr);
      }

      if (chunkType === "output_text") {
        pushTrace(traces, dedupe, "텍스트 출력", chunk.text);
      }
    });
  });

  return traces;
};

const hasAnyPattern = (text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));

const isFoundationRequestedMethod = (normalizedMethod: string | null) =>
  normalizedMethod === "chronos_2" ||
  normalizedMethod === "chronos_bolt_base" ||
  normalizedMethod === "timesfm_2_5_200m";

const evaluateMethodCompliance = (
  requestedMethod: string | null,
  trace: CodeInterpreterTraceItem[] | null | undefined,
  llmText: string,
): MethodComplianceResult => {
  if (!requestedMethod) return { ok: true, reason: null };
  const normalized = normalizeForecastMethod(requestedMethod);
  if (!normalized) return { ok: true, reason: null };

  const combined = `${trace?.map((item) => item.content).join("\n") ?? ""}\n${llmText}`.toLowerCase();
  if (!combined.trim()) {
    return { ok: false, reason: "코드/로그 텍스트가 비어 있습니다." };
  }

  const patternByMethod: Record<string, RegExp[]> = {
    prophet: [/\bprophet\b/i],
    linear_trend: [/\blinearregression\b/i, /\bpolyfit\b/i, /\bols\b/i, /\blinear trend\b/i],
    arima: [/\barima\b/i, /statsmodels\.tsa\.arima/i],
    sarima: [/\bsarima\b/i, /\bsarimax\b/i, /\bseasonal_order\b/i],
    chronos_2: [/\bchronos\b/i],
    chronos_bolt_base: [/\bchronos\b/i, /\bbolt\b/i],
    timesfm_2_5_200m: [/\btimesfm\b/i],
  };
  const patterns = patternByMethod[normalized];
  if (!patterns || patterns.length === 0) {
    return { ok: false, reason: `지원되지 않는 검증 대상 기법입니다: ${normalized}` };
  }
  if (!hasAnyPattern(combined, patterns)) {
    return { ok: false, reason: `코드/로그에서 '${normalized}' 관련 실행 흔적을 찾지 못했습니다.` };
  }
  return { ok: true, reason: null };
};

const callOpenAiWithCodeInterpreter = async (
  model: string,
  prompt: string,
  temperature?: number | null,
) => {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 설정이 필요합니다.");
  }
  const responsesUrl = `${OPENAI_BASE_URL}/responses`;
  let response: Response | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= OPENAI_CODE_INTERPRETER_RETRIES; attempt += 1) {
    try {
      response = await fetchWithTimeout(
        responsesUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            ...(temperature != null ? { temperature } : {}),
            tools: [{ type: "code_interpreter", container: { type: "auto" } }],
            input: [
              {
                role: "system",
                content:
                  "You are a time-series forecaster. You may use Python via code interpreter. Return JSON only.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
          }),
        },
        OPENAI_CODE_INTERPRETER_TIMEOUT_MS,
      );
      lastError = null;
      break;
    } catch (error) {
      if (isAbortLikeError(error) && attempt < OPENAI_CODE_INTERPRETER_RETRIES) {
        lastError = error instanceof Error ? error : new Error("요청이 중단되었습니다.");
        continue;
      }
      throw toReadableOpenAiError(error, OPENAI_CODE_INTERPRETER_TIMEOUT_MS);
    }
  }
  if (!response) {
    throw (
      lastError ??
      new Error(
        `OpenAI Code Interpreter 응답 시간 초과(${Math.round(
          OPENAI_CODE_INTERPRETER_TIMEOUT_MS / 1000,
        )}초)`,
      )
    );
  }
  const rawBody = await response.text();
  const parsed = parseJsonSafe(rawBody) as
    | {
        error?: { message?: string };
        output?: unknown;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
        };
      }
    | null;
  if (!response.ok) {
    throw new Error(parsed?.error?.message || rawBody || "OpenAI Responses 호출 실패");
  }
  const text = extractResponseOutputText(parsed);
  if (!text) {
    throw new Error("OpenAI Responses 응답에서 출력 텍스트를 찾지 못했습니다.");
  }
  return {
    provider: "openai" as const,
    model,
    text,
    codeInterpreterTrace: extractCodeInterpreterTrace(parsed),
    tokenUsage: buildTokenUsage(
      parsed?.usage?.input_tokens,
      parsed?.usage?.output_tokens,
    ),
  };
};

type OpenAiResponsesEnvelope = {
  id?: string;
  status?: string;
  model?: string;
  output?: unknown;
  output_text?: string;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  error?: { message?: string };
};

const fetchOpenAiResponsesObject = async (
  responseId: string,
): Promise<OpenAiResponsesEnvelope> => {
  const url = `${OPENAI_BASE_URL}/responses/${encodeURIComponent(responseId)}`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    },
    30000,
  );
  const rawBody = await response.text();
  const parsed = parseJsonSafe(rawBody) as OpenAiResponsesEnvelope | null;
  if (!response.ok) {
    throw new Error(parsed?.error?.message || rawBody || "OpenAI Responses 조회 실패");
  }
  return parsed ?? {};
};

const startOpenAiCodeInterpreterBackground = async (
  model: string,
  prompt: string,
  temperature?: number | null,
) => {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 설정이 필요합니다.");
  }
  const responsesUrl = `${OPENAI_BASE_URL}/responses`;
  const response = await fetchWithTimeout(
    responsesUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        background: true,
        ...(temperature != null ? { temperature } : {}),
        tools: [{ type: "code_interpreter", container: { type: "auto" } }],
        input: [
          {
            role: "system",
            content:
              "You are a time-series forecaster. You may use Python via code interpreter. Return JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    },
    30000,
  );
  const rawBody = await response.text();
  const parsed = parseJsonSafe(rawBody) as OpenAiResponsesEnvelope | null;
  if (!response.ok) {
    throw new Error(parsed?.error?.message || rawBody || "OpenAI Responses 비동기 시작 실패");
  }
  const responseId = (parsed?.id ?? "").trim();
  if (!responseId) {
    throw new Error("OpenAI Responses 비동기 시작 응답에서 id를 찾지 못했습니다.");
  }
  return {
    responseId,
    status: (parsed?.status ?? "queued").trim() || "queued",
  };
};

const isOpenAiResponsesCompleted = (status?: string | null) => {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "completed";
};

const isOpenAiResponsesTerminalError = (status?: string | null) => {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "failed" || normalized === "cancelled" || normalized === "expired";
};

const isAbortLikeError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted|timeout/i.test(error.message);
};

const isFetchFailedLikeError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /fetch failed|network|econnreset|enotfound|eai_again|socket hang up/i.test(error.message);
};

const toReadableOpenAiError = (error: unknown, timeoutMs: number): Error => {
  if (isAbortLikeError(error)) {
    return new Error(
      `OpenAI 요청이 시간 초과/중단되었습니다. (timeout ${Math.round(
        timeoutMs / 1000,
      )}초) 프록시/게이트웨이 타임아웃 여부를 확인하세요.`,
    );
  }
  if (isFetchFailedLikeError(error)) {
    return new Error(
      "OpenAI 네트워크 요청 실패(fetch failed)입니다. 모델 자체 이슈보다 프록시, 게이트웨이, DNS, 방화벽 또는 중간 타임아웃 가능성이 큽니다.",
    );
  }
  return error instanceof Error ? error : new Error("OpenAI 호출 실패");
};

const isTemperatureUnsupportedError = (message: string) =>
  /temperature/i.test(message) &&
  (/only the default/i.test(message) ||
    /does not support/i.test(message) ||
    /unsupported value/i.test(message));

/** 요약용: JSON 강제 없이 plain text (테스트 1과 동일 패턴) */
const callOllamaPlainText = async (model: string, prompt: string, timeoutMs: number) => {
  if (!OLLAMA_URL) throw new Error("OLLAMA_URL 설정이 필요합니다.");
  const ollamaResponse = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.25,
        },
      }),
    },
    timeoutMs,
  );
  const rawBody = await ollamaResponse.text();
  const parsedEnvelope = parseJsonSafe(rawBody) as
    | { response?: string; error?: string; prompt_eval_count?: unknown; eval_count?: unknown }
    | null;
  if (!ollamaResponse.ok) {
    throw new Error(parsedEnvelope?.error || rawBody || "Ollama 호출 실패");
  }
  return {
    text: ((parsedEnvelope?.response ?? rawBody) ?? "").trim(),
    tokenUsage: buildTokenUsage(parsedEnvelope?.prompt_eval_count, parsedEnvelope?.eval_count),
  };
};

type ForecastMetricsLite = {
  mae: number | null;
  rmse: number | null;
  mape: number | null;
};

const buildLlmForecastSummaryPrompt = (
  meta: SeriesMeta,
  history: TimeSeriesPoint[],
  forecast: LlmForecastItem[],
  metrics: ForecastMetricsLite,
  options: {
    predictionLabel: string;
    trainCount: number;
    testCount: number;
    trainStart: string | null;
    trainEnd: string | null;
    testStart: string | null;
    testEnd: string | null;
    usedLinearFallback: boolean;
  },
) => {
  const recent = history.slice(-6);
  const holdoutRows = forecast.slice(0, 12);
  const holdoutWithActual = holdoutRows.filter((item): item is typeof item & { actual: number } =>
    typeof item.actual === "number" && Number.isFinite(item.actual),
  );
  const absErrors = holdoutWithActual.map((item) => Math.abs(item.yhat - item.actual));
  const signedErrors = holdoutWithActual.map((item) => item.yhat - item.actual);
  const lastPoint = history.length ? history[history.length - 1] : null;
  const avgAbsError =
    absErrors.length > 0 ? absErrors.reduce((sum, v) => sum + v, 0) / absErrors.length : null;
  const avgSignedError =
    signedErrors.length > 0 ? signedErrors.reduce((sum, v) => sum + v, 0) / signedErrors.length : null;
  const underCount = signedErrors.filter((v) => v < 0).length;
  const overCount = signedErrors.filter((v) => v > 0).length;

  return [
    "당신은 거시경제 시계열 해설자입니다.",
    "아래는 LLM 직접 예측으로 생성된 holdout 평가 결과입니다.",
    "숫자에 근거해서 한국어로 간결하게 설명하세요. 과장/추측은 금지합니다.",
    "",
    `[시계열] ${meta.seriesNameKo ?? meta.seriesId} (${meta.seriesId})`,
    `[단위] ${meta.unitName ?? "-"}`,
    `[주기] ${meta.freqCd ?? "-"}`,
    `[모델] 직접 예측(LLM), 예측에 사용: ${options.predictionLabel}`,
    options.usedLinearFallback
      ? "[예측 주의] LLM JSON 파싱/추출에 실패해 학습구간 선형 추세 fallback으로 예측값을 채웠습니다. 요약에서 이 한계를 언급하세요."
      : null,
    `[평가 지표] MAE=${metrics.mae ?? "N/A"}, RMSE=${metrics.rmse ?? "N/A"}, MAPE=${metrics.mape ?? "N/A"}`,
    `[학습 구간] ${options.trainCount}건 (${options.trainStart ?? "-"} ~ ${options.trainEnd ?? "-"})`,
    `[평가 구간] ${options.testCount}건 (${options.testStart ?? "-"} ~ ${options.testEnd ?? "-"})`,
    `[최근 실제값] ${lastPoint ? `${lastPoint.ds} = ${lastPoint.y}` : "N/A"}`,
    `[평가오차 요약] 평균절대오차=${avgAbsError ?? "N/A"}, 평균편향=${avgSignedError ?? "N/A"}, 과소예측건수=${underCount}, 과대예측건수=${overCount}`,
    "",
    "[최근 6개 실제값 (history)]",
    ...recent.map((item) => `- ${item.ds}: ${item.y}`),
    "",
    "[holdout 평가 표 (최대 12건)]",
    ...holdoutRows.map((item) => {
      const error = item.yhat - item.actual;
      return `- ${item.ds}: actual=${item.actual}, yhat=${item.yhat}, error=${error}`;
    }),
    "",
    "중요: 위 표의 숫자를 우선 근거로 삼아 설명하세요.",
    "MAPE/MAE/RMSE 해석은 서로 모순되지 않게 작성하세요.",
    "",
    "출력 형식(반드시 아래 4개 제목으로):",
    "1) 최근 추세 요약",
    "2) holdout 평가 결과 해석",
    "3) 향후 전망(단정 금지)",
    "4) 주의 포인트",
    "",
    "각 항목은 2~3문장, 전체는 10문장 이내로 작성하세요.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
};

const fetchWithTimeout = async (input: string, init: RequestInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseJsonSafe = (raw: string) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const extractJsonText = (raw: string) => {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const fencedAny = raw.match(/```\s*([\s\S]*?)```/i);
  if (fencedAny?.[1]) return fencedAny[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1).trim();
  const arrStart = raw.indexOf("[");
  const arrEnd = raw.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) return raw.slice(arrStart, arrEnd + 1).trim();
  return raw.trim();
};

const completePredictionList = (items: Array<number | null>, requiredCount: number) => {
  if (requiredCount <= 0) return [];
  const firstKnown = items.find((v): v is number => typeof v === "number" && Number.isFinite(v)) ?? null;
  if (firstKnown == null) {
    throw new Error("LLM 응답에서 유효한 예측값을 찾지 못했습니다.");
  }

  const completed: number[] = [];
  let carry = firstKnown;
  for (let i = 0; i < requiredCount; i += 1) {
    const current = items[i];
    if (typeof current === "number" && Number.isFinite(current)) {
      carry = current;
      completed.push(current);
      continue;
    }
    completed.push(carry);
  }
  return completed;
};

const normalizePredictions = (parsed: unknown, targetDates: string[]) => {
  const getYhat = (row: unknown) => {
    if (!row || typeof row !== "object") return null;
    const obj = row as Record<string, unknown>;
    return (
      toFiniteNumber(obj.yhat) ??
      toFiniteNumber(obj.y_hat) ??
      toFiniteNumber(obj.pred) ??
      toFiniteNumber(obj.prediction) ??
      toFiniteNumber(obj.predicted) ??
      toFiniteNumber(obj.value) ??
      toFiniteNumber(obj.forecast) ??
      toFiniteNumber(obj.mean)
    );
  };

  const getDs = (row: unknown) => {
    if (!row || typeof row !== "object") return null;
    const obj = row as Record<string, unknown>;
    if (typeof obj.ds === "string" && obj.ds.length >= 10) return obj.ds.slice(0, 10);
    if (typeof obj.date === "string" && obj.date.length >= 10) return obj.date.slice(0, 10);
    if (typeof obj.target_date === "string" && obj.target_date.length >= 10) {
      return obj.target_date.slice(0, 10);
    }
    return null;
  };

  let rows: unknown[] = [];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.predictions)) rows = obj.predictions;
    else if (Array.isArray(obj.forecast)) rows = obj.forecast;
    else if (Array.isArray(obj.forecasts)) rows = obj.forecasts;
    else if (Array.isArray(obj.values)) rows = obj.values;
    else if (Array.isArray(obj.results)) rows = obj.results;
    else if (Array.isArray(obj.output)) rows = obj.output;
    else if (Array.isArray(obj.yhat)) {
      rows = obj.yhat.map((value, idx) => ({ ds: targetDates[idx], yhat: value }));
    } else if (Array.isArray(obj.predicted_values)) {
      rows = obj.predicted_values.map((value, idx) => ({ ds: targetDates[idx], yhat: value }));
    }
  }

  if (!rows.length) {
    throw new Error("LLM 예측 응답에서 predictions 배열을 찾지 못했습니다.");
  }

  const byDate = new Map<string, number>();
  const inOrder: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const yhat = getYhat(row);
    if (yhat == null) continue;
    const ds = getDs(row);
    if (ds) byDate.set(ds, yhat);
    inOrder.push(yhat);
  }

  const aligned = targetDates.map((ds, idx) => {
    const dated = byDate.get(ds);
    if (typeof dated === "number") return dated;
    if (idx < inOrder.length) return inOrder[idx];
    return null;
  });
  return completePredictionList(aligned, targetDates.length);
};

const parseByHeuristics = (raw: string, targetDates: string[]) => {
  const byDate = new Map<string, number>();
  const dateValueRegex = /(\d{4}-\d{2}-\d{2})[^\d-]*(-?\d+(?:\.\d+)?)/g;
  for (const match of raw.matchAll(dateValueRegex)) {
    const ds = match[1];
    const value = Number(match[2]);
    if (targetDates.includes(ds) && Number.isFinite(value)) {
      byDate.set(ds, value);
    }
  }

  const ordered: number[] = [];
  const keyValueRegex =
    /(?:yhat|y_hat|pred|prediction|predicted|forecast|value|mean)\s*["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  for (const match of raw.matchAll(keyValueRegex)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) ordered.push(value);
  }

  const genericNumberRegex = /-?\d+(?:\.\d+)?/g;
  if (!ordered.length) {
    for (const match of raw.matchAll(genericNumberRegex)) {
      const value = Number(match[0]);
      if (Number.isFinite(value)) ordered.push(value);
    }
  }

  const aligned = targetDates.map((ds, idx) => {
    const dated = byDate.get(ds);
    if (typeof dated === "number") return dated;
    if (idx < ordered.length) return ordered[idx];
    return null;
  });
  return completePredictionList(aligned, targetDates.length);
};

const runLinearFallbackForecast = (train: TimeSeriesPoint[], horizon: number) => {
  const n = train.length;
  if (n <= 0) return Array.from({ length: horizon }, () => 0);
  if (n === 1) return Array.from({ length: horizon }, () => train[0].y);

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i + 1;
    const y = train[i].y;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return Array.from({ length: horizon }, (_, idx) => {
    const x = n + idx + 1;
    return Number((intercept + slope * x).toFixed(6));
  });
};

const calcMetrics = (actual: number[], predicted: number[]) => {
  const n = Math.min(actual.length, predicted.length);
  let absErr = 0;
  let sqErr = 0;
  let mapeSum = 0;
  let mapeCount = 0;
  for (let i = 0; i < n; i += 1) {
    const a = actual[i];
    const p = predicted[i];
    const err = p - a;
    absErr += Math.abs(err);
    sqErr += err * err;
    if (a !== 0) {
      mapeSum += Math.abs(err / a);
      mapeCount += 1;
    }
  }
  return {
    mae: n ? Number((absErr / n).toFixed(4)) : null,
    rmse: n ? Number(Math.sqrt(sqErr / n).toFixed(4)) : null,
    mape: mapeCount ? Number(((mapeSum / mapeCount) * 100).toFixed(4)) : null,
  };
};

const FORECAST_METHOD_ALIASES: Record<string, string> = {
  prophet: "prophet",
  linear_trend: "linear_trend",
  arima: "arima",
  sarima: "sarima",
  chronos_2: "chronos_2",
  chronos_bolt_base: "chronos_bolt_base",
  timesfm_2_5_200m: "timesfm_2_5_200m",
  "linear trend": "linear_trend",
  "chronos-2": "chronos_2",
  "chronos-bolt base": "chronos_bolt_base",
  "timesfm 2.5 200m": "timesfm_2_5_200m",
};

const normalizeForecastMethod = (method?: string | null) => {
  const raw = (method ?? "").trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  return FORECAST_METHOD_ALIASES[lowered] ?? lowered;
};

type ForecastInstructionStrength = "relaxed" | "balanced" | "strict";

const normalizeForecastInstructionStrength = (
  value?: string | null,
): ForecastInstructionStrength => {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "relaxed" || raw === "strict") return raw;
  return "balanced";
};

const buildMethodInstructionLines = (normalizedMethod: string | null) => {
  switch (normalizedMethod) {
    case "prophet":
      return [
        "- Prophet 계열 접근(추세 + 잠재적 변화점 + 계절성 가능성)을 참고해 예측하세요.",
        "- 급격한 구조 변화가 없으면 완만한 추세 연장을 우선 고려하세요.",
      ];
    case "linear_trend":
      return [
        "- 선형 추세 회귀를 기본으로 하되, 최근 구간의 방향성과 기울기를 더 크게 반영하세요.",
        "- 과도한 급등/급락은 완화해 현실적인 수준으로 예측하세요.",
      ];
    case "arima":
      return [
        "- ARIMA 계열 접근을 참고하세요. 필요 시 1차 차분 기반으로 추세 안정화를 가정하세요.",
        "- 최근 3~12개월 자기상관과 변화율을 반영해 다단계 예측을 생성하세요.",
      ];
    case "sarima":
      return [
        "- SARIMA 계열 접근을 참고해 비계절 + 계절 성분(월별 주기 가능성)을 함께 고려하세요.",
        "- 계절 신호가 약하면 비계절 성분 비중을 높여 안정적으로 예측하세요.",
      ];
    case "chronos_2":
    case "chronos_bolt_base":
    case "timesfm_2_5_200m":
      return [
        `- ${normalizedMethod} 스타일의 시계열 foundation 모델 접근을 참고해 패턴 기반 예측을 수행하세요.`,
        "- 최근 패턴과 장기 패턴을 함께 보되, 후반 horizon으로 갈수록 변화폭이 과도해지지 않게 하세요.",
      ];
    default:
      return [
        "- 지정 기법이 없으면 시계열의 수준(level), 추세(trend), 최근 변화율을 종합해 합리적으로 예측하세요.",
      ];
  }
};

const normalizeModelType = (value: unknown): ForecastModelType | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  const aliases: Record<string, ForecastModelType> = {
    prophet: "prophet",
    arima: "arima",
    sarima: "sarima",
    linear_trend: "linear_trend",
    "linear trend": "linear_trend",
    chronos_2: "chronos_2",
    chronos2: "chronos_2",
    chronos_bolt_base: "chronos_bolt_base",
    chronos_bolt: "chronos_bolt_base",
    timesfm_2_5_200m: "timesfm_2_5_200m",
    timesfm: "timesfm_2_5_200m",
  };
  return aliases[normalized] ?? null;
};

const buildMethodSelectionPrompt = (
  meta: SeriesMeta,
  trainPoints: TimeSeriesPoint[],
  targetDates: string[],
  hintMethod?: string | null,
) => {
  const recentTrain = trainPoints.slice(-120);
  return [
    "당신은 시계열 모델 라우터입니다.",
    "목표: 아래 7개 중 단 하나의 model_type을 고르고 JSON만 반환하세요.",
    "허용 model_type: prophet, arima, sarima, linear_trend, chronos_bolt_base, chronos_2, timesfm_2_5_200m",
    "반드시 기존 Python forecast API에서 실행 가능한 model_type만 선택하세요.",
    "",
    `series_id: ${meta.seriesId}`,
    `series_name: ${meta.seriesNameKo ?? "-"}`,
    `freq: ${meta.freqCd ?? "-"}`,
    `hint_method: ${hintMethod ?? "-"}`,
    "",
    "[train_data]",
    ...recentTrain.map((row) => `${row.ds},${row.y}`),
    "",
    "[target_dates]",
    ...targetDates,
    "",
    "[출력 형식] JSON ONLY",
    '{ "model_type": "prophet", "reason": "한 줄 이내" }',
  ].join("\n");
};

const parseSelectedModelType = (
  llmText: string,
  fallback: ForecastModelType,
): { modelType: ForecastModelType; reason: string | null } => {
  const extracted = extractJsonText(llmText);
  const parsed = parseJsonSafe(extracted);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const selected = normalizeModelType(obj.model_type);
    if (selected && ALLOWED_MODEL_TYPES.has(selected)) {
      return {
        modelType: selected,
        reason: typeof obj.reason === "string" ? obj.reason : null,
      };
    }
  }
  const heuristic =
    normalizeModelType(llmText.match(/prophet|arima|sarima|linear_trend|chronos_2|chronos_bolt_base|timesfm_2_5_200m/i)?.[0]) ??
    fallback;
  return { modelType: heuristic, reason: "LLM JSON 파싱 실패로 휴리스틱 선택" };
};

const runPythonForecastApi = async (
  seriesId: string,
  horizonMonths: number,
  modelType: ForecastModelType,
  points: TimeSeriesPoint[],
) => {
  const targetUrl =
    modelType === "timesfm_2_5_200m" ? TIMESFM_FORECAST_API_URL : PYTHON_FORECAST_API_URL;
  const timeoutMs =
    modelType === "timesfm_2_5_200m" ? TIMESFM_FORECAST_TIMEOUT_MS : PYTHON_FORECAST_TIMEOUT_MS;
  const response = await fetchWithTimeout(
    targetUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        series_id: seriesId,
        horizon_months: horizonMonths,
        model_type: modelType,
        data: points,
      }),
    },
    timeoutMs,
  );
  const rawBody = await response.text();
  const parsed = parseJsonSafe(rawBody) as
    | (PythonForecastResponse & { detail?: string | { message?: string } })
    | null;
  if (!response.ok) {
    const detail =
      typeof parsed?.detail === "string"
        ? parsed.detail
        : typeof parsed?.detail === "object" && parsed?.detail
          ? JSON.stringify(parsed.detail)
          : rawBody;
    throw new Error(detail || "Python 예측 API 호출에 실패했습니다.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Python 예측 API 응답이 JSON 형식이 아닙니다.");
  }
  return parsed as PythonForecastResponse;
};

const buildForecastPrompt = (
  meta: SeriesMeta,
  trainPoints: TimeSeriesPoint[],
  targetDates: string[],
  options?: {
    requestedMethod?: string | null;
    instructionStrength?: ForecastInstructionStrength;
  },
) => {
  const recentTrain = trainPoints.slice(-120);
  const requestedMethodRaw = options?.requestedMethod?.trim() || null;
  const requestedMethod = normalizeForecastMethod(requestedMethodRaw);
  const methodInstructionLines = buildMethodInstructionLines(requestedMethod);
  const instructionStrength = options?.instructionStrength ?? "balanced";
  const strengthInstructionLine =
    instructionStrength === "strict"
      ? "- requested_method를 우선 기준으로 내부 추론을 고정하고, 형식/제약 위반 없이 보수적으로 예측합니다."
      : instructionStrength === "relaxed"
        ? "- requested_method를 참고하되, 데이터 패턴과 일관성이 더 높으면 유사 접근으로 유연하게 보정할 수 있습니다."
        : "- requested_method를 우선 참고하되, 데이터 패턴과 충돌 시 합리적인 범위에서 보정합니다.";
  return [
    "당신은 시계열 예측 모델입니다.",
    "월별 단변량 시계열의 학습 데이터만 사용해 target_dates에 대한 미래값을 예측합니다.",
    "",
    "[입력 해석 규칙]",
    "- 외부 데이터, 실제 미래값, 웹 검색, 추가 경제지표를 사용하지 않습니다.",
    "- 오직 [train_data] 값만 근거로 예측합니다.",
    "- train_data를 날짜 오름차순 월별 등간격 시계열로 해석합니다.",
    "",
    "[분석 방식]",
    requestedMethod
      ? `- requested_method: ${requestedMethod}`
      : "- requested_method: auto",
    `- instruction_strength: ${instructionStrength}`,
    strengthInstructionLine,
    ...methodInstructionLines,
    "- 12개월 다단계 예측에서는 후반부로 갈수록 변화폭이 완만해질 수 있습니다.",
    "- 예측값은 현실적인 범위의 유한 실수로 생성합니다.",
    "",
    `series_id: ${meta.seriesId}`,
    `series_name: ${meta.seriesNameKo ?? "-"}`,
    `unit: ${meta.unitName ?? "-"}`,
    `freq: ${meta.freqCd ?? "-"}`,
    `[requested_method] ${requestedMethod ?? "-"}`,
    "",
    "[train_data]",
    ...recentTrain.map((row) => `${row.ds},${row.y}`),
    "",
    "[target_dates]",
    ...targetDates,
    "",
    "[출력 형식]",
    "- JSON 외의 텍스트(설명/주석/코드블록)를 출력하지 않습니다.",
    "- predictions 배열 길이는 target_dates 개수와 동일해야 합니다.",
    "- ds는 target_dates와 완전히 동일한 문자열/순서여야 합니다.",
    "- yhat는 숫자형이어야 하며 NaN/Infinity/문자열은 금지입니다.",
    "",
    "JSON ONLY:",
    "{",
    '  "predictions": [',
    '    { "ds": "YYYY-MM-DD", "yhat": 0.0 }',
    "  ]",
    "}",
  ].join("\n");
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let payload: RunPayload | null = null;
  try {
    payload = (await request.json()) as RunPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "요청 본문이 비어있습니다." }, { status: 400 });
  }

  const seriesId = (payload?.seriesId ?? "").trim();
  const horizonMonths = Math.max(1, Math.min(24, Number(payload?.horizonMonths ?? 12) || 12));
  const executionMode = payload?.executionMode === "llm_select_python" ? "llm_select_python" : "llm_direct";
  const previewOnly = payload?.previewOnly === true;
  const useCodeInterpreter = payload?.useCodeInterpreter === true;
  const asyncExecution = payload?.asyncExecution === true;
  const pollResponseId = (payload?.pollResponseId ?? "").trim();
  const enableLlmSummary = payload?.enableLlmSummary === true;
  const requestedForecastMethod = (payload?.forecastMethod ?? "").trim() || null;
  const fallbackModelType =
    normalizeModelType(requestedForecastMethod) ?? ("prophet" as ForecastModelType);
  const forecastInstructionStrength = normalizeForecastInstructionStrength(
    payload?.forecastInstructionStrength,
  );
  const selectedProvider = payload?.provider === "openai" ? "openai" : "ollama";
  const requestedModel = (payload?.ollamaModel ?? "").trim();
  const requestedOpenAiModel = (payload?.openaiModel ?? "").trim();
  const selectedOllamaModel = normalizeOllamaModelName(
    requestedModel && ALLOWED_OLLAMA_MODELS.has(requestedModel)
      ? requestedModel
      : (OLLAMA_MODEL ?? "").trim(),
  );
  const selectedOpenAiModel = requestedOpenAiModel || (OPENAI_MODEL ?? "").trim();
  const requestedTemperature = toFiniteNumber(payload?.temperature);
  if (!seriesId) {
    return NextResponse.json({ ok: false, error: "seriesId가 필요합니다." }, { status: 400 });
  }
  if (selectedProvider === "ollama" && (!OLLAMA_URL || !selectedOllamaModel)) {
    return NextResponse.json(
      { ok: false, error: "OLLAMA_URL 또는 OLLAMA_MODEL(또는 요청 모델) 설정이 필요합니다." },
      { status: 400 },
    );
  }
  if (selectedProvider === "openai" && (!OPENAI_API_KEY || !selectedOpenAiModel)) {
    return NextResponse.json(
      { ok: false, error: "OPENAI_API_KEY 또는 OPENAI_MODEL(또는 요청 모델) 설정이 필요합니다." },
      { status: 400 },
    );
  }
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }

  const client = createDbClient();
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    await connectWithTimeout(client);

    const metaResult = await client.query(
      `
        select
          series_id,
          series_name_ko,
          unit_name,
          freq_cd,
          domain_large,
          domain_small,
          is_representative
        from dp.ts_monthly_series_mst
        where series_id = $1
        limit 1
      `,
      [seriesId],
    );
    if (!metaResult.rowCount) {
      return NextResponse.json({ ok: false, error: "시계열 메타를 찾을 수 없습니다." }, { status: 404 });
    }

    const dataResult = await client.query(
      `
        select
          base_date::text as base_date,
          value_num
        from dp.ts_monthly_series_data
        where series_id = $1
          and value_num is not null
        order by base_date asc
      `,
      [seriesId],
    );
    const points: TimeSeriesPoint[] = dataResult.rows.map((row) => ({
      ds: String(row.base_date).slice(0, 10),
      y: Number(row.value_num),
    }));
    if (points.length < 24) {
      return NextResponse.json(
        { ok: false, error: "예측을 위해 최소 24개 이상의 시계열 데이터가 필요합니다." },
        { status: 400 },
      );
    }
    if (points.length <= horizonMonths) {
      return NextResponse.json(
        { ok: false, error: "데이터 개수는 horizonMonths보다 커야 합니다." },
        { status: 400 },
      );
    }

    const train = points.slice(0, -horizonMonths);
    const test = points.slice(-horizonMonths);
    const targetDates = test.map((row) => row.ds);

    const metaRow = metaResult.rows[0];
    const meta: SeriesMeta = {
      seriesId: String(metaRow.series_id),
      seriesNameKo: (metaRow.series_name_ko as string | null) ?? null,
      unitName: (metaRow.unit_name as string | null) ?? null,
      freqCd: (metaRow.freq_cd as string | null) ?? null,
      domainLarge: (metaRow.domain_large as string | null) ?? null,
      domainSmall: (metaRow.domain_small as string | null) ?? null,
      isRepresentative: String(metaRow.is_representative ?? "N") === "Y",
    };

    const prompt = buildForecastPrompt(meta, train, targetDates, {
      requestedMethod: requestedForecastMethod,
      instructionStrength: forecastInstructionStrength,
    });
    const methodSelectionPrompt = buildMethodSelectionPrompt(
      meta,
      train,
      targetDates,
      requestedForecastMethod,
    );
    const customPrompt = (payload?.customPrompt ?? "").trim();
    const effectivePrompt = customPrompt || prompt;
    if (previewOnly) {
      return NextResponse.json({
        ok: true,
        prompt: executionMode === "llm_select_python" ? methodSelectionPrompt : prompt,
        seriesId,
        horizonMonths,
        requestedForecastMethod,
        executionMode,
        provider: selectedProvider,
        model: selectedProvider === "openai" ? selectedOpenAiModel : selectedOllamaModel,
        codeInterpreterUsed: selectedProvider === "openai" && useCodeInterpreter,
      });
    }

    if (executionMode === "llm_select_python") {
      const selectionPrompt = customPrompt || methodSelectionPrompt;
      const llmSelectStartedAt = Date.now();
      const methodSelectorResult =
        selectedProvider === "openai"
          ? await callOpenAi(selectedOpenAiModel, selectionPrompt, requestedTemperature)
          : await callOllama(selectedOllamaModel, selectionPrompt, requestedTemperature);
      const llmSelectionElapsedMs = Date.now() - llmSelectStartedAt;
      const parsedSelection = parseSelectedModelType(methodSelectorResult.text, fallbackModelType);

      const pythonStartedAt = Date.now();
      const pythonPayload = await runPythonForecastApi(
        seriesId,
        horizonMonths,
        parsedSelection.modelType,
        points,
      );
      const pythonElapsedMs = Date.now() - pythonStartedAt;

      const byDs = new Map<string, number>();
      (pythonPayload.forecast ?? []).forEach((item) => {
        if (item && typeof item.ds === "string" && typeof item.yhat === "number") {
          byDs.set(item.ds.slice(0, 10), item.yhat);
        }
      });
      const yhatList = targetDates.map((ds, idx) => {
        const dated = byDs.get(ds);
        if (typeof dated === "number" && Number.isFinite(dated)) return dated;
        const fallback = pythonPayload.forecast?.[idx]?.yhat;
        if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
        return train[train.length - 1]?.y ?? 0;
      });

      const actualList = test.map((row) => row.y);
      const metrics = {
        mae: toFiniteNumber(pythonPayload.metrics?.mae),
        rmse: toFiniteNumber(pythonPayload.metrics?.rmse),
        mape: toFiniteNumber(pythonPayload.metrics?.mape),
      };
      const forecastRows: LlmForecastItem[] = targetDates.map((ds, idx) => ({
        ds,
        yhat: yhatList[idx],
        actual: actualList[idx],
      }));
      const compositeScore = buildForecastCompositeScore(metrics, forecastRows);

      let llmSummary: string | null = null;
      let llmWarning: string | null = parsedSelection.reason;
      let summaryElapsedMs = 0;
      let summaryTokenUsage: TokenUsage | null = null;
      const summaryOllamaModel = (OLLAMA_MODEL ?? "").trim();
      if (enableLlmSummary && OLLAMA_URL && summaryOllamaModel) {
        const summaryPrompt = buildLlmForecastSummaryPrompt(meta, points, forecastRows, metrics, {
          predictionLabel: `python:${pythonPayload.model}`,
          trainCount: train.length,
          testCount: test.length,
          trainStart: train[0]?.ds ?? null,
          trainEnd: train[train.length - 1]?.ds ?? null,
          testStart: test[0]?.ds ?? null,
          testEnd: test[test.length - 1]?.ds ?? null,
          usedLinearFallback: false,
        });
        const summaryT0 = Date.now();
        try {
          const summaryResult = await callOllamaPlainText(
            summaryOllamaModel,
            summaryPrompt,
            OLLAMA_TIMEOUT_MS,
          );
          llmSummary = summaryResult.text || null;
          summaryTokenUsage = summaryResult.tokenUsage;
        } catch (error) {
          const summaryError = error instanceof Error ? error.message : "Ollama 요약 호출 실패";
          llmWarning = llmWarning ? `${llmWarning} / LLM 요약 실패: ${summaryError}` : `LLM 요약 실패: ${summaryError}`;
        }
        summaryElapsedMs = Date.now() - summaryT0;
      }

      const forecastTokenUsage: TokenUsage = methodSelectorResult.tokenUsage;
      const totalPromptTokens =
        forecastTokenUsage.promptTokens != null || summaryTokenUsage?.promptTokens != null
          ? (forecastTokenUsage.promptTokens ?? 0) + (summaryTokenUsage?.promptTokens ?? 0)
          : null;
      const totalCompletionTokens =
        forecastTokenUsage.completionTokens != null || summaryTokenUsage?.completionTokens != null
          ? (forecastTokenUsage.completionTokens ?? 0) +
            (summaryTokenUsage?.completionTokens ?? 0)
          : null;
      const totalTokenUsage: TokenUsage = {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens:
          totalPromptTokens != null || totalCompletionTokens != null
            ? (totalPromptTokens ?? 0) + (totalCompletionTokens ?? 0)
            : null,
      };

      return NextResponse.json({
        ok: true,
        meta,
        model: pythonPayload.model,
        llmProvider: methodSelectorResult.provider,
        llmModel: methodSelectorResult.model,
        codeInterpreterUsed: false,
        totalElapsedMs: Date.now() - startedAt,
        llmElapsedMs: llmSelectionElapsedMs,
        pythonElapsedMs,
        summaryElapsedMs: summaryElapsedMs || null,
        summaryLlmModel: enableLlmSummary ? summaryOllamaModel || null : null,
        llmSummaryEnabled: enableLlmSummary,
        requestedForecastMethod: parsedSelection.modelType,
        forecastTokenUsage,
        summaryTokenUsage,
        totalTokenUsage,
        llmSummary,
        llmWarning,
        metrics,
        compositeScore,
        seriesId,
        horizonMonths,
        trainCount: train.length,
        testCount: test.length,
        trainStart: train[0]?.ds ?? null,
        trainEnd: train[train.length - 1]?.ds ?? null,
        testStart: test[0]?.ds ?? null,
        testEnd: test[test.length - 1]?.ds ?? null,
        history: points,
        forecast: forecastRows,
        llmPrompt: selectionPrompt,
        llmRawOutput: methodSelectorResult.text.trim() || null,
        llmCodeInterpreterTrace: null,
      });
    }

    if (selectedProvider === "openai" && useCodeInterpreter && !pollResponseId && asyncExecution) {
      const started = await startOpenAiCodeInterpreterBackground(
        selectedOpenAiModel,
        effectivePrompt,
        requestedTemperature,
      );
      return NextResponse.json({
        ok: true,
        pending: true,
        pollResponseId: started.responseId,
        pollStatus: started.status,
        codeInterpreterUsed: true,
        llmProvider: "openai",
        llmModel: selectedOpenAiModel,
      });
    }

    const llmStartedAt = Date.now();
    let forecastWarning: string | null = null;
    const callForecastLlm = async (promptText: string) => {
      try {
        return selectedProvider === "openai"
          ? useCodeInterpreter
            ? await callOpenAiWithCodeInterpreter(
                selectedOpenAiModel,
                promptText,
                requestedTemperature,
              )
            : await callOpenAi(selectedOpenAiModel, promptText, requestedTemperature)
          : await callOllama(selectedOllamaModel, promptText, requestedTemperature);
      } catch (error) {
        const normalizedError =
          selectedProvider === "openai"
            ? toReadableOpenAiError(
                error,
                useCodeInterpreter ? OPENAI_CODE_INTERPRETER_TIMEOUT_MS : 120000,
              )
            : error instanceof Error
              ? error
              : new Error("LLM 호출 실패");
        const message = normalizedError.message;
        if (requestedTemperature != null && isTemperatureUnsupportedError(message)) {
          forecastWarning = `선택한 모델이 temperature=${requestedTemperature} 설정을 지원하지 않아 기본값으로 재시도했습니다.`;
          return selectedProvider === "openai"
            ? useCodeInterpreter
              ? await callOpenAiWithCodeInterpreter(selectedOpenAiModel, promptText, null)
              : await callOpenAi(selectedOpenAiModel, promptText, null)
            : await callOllama(selectedOllamaModel, promptText, null);
        }
        throw normalizedError;
      }
    };

    let llmCallResult:
      | Awaited<ReturnType<typeof callOllama>>
      | Awaited<ReturnType<typeof callOpenAi>>
      | Awaited<ReturnType<typeof callOpenAiWithCodeInterpreter>>;

    if (selectedProvider === "openai" && useCodeInterpreter && pollResponseId) {
      const polled = await fetchOpenAiResponsesObject(pollResponseId);
      const polledStatus = (polled.status ?? "").trim().toLowerCase();
      if (!isOpenAiResponsesCompleted(polledStatus)) {
        if (isOpenAiResponsesTerminalError(polledStatus)) {
          return NextResponse.json(
            {
              ok: false,
              error: polled.error?.message || `OpenAI background 작업이 ${polled.status} 상태로 종료되었습니다.`,
              pollResponseId,
              pollStatus: polled.status ?? polledStatus,
            },
            { status: 500 },
          );
        }
        return NextResponse.json({
          ok: true,
          pending: true,
          pollResponseId,
          pollStatus: polled.status ?? (polledStatus || "in_progress"),
          codeInterpreterUsed: true,
          llmProvider: "openai",
          llmModel: (polled.model ?? selectedOpenAiModel).trim() || selectedOpenAiModel,
        });
      }
      const polledText = extractResponseOutputText(polled);
      if (!polledText) {
        throw new Error("OpenAI Responses 완료 응답에서 출력 텍스트를 찾지 못했습니다.");
      }
      llmCallResult = {
        provider: "openai" as const,
        model: (polled.model ?? selectedOpenAiModel).trim() || selectedOpenAiModel,
        text: polledText,
        codeInterpreterTrace: extractCodeInterpreterTrace(polled),
        tokenUsage: buildTokenUsage(polled.usage?.input_tokens, polled.usage?.output_tokens),
      };
    } else {
      llmCallResult = await callForecastLlm(effectivePrompt);
    }

    const normalizedRequestedMethod = normalizeForecastMethod(requestedForecastMethod);
    if (selectedProvider === "openai" && useCodeInterpreter && normalizedRequestedMethod) {
      const initialTrace: CodeInterpreterTraceItem[] =
        "codeInterpreterTrace" in llmCallResult
          ? ((llmCallResult as { codeInterpreterTrace?: CodeInterpreterTraceItem[] | null })
              .codeInterpreterTrace ?? [])
          : [];
      let compliance = evaluateMethodCompliance(
        normalizedRequestedMethod,
        initialTrace,
        llmCallResult.text,
      );
      if (!compliance.ok) {
        const forcedPrompt = [
          effectivePrompt,
          "",
          "[강제 실행 제약]",
          `- 반드시 '${normalizedRequestedMethod}' 기법(또는 해당 라이브러리/동등 구현)을 코드에서 실제로 사용하세요.`,
          "- 다른 기법으로 대체하지 마세요.",
          "- 실행 코드/로그에 해당 기법 사용 흔적(import/클래스/함수 호출)이 나타나야 합니다.",
        ].join("\n");
        llmCallResult = await callForecastLlm(forcedPrompt);
        const retriedTrace: CodeInterpreterTraceItem[] =
          "codeInterpreterTrace" in llmCallResult
            ? ((llmCallResult as { codeInterpreterTrace?: CodeInterpreterTraceItem[] | null })
                .codeInterpreterTrace ?? [])
            : [];
        compliance = evaluateMethodCompliance(
          normalizedRequestedMethod,
          retriedTrace,
          llmCallResult.text,
        );
        if (!compliance.ok) {
          if (isFoundationRequestedMethod(normalizedRequestedMethod)) {
            forecastWarning = forecastWarning
              ? `${forecastWarning} / foundation 모델(${normalizedRequestedMethod}) 실행 흔적을 확인하지 못해 best-effort 결과로 진행했습니다. (${compliance.reason ?? "원인 미상"})`
              : `foundation 모델(${normalizedRequestedMethod}) 실행 흔적을 확인하지 못해 best-effort 결과로 진행했습니다. (${compliance.reason ?? "원인 미상"})`;
          } else {
            throw new Error(
              `선택한 분석기법(${normalizedRequestedMethod})으로 실행되지 않았습니다. ${compliance.reason ?? ""}`.trim(),
            );
          }
        } else {
          forecastWarning = forecastWarning
            ? `${forecastWarning} / 기법 미준수 1회 재시도 후 ${normalizedRequestedMethod} 실행 흔적을 확인했습니다.`
            : `기법 미준수 1회 재시도 후 ${normalizedRequestedMethod} 실행 흔적을 확인했습니다.`;
        }
      }
    }
    const llmElapsedMs = Date.now() - llmStartedAt;
    const llmText = llmCallResult.text;
    let usedLinearFallback = false;
    let yhatList: number[];
    try {
      const extracted = extractJsonText(llmText);
      const parsedForecast = parseJsonSafe(extracted);
      if (parsedForecast) {
        yhatList = normalizePredictions(parsedForecast, targetDates);
      } else {
        yhatList = parseByHeuristics(llmText, targetDates);
      }
      if (!yhatList.some((v) => Number.isFinite(v))) {
        throw new Error("no-valid-predictions");
      }
    } catch {
      usedLinearFallback = true;
      yhatList = runLinearFallbackForecast(train, targetDates.length);
    }
    const actualList = test.map((row) => row.y);
    const metrics = calcMetrics(actualList, yhatList);
    const forecastRows: LlmForecastItem[] = targetDates.map((ds, idx) => ({
      ds,
      yhat: yhatList[idx],
      actual: actualList[idx],
    }));
    const compositeScore = buildForecastCompositeScore(metrics, forecastRows);

    const predictionLabelForSummary = `${selectedProvider}:${llmCallResult.model}`;

    let llmSummary: string | null = null;
    let llmWarning: string | null = null;
    let summaryElapsedMs = 0;
    let summaryTokenUsage: TokenUsage | null = null;
    const summaryOllamaModel = (OLLAMA_MODEL ?? "").trim();

    if (enableLlmSummary && OLLAMA_URL && summaryOllamaModel) {
      const summaryPrompt = buildLlmForecastSummaryPrompt(meta, points, forecastRows, metrics, {
        predictionLabel: predictionLabelForSummary,
        trainCount: train.length,
        testCount: test.length,
        trainStart: train[0]?.ds ?? null,
        trainEnd: train[train.length - 1]?.ds ?? null,
        testStart: test[0]?.ds ?? null,
        testEnd: test[test.length - 1]?.ds ?? null,
        usedLinearFallback,
      });
      const summaryT0 = Date.now();
      let summaryError: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const summaryResult = await callOllamaPlainText(
            summaryOllamaModel,
            summaryPrompt,
            OLLAMA_TIMEOUT_MS,
          );
          llmSummary = summaryResult.text || null;
          summaryTokenUsage = summaryResult.tokenUsage;
          summaryError = null;
          break;
        } catch (error) {
          if (isAbortLikeError(error)) {
            summaryError = `응답 시간 초과(${Math.round(OLLAMA_TIMEOUT_MS / 1000)}초)`;
          } else {
            summaryError = error instanceof Error ? error.message : "Ollama 요약 호출 실패";
          }
        }
      }
      summaryElapsedMs = Date.now() - summaryT0;
      if (!llmSummary && summaryError) {
        llmWarning = `LLM 요약 실패: ${summaryError}`;
      }
    } else if (enableLlmSummary) {
      llmWarning = "OLLAMA_URL 또는 OLLAMA_MODEL 환경변수가 없어 요약을 생략했습니다.";
    }
    if (forecastWarning) {
      llmWarning = llmWarning ? `${forecastWarning} / ${llmWarning}` : forecastWarning;
    }

    const forecastTokenUsage: TokenUsage = llmCallResult.tokenUsage;
    const totalPromptTokens =
      forecastTokenUsage.promptTokens != null || summaryTokenUsage?.promptTokens != null
        ? (forecastTokenUsage.promptTokens ?? 0) + (summaryTokenUsage?.promptTokens ?? 0)
        : null;
    const totalCompletionTokens =
      forecastTokenUsage.completionTokens != null || summaryTokenUsage?.completionTokens != null
        ? (forecastTokenUsage.completionTokens ?? 0) + (summaryTokenUsage?.completionTokens ?? 0)
        : null;
    const totalTokens =
      totalPromptTokens != null || totalCompletionTokens != null
        ? (totalPromptTokens ?? 0) + (totalCompletionTokens ?? 0)
        : null;
    const totalTokenUsage: TokenUsage = {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
    };

    return NextResponse.json({
      ok: true,
      meta,
      model: "llm_direct_forecast",
      llmProvider: llmCallResult.provider,
      llmModel: llmCallResult.model,
      codeInterpreterUsed: selectedProvider === "openai" && useCodeInterpreter,
      totalElapsedMs: Date.now() - startedAt,
      llmElapsedMs,
      summaryElapsedMs: summaryElapsedMs || null,
      summaryLlmModel: enableLlmSummary ? summaryOllamaModel || null : null,
      llmSummaryEnabled: enableLlmSummary,
      requestedForecastMethod,
      forecastTokenUsage,
      summaryTokenUsage,
      totalTokenUsage,
      llmSummary,
      llmWarning,
      metrics,
      compositeScore,
      seriesId,
      horizonMonths,
      trainCount: train.length,
      testCount: test.length,
      trainStart: train[0]?.ds ?? null,
      trainEnd: train[train.length - 1]?.ds ?? null,
      testStart: test[0]?.ds ?? null,
      testEnd: test[test.length - 1]?.ds ?? null,
      history: points,
      forecast: forecastRows,
      llmPrompt: effectivePrompt,
      llmRawOutput: llmText.trim() || null,
      llmCodeInterpreterTrace:
        "codeInterpreterTrace" in llmCallResult ? llmCallResult.codeInterpreterTrace ?? null : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "분석 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
