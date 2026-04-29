import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../../ai-forecast/_lib/db";
import type { SeriesMeta, TimeSeriesPoint } from "../../ai-forecast/_lib/types";

export const runtime = "nodejs";

type RunPayload = {
  seriesId?: string;
  horizonMonths?: number;
  provider?: "ollama" | "openai";
  ollamaModel?: string;
  openaiModel?: string;
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

const OLLAMA_URL = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OLLAMA_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000) || 60000,
);
const ALLOWED_OLLAMA_MODELS = new Set([
  "qwen3:8b",
  "qwen3:4b",
  "gemma3:4b",
  "gemma4:e4b",
  "llama3.2:latest",
  "llama3.2:lates",
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

const callOllama = async (model: string, prompt: string) => {
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
        options: {
          temperature: 0.1,
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

const callOpenAi = async (model: string, prompt: string) => {
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
        temperature: 0.1,
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

const isAbortLikeError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted|timeout/i.test(error.message);
};

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

const buildForecastPrompt = (meta: SeriesMeta, trainPoints: TimeSeriesPoint[], targetDates: string[]) => {
  const recentTrain = trainPoints.slice(-120);
  return [
    "당신은 시계열 예측기입니다.",
    "아래 학습 구간 데이터만 보고 미래 값을 예측하세요.",
    "설명 문장 없이 JSON만 출력하세요.",
    "",
    `series_id: ${meta.seriesId}`,
    `series_name: ${meta.seriesNameKo ?? "-"}`,
    `unit: ${meta.unitName ?? "-"}`,
    `freq: ${meta.freqCd ?? "-"}`,
    "",
    "[train_data]",
    ...recentTrain.map((row) => `${row.ds},${row.y}`),
    "",
    "[target_dates]",
    ...targetDates,
    "",
    "출력 포맷(JSON ONLY):",
    "{",
    '  "predictions": [',
    '    { "ds": "YYYY-MM-DD", "yhat": 0.0 }',
    "  ]",
    "}",
    "rules:",
    "- target_dates와 동일한 개수로 반환",
    "- ds는 target_dates와 동일한 날짜",
    "- yhat는 숫자형",
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
  const selectedProvider = payload?.provider === "openai" ? "openai" : "ollama";
  const requestedModel = (payload?.ollamaModel ?? "").trim();
  const requestedOpenAiModel = (payload?.openaiModel ?? "").trim();
  const selectedOllamaModel = normalizeOllamaModelName(
    requestedModel && ALLOWED_OLLAMA_MODELS.has(requestedModel)
      ? requestedModel
      : (OLLAMA_MODEL ?? "").trim(),
  );
  const selectedOpenAiModel = requestedOpenAiModel || (OPENAI_MODEL ?? "").trim();
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

    const prompt = buildForecastPrompt(meta, train, targetDates);
    const llmStartedAt = Date.now();
    const llmCallResult =
      selectedProvider === "openai"
        ? await callOpenAi(selectedOpenAiModel, prompt)
        : await callOllama(selectedOllamaModel, prompt);
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

    const predictionLabelForSummary = `${selectedProvider}:${llmCallResult.model}`;

    let llmSummary: string | null = null;
    let llmWarning: string | null = null;
    let summaryElapsedMs = 0;
    let summaryTokenUsage: TokenUsage | null = null;
    const summaryOllamaModel = (OLLAMA_MODEL ?? "").trim();

    if (OLLAMA_URL && summaryOllamaModel) {
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
    } else {
      llmWarning = "OLLAMA_URL 또는 OLLAMA_MODEL 환경변수가 없어 요약을 생략했습니다.";
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
      totalElapsedMs: Date.now() - startedAt,
      llmElapsedMs,
      summaryElapsedMs: summaryElapsedMs || null,
      summaryLlmModel: summaryOllamaModel || null,
      forecastTokenUsage,
      summaryTokenUsage,
      totalTokenUsage,
      llmSummary,
      llmWarning,
      metrics,
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
      llmPrompt: prompt,
      llmRawOutput: llmText.trim() || null,
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
