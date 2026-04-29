import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";
import type { ForecastMetrics, ForecastPoint, SeriesMeta, TimeSeriesPoint } from "../_lib/types";

export const runtime = "nodejs";

type RunPayload = {
  seriesId?: string;
  horizonMonths?: number;
  modelType?:
    | "prophet"
    | "arima"
    | "sarima"
    | "linear_trend"
    | "chronos_bolt_base"
    | "chronos_2"
    | "timesfm_2_5_200m";
};

type PythonForecastResponse = {
  model: string;
  metrics: ForecastMetrics;
  history: TimeSeriesPoint[];
  forecast: Array<
    ForecastPoint & {
      actual?: number | null;
    }
  >;
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

type TokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

const parseJsonSafe = (raw: string) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const PYTHON_FORECAST_API_URL =
  process.env.PYTHON_FORECAST_API_URL ?? "http://127.0.0.1:8001/forecast";
const TIMESFM_FORECAST_API_URL =
  process.env.TIMESFM_FORECAST_API_URL ?? "http://127.0.0.1:8002/forecast";
const OLLAMA_URL = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const OLLAMA_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000) || 60000,
);
const ALLOWED_MODEL_TYPES = new Set([
  "prophet",
  "arima",
  "sarima",
  "linear_trend",
  "chronos_bolt_base",
  "chronos_2",
  "timesfm_2_5_200m",
]);

const fetchWithTimeout = async (
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

const isAbortLikeError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted|timeout/i.test(error.message);
};

const buildPrompt = (
  meta: SeriesMeta,
  history: TimeSeriesPoint[],
  forecast: Array<ForecastPoint & { actual?: number | null }>,
  metrics: ForecastMetrics,
  options: {
    model: string;
    trainCount: number;
    testCount: number;
    trainStart: string | null;
    trainEnd: string | null;
    testStart: string | null;
    testEnd: string | null;
    fallbackReason: string | null;
  },
) => {
  const recent = history.slice(-6);
  const holdoutRows = forecast.slice(0, 12);
  const holdoutWithActual = holdoutRows.filter(
    (item): item is ForecastPoint & { actual: number } =>
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
    "아래는 실제 데이터와 holdout 예측 평가 결과입니다.",
    "숫자에 근거해서 한국어로 간결하게 설명하세요. 과장/추측은 금지합니다.",
    "",
    `[시계열] ${meta.seriesNameKo ?? meta.seriesId} (${meta.seriesId})`,
    `[단위] ${meta.unitName ?? "-"}`,
    `[주기] ${meta.freqCd ?? "-"}`,
    `[모델] ${options.model}`,
    options.model === "linear_trend_fallback" && options.fallbackReason
      ? `[fallback 이유] ${options.fallbackReason}`
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
      const actual =
        typeof item.actual === "number" && Number.isFinite(item.actual) ? item.actual : null;
      const error = actual == null ? "N/A" : item.yhat - actual;
      return `- ${item.ds}: actual=${actual ?? "N/A"}, yhat=${item.yhat}, error=${error}, lower=${item.yhatLower ?? "N/A"}, upper=${item.yhatUpper ?? "N/A"}`;
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

const toNullableString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const toNullableNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizePythonPayload = (parsed: PythonForecastResponse) => {
  return {
    ...parsed,
    metrics: {
      mae: toNullableNumber(parsed.metrics?.mae),
      rmse: toNullableNumber(parsed.metrics?.rmse),
      mape: toNullableNumber(parsed.metrics?.mape),
    },
    fallback_reason: toNullableString(parsed.fallback_reason),
    train_start: toNullableString(parsed.train_start),
    train_end: toNullableString(parsed.train_end),
    test_start: toNullableString(parsed.test_start),
    test_end: toNullableString(parsed.test_end),
  };
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const parseOllamaTokenUsage = (parsed: { prompt_eval_count?: unknown; eval_count?: unknown } | null): TokenUsage => {
  const promptTokens = toFiniteNumber(parsed?.prompt_eval_count);
  const completionTokens = toFiniteNumber(parsed?.eval_count);
  const totalTokens =
    promptTokens != null || completionTokens != null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null;
  return { promptTokens, completionTokens, totalTokens };
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let payload: RunPayload | null = null;
  try {
    payload = (await request.json()) as RunPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  const seriesId = (payload?.seriesId ?? "").trim();
  const horizonMonths = Math.max(1, Math.min(24, Number(payload?.horizonMonths ?? 12) || 12));
  const modelType = ALLOWED_MODEL_TYPES.has(payload?.modelType ?? "")
    ? (payload?.modelType as
        | "prophet"
        | "arima"
        | "sarima"
        | "linear_trend"
        | "chronos_bolt_base"
        | "chronos_2"
        | "timesfm_2_5_200m")
    : "prophet";
  if (!seriesId) {
    return NextResponse.json(
      { ok: false, error: "seriesId가 필요합니다." },
      { status: 400 },
    );
  }

  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const client = createDbClient();
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
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
      return NextResponse.json(
        { ok: false, error: "시계열 메타를 찾을 수 없습니다." },
        { status: 404 },
      );
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
    if (points.length < 12) {
      return NextResponse.json(
        { ok: false, error: "예측을 위해 최소 12개 이상의 시계열 데이터가 필요합니다." },
        { status: 400 },
      );
    }

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

    const pythonStartedAt = Date.now();
    let pythonPayload: PythonForecastResponse | null = null;
    let pythonError: string | null = null;
    const targetForecastApiUrl =
      modelType === "timesfm_2_5_200m" ? TIMESFM_FORECAST_API_URL : PYTHON_FORECAST_API_URL;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          targetForecastApiUrl,
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
          35000,
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
          throw new Error("Python API 응답이 JSON 형식이 아닙니다.");
        }
        pythonPayload = normalizePythonPayload(parsed);
        pythonError = null;
        break;
      } catch (error) {
        pythonError = error instanceof Error ? error.message : "Python API 호출 실패";
      }
    }
    if (!pythonPayload) {
      return NextResponse.json(
        { ok: false, error: pythonError || "Python 예측 실행에 실패했습니다." },
        { status: 500 },
      );
    }
    const pythonElapsedMs = Date.now() - pythonStartedAt;

    let llmSummary: string | null = null;
    let llmWarning: string | null = null;
    let summaryElapsedMs: number | null = null;
    let summaryTokenUsage: TokenUsage | null = null;
    if (OLLAMA_URL && OLLAMA_MODEL) {
      const prompt = buildPrompt(
        meta,
        pythonPayload.history,
        pythonPayload.forecast,
        pythonPayload.metrics,
        {
          model: pythonPayload.model,
          trainCount: pythonPayload.train_count,
          testCount: pythonPayload.test_count,
          trainStart: pythonPayload.train_start,
          trainEnd: pythonPayload.train_end,
          testStart: pythonPayload.test_start,
          testEnd: pythonPayload.test_end,
          fallbackReason: pythonPayload.fallback_reason ?? null,
        },
      );
      let llmError: string | null = null;
      const summaryStartedAt = Date.now();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const ollamaResponse = await fetchWithTimeout(
            OLLAMA_URL,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
              }),
            },
            OLLAMA_TIMEOUT_MS,
          );
          const rawBody = await ollamaResponse.text();
          const parsed = parseJsonSafe(rawBody) as
            | { response?: string; error?: string; prompt_eval_count?: unknown; eval_count?: unknown }
            | null;
          if (!ollamaResponse.ok) {
            throw new Error(parsed?.error || rawBody || "Ollama 호출 실패");
          }
          llmSummary = (parsed?.response ?? "").trim() || null;
          summaryTokenUsage = parseOllamaTokenUsage(parsed);
          llmError = null;
          break;
        } catch (error) {
          if (isAbortLikeError(error)) {
            llmError = `응답 시간 초과(${Math.round(OLLAMA_TIMEOUT_MS / 1000)}초)`;
          } else {
            llmError = error instanceof Error ? error.message : "Ollama 호출 실패";
          }
        }
      }
      if (!llmSummary && llmError) {
        llmWarning = `LLM 요약 실패: ${llmError}`;
      }
      summaryElapsedMs = Date.now() - summaryStartedAt;
    } else {
      llmWarning = "OLLAMA_URL 또는 OLLAMA_MODEL 환경변수가 없어 요약을 생략했습니다.";
    }

    const totalTokenUsage: TokenUsage | null = summaryTokenUsage
      ? {
          promptTokens: summaryTokenUsage.promptTokens,
          completionTokens: summaryTokenUsage.completionTokens,
          totalTokens: summaryTokenUsage.totalTokens,
        }
      : null;

    return NextResponse.json({
      ok: true,
      meta,
      model: pythonPayload.model,
      metrics: pythonPayload.metrics,
      seriesId: pythonPayload.series_id,
      horizonMonths: pythonPayload.horizon_months,
      trainCount: pythonPayload.train_count,
      testCount: pythonPayload.test_count,
      trainStart: pythonPayload.train_start,
      trainEnd: pythonPayload.train_end,
      testStart: pythonPayload.test_start,
      testEnd: pythonPayload.test_end,
      fallbackReason: pythonPayload.fallback_reason ?? null,
      history: pythonPayload.history,
      forecast: pythonPayload.forecast,
      totalElapsedMs: Date.now() - startedAt,
      pythonElapsedMs,
      summaryElapsedMs,
      summaryTokenUsage,
      totalTokenUsage,
      llmSummary,
      llmWarning,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "분석 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

