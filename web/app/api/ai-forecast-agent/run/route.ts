import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../../ai-forecast/_lib/db";
import { buildForecastCompositeScore } from "../../ai-forecast/_lib/forecast-score";
import type {
  ForecastMetrics,
  ForecastPoint,
  SeriesMeta,
  TimeSeriesPoint,
} from "../../ai-forecast/_lib/types";

export const runtime = "nodejs";

type AgentRunPayload = {
  action?: "interpret" | "run";
  question?: string;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  chatProvider?: "rule" | "ollama" | "openai";
  chatModel?: string;
  selectedSeriesId?: string;
  horizonMonths?: number;
  modelType?: ModelType;
  analysisMode?: "holdout" | "future";
};

type ModelType =
  | "prophet"
  | "arima"
  | "sarima"
  | "linear_trend"
  | "chronos_bolt_base"
  | "chronos_2"
  | "timesfm_2_5_200m";

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

type CandidateRow = SeriesMeta & {
  score: number;
  tokenHits: number;
};

const MODEL_TYPES: ModelType[] = [
  "prophet",
  "arima",
  "sarima",
  "linear_trend",
  "chronos_bolt_base",
  "chronos_2",
  "timesfm_2_5_200m",
];

const PYTHON_FORECAST_API_URL =
  process.env.PYTHON_FORECAST_API_URL ?? "http://127.0.0.1:8001/forecast";
const TIMESFM_FORECAST_API_URL =
  process.env.TIMESFM_FORECAST_API_URL ?? "http://127.0.0.1:8002/forecast";
const OLLAMA_URL = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const PYTHON_FORECAST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.PYTHON_FORECAST_TIMEOUT_MS ?? 35000) || 35000,
);
const TIMESFM_FORECAST_TIMEOUT_MS = Math.max(
  60000,
  Number(process.env.TIMESFM_FORECAST_TIMEOUT_MS ?? 600000) || 600000,
);
const CHAT_TIMEOUT_MS = 20000;

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

const parseJsonSafe = (raw: string) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

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

const stopWords = new Set([
  "예측",
  "해줘",
  "해주세요",
  "분석",
  "하고",
  "싶어",
  "싶습니다",
  "개월",
  "월",
  "치",
  "데이터",
  "시계열",
  "으로",
  "로",
  "를",
  "을",
  "이",
  "가",
  "은",
  "는",
  "좀",
  "한번",
  "한",
  "줘",
]);

const parseHorizon = (question: string) => {
  const matched =
    question.match(/(\d+)\s*(?:개?월|months?)/i) ??
    question.match(/(?:horizon|기간)\s*(\d+)/i);
  const parsed = matched ? Number(matched[1]) : 12;
  return Math.max(1, Math.min(24, Number.isFinite(parsed) ? parsed : 12));
};

const addMonthsStart = (ymd: string, months: number) => {
  const dt = new Date(`${ymd}T00:00:00Z`);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth();
  const next = new Date(Date.UTC(y, m + months, 1));
  return next.toISOString().slice(0, 10);
};

const runLinearFutureBaseline = (points: TimeSeriesPoint[], horizonMonths: number) => {
  const values = points.map((item) => item.y);
  const n = values.length;
  let slope = 0;
  let intercept = values[n - 1] ?? 0;
  if (n >= 2) {
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i += 1) {
      const x = i + 1;
      const y = values[i];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }
    const denom = n * sumXX - sumX * sumX;
    slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    intercept = (sumY - slope * sumX) / n;
  }
  const lastDate = points[points.length - 1]?.ds;
  const forecast: Array<ForecastPoint & { actual?: number | null }> = [];
  if (!lastDate) return forecast;
  for (let i = 1; i <= horizonMonths; i += 1) {
    const ds = addMonthsStart(lastDate, i);
    const x = n + i;
    const yhat = intercept + slope * x;
    forecast.push({
      ds,
      yhat: Number(yhat.toFixed(4)),
      actual: null,
      yhatLower: null,
      yhatUpper: null,
    });
  }
  return forecast;
};

const maybeRewriteWithLlm = async (
  provider: "rule" | "ollama" | "openai",
  model: string | null,
  baseMessage: string,
  options: { candidates: CandidateRow[]; selectedModelType: string; horizonMonths: number; analysisMode: string },
) => {
  if (provider === "rule") return baseMessage;
  const candidateText = options.candidates
    .slice(0, 10)
    .map((item, idx) => `${idx + 1}) ${item.seriesNameKo ?? "-"} (${item.seriesId})`)
    .join("\n");
  const prompt = [
    "당신은 시계열 예측 대화 도우미입니다.",
    "아래의 기본 답변을 유지하되 한국어로 더 자연스럽고 명확하게 다듬어 주세요.",
    "반드시 핵심 사실을 바꾸지 말고, 6문장 이내로 작성하세요.",
    "",
    `[기본 답변]\n${baseMessage}`,
    "",
    `[후보 시계열]\n${candidateText || "(없음)"}`,
    `[현재 설정] model=${options.selectedModelType}, horizon=${options.horizonMonths}, mode=${options.analysisMode}`,
  ].join("\n");

  try {
    if (provider === "ollama") {
      if (!OLLAMA_URL) return baseMessage;
      const resolvedModel = model?.trim() || (OLLAMA_MODEL ?? "").trim();
      if (!resolvedModel) return baseMessage;
      const response = await fetchWithTimeout(
        OLLAMA_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: resolvedModel, prompt, stream: false }),
        },
        CHAT_TIMEOUT_MS,
      );
      const raw = await response.text();
      const parsed = parseJsonSafe(raw) as { response?: string; error?: string } | null;
      if (!response.ok) return baseMessage;
      return (parsed?.response ?? "").trim() || baseMessage;
    }

    if (provider === "openai") {
      if (!OPENAI_API_KEY) return baseMessage;
      const resolvedModel = model?.trim() || (OPENAI_MODEL ?? "").trim() || "gpt-4o-mini";
      const response = await fetchWithTimeout(
        `${OPENAI_BASE_URL}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: resolvedModel,
            temperature: 0.2,
            messages: [
              { role: "system", content: "You rewrite Korean product assistant messages." },
              { role: "user", content: prompt },
            ],
          }),
        },
        CHAT_TIMEOUT_MS,
      );
      const raw = await response.text();
      const parsed = parseJsonSafe(raw) as
        | { choices?: Array<{ message?: { content?: string } }> }
        | null;
      if (!response.ok) return baseMessage;
      return parsed?.choices?.[0]?.message?.content?.trim() || baseMessage;
    }
  } catch {
    return baseMessage;
  }

  return baseMessage;
};

const parsePreferredModel = (question: string): ModelType | null => {
  const normalized = question.toLowerCase();
  if (normalized.includes("timesfm")) return "timesfm_2_5_200m";
  if (normalized.includes("chronos-2") || normalized.includes("chronos2")) {
    return "chronos_2";
  }
  if (normalized.includes("chronos")) return "chronos_bolt_base";
  if (normalized.includes("sarima")) return "sarima";
  if (normalized.includes("arima")) return "arima";
  if (normalized.includes("prophet")) return "prophet";
  if (normalized.includes("linear")) return "linear_trend";
  return null;
};

const isCandidateListIntent = (text: string) => {
  const normalized = text.replace(/\s+/g, "");
  return (
    normalized.includes("다른시계열") ||
    normalized.includes("뭐있어") ||
    normalized.includes("목록") ||
    normalized.includes("리스트") ||
    normalized.includes("후보")
  );
};

const isAllSeriesIntent = (text: string) => {
  const normalized = text.replace(/[^\p{L}\p{N}]/gu, "").replace(/\s+/g, "");
  return (
    normalized.includes("전체시리즈") ||
    normalized.includes("전체목록") ||
    normalized.includes("전체리스트") ||
    (normalized.includes("전체") && (normalized.includes("시리즈") || normalized.includes("목록")))
  );
};

const isModelListIntent = (text: string) => {
  const normalized = text.replace(/[^\p{L}\p{N}]/gu, "").replace(/\s+/g, "");
  return (
    (normalized.includes("모델") || normalized.includes("분석모델") || normalized.includes("분석기법")) &&
    (normalized.includes("뭐") ||
      normalized.includes("무엇") ||
      normalized.includes("목록") ||
      normalized.includes("리스트") ||
      normalized.includes("종류") ||
      normalized.includes("있어"))
  );
};

const isCountIntent = (text: string) => {
  const normalized = text.replace(/[^\p{L}\p{N}]/gu, "").replace(/\s+/g, "");
  return normalized.includes("몇개") || normalized.includes("밖에") || normalized.includes("개뿐");
};

const normalizeKoreanToken = (token: string) =>
  token.replace(/(으로|로|를|을|이|가|은|는|와|과|도|만|랑|하고|에서|으로는|로는)$/u, "");

const inferSeriesFromUtterance = (
  utterance: string,
  candidates: CandidateRow[],
): CandidateRow | null => {
  const normalizedUtterance = normalizeText(normalizeKoreanToken(utterance));
  if (!normalizedUtterance) return null;
  for (const item of candidates) {
    const byId = normalizeText(item.seriesId);
    const byName = normalizeText(item.seriesNameKo ?? "");
    if ((byId && normalizedUtterance.includes(byId)) || (byName && normalizedUtterance.includes(byName))) {
      return item;
    }
  }
  return null;
};

const parseSeriesKeyword = (question: string) => {
  const simplified = question
    .replace(/\d+\s*(?:개?월|months?)/gi, " ")
    .replace(
      /(timesfm|chronos-2|chronos2|chronos|sarima|arima|prophet|linear trend|linear)/gi,
      " ",
    )
    .replace(/[?.,!]/g, " ")
    .trim();
  const tokens = simplified
    .split(/\s+/)
    .map((item) => normalizeKoreanToken(item.trim()))
    .filter((item) => item.length >= 2 && !stopWords.has(item));
  const keyword = tokens.join(" ").trim() || simplified.trim() || question.trim();
  return {
    keyword,
    tokens: Array.from(new Set(tokens)).slice(0, 8),
  };
};

const applyKeywordAliases = (input: string) => {
  const aliases: Array<[RegExp, string]> = [
    [/경기심리지수/g, "경제심리지수"],
    [/경기\s*심리지수/g, "경제심리지수"],
    [/소비자\s*물가/g, "소비자물가"],
  ];
  return aliases.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), input);
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

const buildBigrams = (value: string) => {
  const source = normalizeText(value);
  if (source.length <= 1) return new Set([source]);
  const out = new Set<string>();
  for (let i = 0; i < source.length - 1; i += 1) {
    out.add(source.slice(i, i + 2));
  }
  return out;
};

const jaccardSimilarity = (left: string, right: string) => {
  const a = buildBigrams(left);
  const b = buildBigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (!union) return 0;
  return intersection / union;
};

const buildLooseCandidates = (
  rows: Array<{
    series_id: unknown;
    series_name_ko: unknown;
    unit_name: unknown;
    freq_cd: unknown;
    domain_large: unknown;
    domain_small: unknown;
    is_representative: unknown;
  }>,
  parsedKeyword: { keyword: string; tokens: string[] },
): CandidateRow[] => {
  const keywordNorm = normalizeText(applyKeywordAliases(parsedKeyword.keyword));
  const tokenNorms = parsedKeyword.tokens.map(normalizeText).filter((item) => item.length > 0);

  const scored: CandidateRow[] = rows
    .map((row) => {
      const seriesId = String(row.series_id);
      const seriesNameKo = (row.series_name_ko as string | null) ?? null;
      const unitName = (row.unit_name as string | null) ?? null;
      const freqCd = (row.freq_cd as string | null) ?? null;
      const domainLarge = (row.domain_large as string | null) ?? null;
      const domainSmall = (row.domain_small as string | null) ?? null;
      const isRepresentative = String(row.is_representative ?? "N") === "Y";
      const merged = [seriesId, seriesNameKo, domainLarge, domainSmall]
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join(" ");
      const mergedNorm = normalizeText(merged);
      const similarity = keywordNorm ? jaccardSimilarity(keywordNorm, mergedNorm) : 0;
      const tokenHits = tokenNorms.filter((token) => mergedNorm.includes(token)).length;
      const phraseHit = keywordNorm && mergedNorm.includes(keywordNorm) ? 1 : 0;
      const score =
        similarity * 100 +
        tokenHits * 11 +
        phraseHit * 30 +
        (isRepresentative ? 5 : 0);
      return {
        seriesId,
        seriesNameKo,
        unitName,
        freqCd,
        domainLarge,
        domainSmall,
        isRepresentative,
        tokenHits,
        score,
      };
    })
    .sort((a, b) => b.score - a.score || b.tokenHits - a.tokenHits || a.seriesId.localeCompare(b.seriesId));

  return scored.slice(0, 7);
};

const normalizePythonPayload = (parsed: PythonForecastResponse) => ({
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
});

const computeLag12Autocorr = (values: number[]) => {
  const lag = 12;
  if (values.length <= lag + 1) return 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = lag; i < values.length; i += 1) {
    xs.push(values[i]);
    ys.push(values[i - lag]);
  }
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX <= 0 || varY <= 0) return 0;
  return cov / Math.sqrt(varX * varY);
};

const chooseModel = (
  preferred: ModelType | null,
  points: TimeSeriesPoint[],
): { modelType: ModelType; reason: string } => {
  if (preferred) {
    return {
      modelType: preferred,
      reason: "질문에서 특정 모델명이 감지되어 우선 적용했습니다.",
    };
  }
  const values = points.map((item) => item.y).filter(Number.isFinite);
  const n = values.length;
  const meanAbs = Math.max(
    1e-9,
    values.reduce((sum, v) => sum + Math.abs(v), 0) / Math.max(1, values.length),
  );
  const variance =
    values.reduce((sum, v) => sum + v * v, 0) / Math.max(1, values.length) -
    (values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)) ** 2;
  const std = Math.sqrt(Math.max(0, variance));
  const cv = std / meanAbs;
  const seasonality = computeLag12Autocorr(values);

  if (n >= 48 && seasonality >= 0.45) {
    return {
      modelType: "sarima",
      reason: "12개월 계절 상관이 높아 SARIMA를 선택했습니다.",
    };
  }
  if (n >= 72 && cv >= 0.18) {
    return {
      modelType: "chronos_2",
      reason: "변동성이 비교적 커 foundation 모델(Chronos-2)을 선택했습니다.",
    };
  }
  if (n >= 60 && cv >= 0.12) {
    return {
      modelType: "prophet",
      reason: "중간 수준 변동성과 추세/계절 가능성을 고려해 Prophet을 선택했습니다.",
    };
  }
  if (n >= 48) {
    return {
      modelType: "arima",
      reason: "변동성이 낮은 편이라 ARIMA를 선택했습니다.",
    };
  }
  return {
    modelType: "linear_trend",
    reason: "데이터 길이가 짧아 빠르고 안정적인 Linear Trend를 선택했습니다.",
  };
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let payload: AgentRunPayload | null = null;
  try {
    payload = (await request.json()) as AgentRunPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  const conversation = Array.isArray(payload?.conversation) ? payload?.conversation : [];
  const conversationUsers = conversation
    .filter((item) => item && item.role === "user" && typeof item.content === "string")
    .map((item) => item.content.trim())
    .filter((item) => item.length > 0);
  const latestUserQuestion = (payload?.question ?? "").trim();
  const question = latestUserQuestion || conversationUsers.slice(-6).join(" ");
  if (!question) {
    return NextResponse.json(
      { ok: false, error: "질문(question)이 필요합니다." },
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

  const action = payload?.action === "interpret" ? "interpret" : "run";
  const parsedHorizon = parseHorizon(question);
  const horizonMonths = Math.max(
    1,
    Math.min(24, Number(payload?.horizonMonths ?? parsedHorizon) || parsedHorizon),
  );
  const analysisMode = payload?.analysisMode === "future" ? "future" : "holdout";
  const requestedModel =
    typeof payload?.modelType === "string" && MODEL_TYPES.includes(payload.modelType)
      ? payload.modelType
      : null;
  const requestedSeriesId =
    typeof payload?.selectedSeriesId === "string" ? payload.selectedSeriesId.trim() : "";
  const chatProvider =
    payload?.chatProvider === "ollama" || payload?.chatProvider === "openai"
      ? payload.chatProvider
      : "rule";
  const chatModel = typeof payload?.chatModel === "string" ? payload.chatModel.trim() : "";
  const listIntent = isCandidateListIntent(latestUserQuestion || question);
  const allSeriesIntent = isAllSeriesIntent(latestUserQuestion || question);
  const modelListIntent = isModelListIntent(latestUserQuestion || question);
  const countIntent = isCountIntent(latestUserQuestion || question);
  const searchQuestion =
    (listIntent || modelListIntent) && conversationUsers.length > 1
      ? conversationUsers.slice(0, -1).join(" ")
      : question;
  const preferredModel = parsePreferredModel(searchQuestion);
  const parsedKeywordRaw = parseSeriesKeyword(searchQuestion);
  const parsedKeyword = {
    keyword: applyKeywordAliases(parsedKeywordRaw.keyword),
    tokens: parsedKeywordRaw.tokens.map((item) => applyKeywordAliases(item)),
  };

  try {
    await connectWithTimeout(client);
    const candidatesResult = await client.query(
      `
        with cte as (
          select
            series_id,
            series_name_ko,
            unit_name,
            freq_cd,
            domain_large,
            domain_small,
            is_representative,
            coalesce(
              (
                select count(*)
                from unnest($2::text[]) as tk
                where
                  series_id ilike '%' || tk || '%'
                  or coalesce(series_name_ko, '') ilike '%' || tk || '%'
                  or coalesce(domain_large, '') ilike '%' || tk || '%'
                  or coalesce(domain_small, '') ilike '%' || tk || '%'
              ),
              0
            ) as token_hits,
            (
              case
                when coalesce(series_name_ko, '') ilike '%' || $1 || '%' then 120
                when series_id ilike '%' || $1 || '%' then 110
                when coalesce(domain_large, '') ilike '%' || $1 || '%' then 80
                when coalesce(domain_small, '') ilike '%' || $1 || '%' then 70
                else 0
              end
            ) as phrase_score
          from dp.ts_monthly_series_mst
          where coalesce(use_yn, 'Y') = 'Y'
            and (
              $1::text = ''
              or series_id ilike '%' || $1 || '%'
              or coalesce(series_name_ko, '') ilike '%' || $1 || '%'
              or exists (
                select 1
                from unnest($2::text[]) as tk
                where
                  series_id ilike '%' || tk || '%'
                  or coalesce(series_name_ko, '') ilike '%' || tk || '%'
                  or coalesce(domain_large, '') ilike '%' || tk || '%'
                  or coalesce(domain_small, '') ilike '%' || tk || '%'
              )
            )
        )
        select
          series_id,
          series_name_ko,
          unit_name,
          freq_cd,
          domain_large,
          domain_small,
          is_representative,
          token_hits,
          phrase_score + (token_hits * 12) + (case when coalesce(is_representative, 'N') = 'Y' then 5 else 0 end) as score
        from cte
        order by score desc, token_hits desc, series_id asc
        limit 7
      `,
      [parsedKeyword.keyword, parsedKeyword.tokens],
    );

    let candidates: CandidateRow[] = candidatesResult.rows.map((row) => ({
      seriesId: String(row.series_id),
      seriesNameKo: (row.series_name_ko as string | null) ?? null,
      unitName: (row.unit_name as string | null) ?? null,
      freqCd: (row.freq_cd as string | null) ?? null,
      domainLarge: (row.domain_large as string | null) ?? null,
      domainSmall: (row.domain_small as string | null) ?? null,
      isRepresentative: String(row.is_representative ?? "N") === "Y",
      tokenHits: Number(row.token_hits ?? 0),
      score: Number(row.score ?? 0),
    }));

    if (allSeriesIntent) {
      const allSeriesResult = await client.query(
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
          where coalesce(use_yn, 'Y') = 'Y'
          order by
            case when coalesce(is_representative, 'N') = 'Y' then 0 else 1 end,
            coalesce(sort_ord, 999999),
            series_id
          limit 200
        `,
      );
      candidates = allSeriesResult.rows.map((row, idx) => ({
        seriesId: String(row.series_id),
        seriesNameKo: (row.series_name_ko as string | null) ?? null,
        unitName: (row.unit_name as string | null) ?? null,
        freqCd: (row.freq_cd as string | null) ?? null,
        domainLarge: (row.domain_large as string | null) ?? null,
        domainSmall: (row.domain_small as string | null) ?? null,
        isRepresentative: String(row.is_representative ?? "N") === "Y",
        tokenHits: 0,
        score: Math.max(0, 200 - idx),
      }));
    }

    if (!candidates.length) {
      const fallbackSeriesResult = await client.query(
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
          where coalesce(use_yn, 'Y') = 'Y'
          order by
            case when coalesce(is_representative, 'N') = 'Y' then 0 else 1 end,
            coalesce(sort_ord, 999999),
            series_id
          limit 5000
        `,
      );
      candidates = buildLooseCandidates(fallbackSeriesResult.rows, parsedKeyword);
    }

    if (!candidates.length) {
      const hintResult = await client.query(
        `
          select
            series_id,
            series_name_ko
          from dp.ts_monthly_series_mst
          where coalesce(use_yn, 'Y') = 'Y'
            and coalesce(is_representative, 'N') = 'Y'
          order by coalesce(sort_ord, 999999), series_id
          limit 10
        `,
      );
      return NextResponse.json(
        {
          ok: false,
          error:
            "질문에서 매칭되는 시계열을 찾지 못했습니다. 시계열명(예: 소비자물가지수, 경기심리지수)으로 다시 요청해주세요.",
          suggestions: hintResult.rows.map((row) => ({
            seriesId: String(row.series_id),
            seriesNameKo: (row.series_name_ko as string | null) ?? null,
          })),
          interpreted: {
            question,
            horizonMonths,
            preferredModel,
            seriesKeyword: parsedKeyword.keyword,
            seriesTokens: parsedKeyword.tokens,
          },
        },
        { status: 404 },
      );
    }

    if (!requestedSeriesId && latestUserQuestion) {
      const inferred = inferSeriesFromUtterance(latestUserQuestion, candidates);
      if (inferred) {
        candidates = [inferred, ...candidates.filter((item) => item.seriesId !== inferred.seriesId)];
      }
    }

    let selectedMeta = candidates[0];
    if (requestedSeriesId) {
      const exact = candidates.find((item) => item.seriesId === requestedSeriesId);
      if (exact) {
        selectedMeta = exact;
      } else {
        const pickedResult = await client.query(
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
              and coalesce(use_yn, 'Y') = 'Y'
            limit 1
          `,
          [requestedSeriesId],
        );
        if (pickedResult.rowCount) {
          const row = pickedResult.rows[0];
          selectedMeta = {
            seriesId: String(row.series_id),
            seriesNameKo: (row.series_name_ko as string | null) ?? null,
            unitName: (row.unit_name as string | null) ?? null,
            freqCd: (row.freq_cd as string | null) ?? null,
            domainLarge: (row.domain_large as string | null) ?? null,
            domainSmall: (row.domain_small as string | null) ?? null,
            isRepresentative: String(row.is_representative ?? "N") === "Y",
            tokenHits: 0,
            score: 0,
          };
        }
      }
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
      [selectedMeta.seriesId],
    );

    const points: TimeSeriesPoint[] = dataResult.rows.map((row) => ({
      ds: String(row.base_date).slice(0, 10),
      y: Number(row.value_num),
    }));
    if (points.length < 24) {
      return NextResponse.json(
        {
          ok: false,
          error: `선택 시계열(${selectedMeta.seriesId})의 데이터가 부족합니다. 최소 24개가 필요합니다.`,
          selectedSeries: selectedMeta,
        },
        { status: 400 },
      );
    }

    const autoChoice = chooseModel(preferredModel, points);
    const selectedModelType = requestedModel ?? autoChoice.modelType;
    const modelSelectionReason = requestedModel
      ? "사용자가 모델을 지정했습니다."
      : autoChoice.reason;

    if (action === "interpret") {
      const needsSeriesConfirmation = !requestedSeriesId && candidates.length > 1;
      const needsModelConfirmation = !requestedModel;
      const topCandidateText = candidates
        .slice(0, 5)
        .map((item, idx) => `${idx + 1}) ${item.seriesNameKo ?? "-"} (${item.seriesId})`)
        .join("\n");
      const wantsList = isCandidateListIntent(latestUserQuestion || question);
      let assistantMessage = wantsList
        ? allSeriesIntent
          ? `전체 시리즈 요청으로 현재 사용 가능한 시리즈 상위 ${Math.min(
              candidates.length,
              200,
            )}개를 불러왔습니다.\n${topCandidateText}\n원하는 시계열을 선택해 주세요.`
          : `현재 매칭된 시계열 후보입니다.\n${topCandidateText}\n원하는 시계열을 선택해 주세요.`
        : requestedSeriesId || candidates.length === 1
          ? `시계열 후보를 확인했습니다.\n${topCandidateText}\n필요하면 모델/기간/모드를 조정한 뒤 실행하세요. 준비되면 확정 실행을 누르세요.`
          : `질문과 정확히 일치하는 시계열을 찾지 못했습니다. ${
              selectedMeta.seriesNameKo ?? selectedMeta.seriesId
            }를 1순위로 추천합니다.\n후보 목록:\n${topCandidateText}\n진행할 시계열을 선택해주세요.`;

      if (modelListIntent) {
        assistantMessage = [
          "사용 가능한 분석 모델은 다음과 같습니다.",
          `- ${MODEL_TYPES.join(", ")}`,
          "대화형 응답 모델은 rule(기본), ollama, openai(gpt) 중에서 선택할 수 있습니다.",
          "원하면 예: '분석모델은 sarima로 하고, 대화모델은 openai gpt-4o-mini로 해줘' 처럼 말해 주세요.",
        ].join("\n");
      } else if (countIntent) {
        assistantMessage = `현재 조건에서 확인된 후보 시계열은 총 ${candidates.length}개입니다.\n상위 5개:\n${topCandidateText}`;
      }

      assistantMessage = await maybeRewriteWithLlm(
        chatProvider,
        chatModel || null,
        assistantMessage,
        {
          candidates,
          selectedModelType,
          horizonMonths,
          analysisMode,
        },
      );
      return NextResponse.json({
        ok: true,
        phase: "interpret",
        assistantMessage,
        clarification: {
          needsSeriesConfirmation,
          needsModelConfirmation,
          needsModeConfirmation: true,
          needsHorizonConfirmation: true,
        },
        interpreted: {
          question,
          seriesKeyword: parsedKeyword.keyword,
          seriesTokens: parsedKeyword.tokens,
          horizonMonths,
          preferredModel,
        },
        defaults: {
          selectedSeriesId: selectedMeta.seriesId,
          horizonMonths,
          analysisMode,
          modelType: selectedModelType,
        },
        selectedSeries: selectedMeta,
        candidateSeries: candidates,
        modelSelectionReason,
        selectableModels: MODEL_TYPES,
        selectableModes: ["holdout", "future"],
        selectableChatProviders: ["rule", "ollama", "openai"],
        chatProvider,
        chatModel: chatModel || null,
      });
    }

    if (analysisMode === "future") {
      const forecastRows = runLinearFutureBaseline(points, horizonMonths);
      const compositeScore = buildForecastCompositeScore(
        { mae: null, rmse: null, mape: null },
        forecastRows,
      );
      return NextResponse.json({
        ok: true,
        mode: "ai-forecast-agent",
        phase: "run",
        question,
        interpreted: {
          question,
          seriesKeyword: parsedKeyword.keyword,
          seriesTokens: parsedKeyword.tokens,
          horizonMonths,
          preferredModel,
        },
        selectedSeries: selectedMeta,
        candidateSeries: candidates,
        autoSelectedModel: selectedModelType,
        modelSelectionReason:
          selectedModelType === "linear_trend"
            ? "실제 미래예측 모드는 현재 선형 추세 baseline으로 제공합니다."
            : `실제 미래예측 모드는 현재 선형 추세 baseline만 지원하여 ${selectedModelType} 대신 linear_trend 기준으로 실행했습니다.`,
        runNotice:
          "future 모드는 테스트3에서 baseline(Linear Trend)로 동작합니다. 기존 모델별 future 모드는 별도 확장 필요.",
        model: "linear_trend_future_baseline",
        metrics: { mae: null, rmse: null, mape: null },
        compositeScore: {
          ...compositeScore,
          note: "실제 미래예측 모드는 holdout 실제값이 없어 오차지표/종합점수가 제한됩니다.",
        },
        seriesId: selectedMeta.seriesId,
        horizonMonths,
        trainCount: points.length,
        testCount: 0,
        trainStart: points[0]?.ds ?? null,
        trainEnd: points[points.length - 1]?.ds ?? null,
        testStart: forecastRows[0]?.ds ?? null,
        testEnd: forecastRows[forecastRows.length - 1]?.ds ?? null,
        fallbackReason: null,
        history: points,
        forecast: forecastRows,
        totalElapsedMs: Date.now() - startedAt,
      });
    }

    const chosen = { modelType: selectedModelType };
    const forecastApiUrl =
      chosen.modelType === "timesfm_2_5_200m"
        ? TIMESFM_FORECAST_API_URL
        : PYTHON_FORECAST_API_URL;
    const timeoutMs =
      chosen.modelType === "timesfm_2_5_200m"
        ? TIMESFM_FORECAST_TIMEOUT_MS
        : PYTHON_FORECAST_TIMEOUT_MS;

    let pythonPayload: PythonForecastResponse | null = null;
    let pythonError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          forecastApiUrl,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              series_id: selectedMeta.seriesId,
              horizon_months: horizonMonths,
              model_type: chosen.modelType,
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
          throw new Error(detail || "예측 API 호출에 실패했습니다.");
        }
        if (!parsed || typeof parsed !== "object") {
          throw new Error("예측 API 응답이 JSON 형식이 아닙니다.");
        }
        pythonPayload = normalizePythonPayload(parsed);
        pythonError = null;
        break;
      } catch (error) {
        if (isAbortLikeError(error)) {
          pythonError = `예측 API 응답 시간 초과(${Math.round(timeoutMs / 1000)}초)`;
        } else {
          pythonError = error instanceof Error ? error.message : "예측 API 호출 실패";
        }
      }
    }

    if (!pythonPayload) {
      return NextResponse.json(
        { ok: false, error: pythonError || "예측 실행에 실패했습니다." },
        { status: 500 },
      );
    }

    const compositeScore = buildForecastCompositeScore(
      pythonPayload.metrics,
      pythonPayload.forecast,
    );
    const totalElapsedMs = Date.now() - startedAt;

    return NextResponse.json({
      ok: true,
      mode: "ai-forecast-agent",
      question,
      interpreted: {
        question,
        seriesKeyword: parsedKeyword.keyword,
        seriesTokens: parsedKeyword.tokens,
        horizonMonths,
        preferredModel,
      },
      selectedSeries: selectedMeta,
      candidateSeries: candidates,
      autoSelectedModel: chosen.modelType,
      modelSelectionReason,
      model: pythonPayload.model,
      metrics: pythonPayload.metrics,
      compositeScore,
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
      totalElapsedMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 분석 테스트3 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
