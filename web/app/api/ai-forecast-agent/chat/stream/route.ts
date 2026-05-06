import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../../../ai-forecast/_lib/db";
import {
  ensureSession,
  getMessages,
  getSummary,
  insertMessage,
  upsertSummary,
} from "../../_lib/chat-db";

export const runtime = "nodejs";

type StreamPayload = {
  userId?: string;
  sessionId?: string;
  message?: string;
  chatProvider?: "rule" | "ollama" | "openai";
  chatModel?: string;
};

type Candidate = {
  seriesId: string;
  seriesNameKo: string | null;
  unitName: string | null;
  freqCd: string | null;
};

const OLLAMA_URL = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const CHAT_MODELS = ["prophet", "arima", "sarima", "linear_trend", "chronos_bolt_base", "chronos_2", "timesfm_2_5_200m"];

const QUERY_ALIASES: Array<{ pattern: RegExp; replacements: string[] }> = [
  { pattern: /코스피|kospi/gi, replacements: ["코스피", "KOSPI", "종합주가지수", "주가지수"] },
  { pattern: /코스닥|kosdaq/gi, replacements: ["코스닥", "KOSDAQ", "주가지수"] },
  { pattern: /환율/gi, replacements: ["환율", "원달러", "원/달러", "USDKRW"] },
  { pattern: /경제심리지수|경기심리지수/gi, replacements: ["경제심리지수", "ESI"] },
];

const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").trim();

const parseTokens = (text: string) =>
  normalize(text)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 8);

const expandSearchText = (text: string) => {
  let expanded = text;
  const extras: string[] = [];
  for (const alias of QUERY_ALIASES) {
    if (alias.pattern.test(text)) {
      extras.push(...alias.replacements);
    }
  }
  if (extras.length) {
    expanded = `${text} ${extras.join(" ")}`;
  }
  return expanded.trim();
};

const parseSelectionIndex = (text: string) => {
  const matched = text.match(/(\d+)\s*번/);
  if (!matched) return null;
  const idx = Number(matched[1]);
  if (!Number.isFinite(idx) || idx <= 0) return null;
  return idx - 1;
};

const findModelMention = (text: string) => {
  const lowered = text.toLowerCase();
  return CHAT_MODELS.find((model) => lowered.includes(model.toLowerCase())) ?? null;
};

const isModelListIntent = (text: string) => {
  const normalized = normalize(text).replace(/\s+/g, "");
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

const isAllSeriesIntent = (text: string) => {
  const normalized = normalize(text).replace(/\s+/g, "");
  return (
    normalized.includes("전체시리즈") ||
    normalized.includes("전체목록") ||
    normalized.includes("전체리스트") ||
    (normalized.includes("전체") && (normalized.includes("시리즈") || normalized.includes("목록")))
  );
};

const isListIntent = (text: string) => {
  const normalized = normalize(text).replace(/\s+/g, "");
  return (
    normalized.includes("다른시리즈") ||
    normalized.includes("리스트") ||
    normalized.includes("목록") ||
    normalized.includes("후보")
  );
};

const isGreetingIntent = (text: string) => {
  const normalized = normalize(text).replace(/\s+/g, "");
  return (
    normalized === "안녕" ||
    normalized === "안녕하세요" ||
    normalized === "ㅎㅇ" ||
    normalized === "hello" ||
    normalized === "hi" ||
    normalized === "반가워" ||
    normalized === "반갑습니다"
  );
};

const inferSeriesFromText = (text: string, candidates: Candidate[]) => {
  const selectionIdx = parseSelectionIndex(text);
  if (selectionIdx != null && candidates[selectionIdx]) return candidates[selectionIdx];
  const normalizedText = normalize(text).replace(/\s+/g, "");
  for (const candidate of candidates) {
    const idNorm = normalize(candidate.seriesId).replace(/\s+/g, "");
    const nameNorm = normalize(candidate.seriesNameKo ?? "").replace(/\s+/g, "");
    if ((idNorm && normalizedText.includes(idNorm)) || (nameNorm && normalizedText.includes(nameNorm))) {
      return candidate;
    }
  }
  return null;
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

const fallbackSummary = (messages: Array<{ role: string; content: string }>) => {
  const recentUser = messages
    .filter((item) => item.role === "user")
    .slice(-6)
    .map((item) => item.content.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!recentUser.length) return "요약할 사용자 질의가 없습니다.";
  return `최근 사용자 요청 요약: ${recentUser.join(" / ")}`;
};

const getCandidates = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  message: string,
) => {
  const expandedMessage = expandSearchText(message);
  const tokens = parseTokens(expandedMessage);
  const keyword = tokens.join(" ").trim();
  if (!keyword) {
    const result = await client.query(
      `
        select series_id, series_name_ko, unit_name, freq_cd
        from dp.ts_monthly_series_mst
        where coalesce(use_yn, 'Y') = 'Y'
        order by
          case when coalesce(is_representative, 'N') = 'Y' then 0 else 1 end,
          coalesce(sort_ord, 999999),
          series_id
        limit 8
      `,
    );
    return result.rows.map((row) => ({
      seriesId: String(row.series_id),
      seriesNameKo: (row.series_name_ko as string | null) ?? null,
      unitName: (row.unit_name as string | null) ?? null,
      freqCd: (row.freq_cd as string | null) ?? null,
    })) as Candidate[];
  }

  const result = await client.query(
    `
      with cte as (
        select
          series_id,
          series_name_ko,
          unit_name,
          freq_cd,
          (
            case
              when coalesce(series_name_ko, '') ilike '%' || $1 || '%' then 120
              when series_id ilike '%' || $1 || '%' then 110
              else 0
            end
          ) +
          coalesce((
            select count(*)
            from unnest($2::text[]) as tk
            where
              series_id ilike '%' || tk || '%'
              or coalesce(series_name_ko, '') ilike '%' || tk || '%'
          ), 0) * 12 as score
        from dp.ts_monthly_series_mst
        where coalesce(use_yn, 'Y') = 'Y'
          and (
            series_id ilike '%' || $1 || '%'
            or coalesce(series_name_ko, '') ilike '%' || $1 || '%'
            or exists (
              select 1
              from unnest($2::text[]) as tk
              where
                series_id ilike '%' || tk || '%'
                or coalesce(series_name_ko, '') ilike '%' || tk || '%'
            )
          )
      )
      select series_id, series_name_ko, unit_name, freq_cd
      from cte
      order by score desc, series_id
      limit 8
    `,
    [keyword, tokens],
  );

  if (!result.rowCount) {
    const fallback = await client.query(
      `
        select series_id, series_name_ko, unit_name, freq_cd
        from dp.ts_monthly_series_mst
        where coalesce(use_yn, 'Y') = 'Y'
        order by
          case when coalesce(is_representative, 'N') = 'Y' then 0 else 1 end,
          coalesce(sort_ord, 999999),
          series_id
        limit 8
      `,
    );
    return fallback.rows.map((row) => ({
      seriesId: String(row.series_id),
      seriesNameKo: (row.series_name_ko as string | null) ?? null,
      unitName: (row.unit_name as string | null) ?? null,
      freqCd: (row.freq_cd as string | null) ?? null,
    })) as Candidate[];
  }

  return result.rows.map((row) => ({
    seriesId: String(row.series_id),
    seriesNameKo: (row.series_name_ko as string | null) ?? null,
    unitName: (row.unit_name as string | null) ?? null,
    freqCd: (row.freq_cd as string | null) ?? null,
  })) as Candidate[];
};

const getCandidatesByIds = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  seriesIds: string[],
) => {
  if (!seriesIds.length) return [] as Candidate[];
  const result = await client.query(
    `
      select
        series_id,
        series_name_ko,
        unit_name,
        freq_cd
      from dp.ts_monthly_series_mst
      where series_id = any($1::text[])
    `,
    [seriesIds],
  );
  const map = new Map(
    result.rows.map((row) => [
      String(row.series_id),
      {
        seriesId: String(row.series_id),
        seriesNameKo: (row.series_name_ko as string | null) ?? null,
        unitName: (row.unit_name as string | null) ?? null,
        freqCd: (row.freq_cd as string | null) ?? null,
      } satisfies Candidate,
    ]),
  );
  return seriesIds.map((id) => map.get(id)).filter((item): item is Candidate => Boolean(item));
};

const buildPrompt = (args: {
  summary: string | null;
  candidates: Candidate[];
  recentMessages: Array<{ role: string; content: string }>;
  userMessage: string;
  intents: {
    greeting: boolean;
    list: boolean;
    allSeries: boolean;
    modelList: boolean;
  };
}) => {
  const candidateText = args.candidates
    .map((item, idx) => `${idx + 1}) ${item.seriesNameKo ?? "-"} (${item.seriesId})`)
    .join("\n");
  const recentText = args.recentMessages
    .slice(-10)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");

  return [
    "당신은 데이터플랫폼 시계열 예측 대화 도우미입니다.",
    "목표: 사용자와 대화하며 시계열/기간/모드/분석모델을 확정하고, 필요하면 실행하도록 안내합니다.",
    "반드시 한국어로 답하고, 사실만 말합니다.",
    "중요: 사용자가 인사/잡담이면 자연스럽게 짧게 응답하고, 시계열 목록/모델 목록을 먼저 길게 나열하지 마세요.",
    "시계열/모델 목록은 사용자가 요청했을 때만 보여주세요.",
    "시계열을 사용자가 지정하면 확인 후 다음 단계(모드/기간/모델/실행) 질문을 이어가세요.",
    "",
    `[세션 요약]\n${args.summary ?? "요약 없음"}`,
    "",
    `[매칭된 시계열 후보]\n${candidateText || "(없음)"}`,
    "",
    `[분석 모델 목록]\n${CHAT_MODELS.join(", ")}`,
    `[의도 플래그] greeting=${args.intents.greeting}, list=${args.intents.list}, allSeries=${args.intents.allSeries}, modelList=${args.intents.modelList}`,
    "",
    `[최근 대화]\n${recentText || "(없음)"}`,
    "",
    `[사용자 최신 메시지]\n${args.userMessage}`,
  ].join("\n");
};

const callOllamaNonStream = async (model: string, prompt: string) => {
  if (!OLLAMA_URL) return null;
  const response = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
    },
    20000,
  );
  const raw = await response.text();
  if (!response.ok) return null;
  const parsed = parseJsonSafe(raw) as { response?: string } | null;
  return (parsed?.response ?? "").trim() || null;
};

const callOpenAiNonStream = async (model: string, prompt: string) => {
  if (!OPENAI_API_KEY) return null;
  const response = await fetchWithTimeout(
    `${OPENAI_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are a Korean data analysis assistant." },
          { role: "user", content: prompt },
        ],
      }),
    },
    20000,
  );
  const raw = await response.text();
  if (!response.ok) return null;
  const parsed = parseJsonSafe(raw) as { choices?: Array<{ message?: { content?: string } }> } | null;
  return parsed?.choices?.[0]?.message?.content?.trim() || null;
};

const buildRuleReply = (
  message: string,
  candidates: Candidate[],
  context: {
    selectedSeries: Candidate | null;
    selectedModel: string | null;
    horizonMonths: number | null;
    analysisMode: "holdout" | "future" | null;
  },
) => {
  const normalized = normalize(message).replace(/\s+/g, "");
  if (isGreetingIntent(message)) {
    return "안녕하세요! 예측할 시계열이나 궁금한 내용을 말씀해 주세요. 원하면 제가 후보부터 좁혀드릴게요.";
  }
  const top = candidates.slice(0, 5);
  const listText = top.map((item, idx) => `${idx + 1}) ${item.seriesNameKo ?? "-"} (${item.seriesId})`).join("\n");
  if (isModelListIntent(message)) {
    return [
      "사용 가능한 분석 모델 목록입니다.",
      `- ${CHAT_MODELS.join(", ")}`,
      "원하는 모델을 선택해 주세요. 예: 'sarima로 해줘'",
    ].join("\n");
  }
  if (isAllSeriesIntent(message)) {
    return [
      "현재 화면에서는 대표 시리즈 중심으로 먼저 보여드립니다.",
      listText || "표시할 후보가 없습니다.",
      "특정 키워드를 주시면 더 정확히 좁혀서 보여드릴 수 있습니다.",
    ].join("\n");
  }
  if (isListIntent(message)) {
    return [
      "현재 매칭된 시계열 후보입니다.",
      listText || "표시할 후보가 없습니다.",
      "원하는 시리즈를 말씀해 주세요.",
    ].join("\n");
  }
  const seriesFromMessage = inferSeriesFromText(message, candidates);
  const modelFromMessage = findModelMention(message);
  const chosenSeries = seriesFromMessage ?? context.selectedSeries;
  const chosenModel = modelFromMessage ?? context.selectedModel;
  if (seriesFromMessage && modelFromMessage) {
    return [
      `좋습니다. 시계열은 ${seriesFromMessage.seriesNameKo ?? seriesFromMessage.seriesId}(${seriesFromMessage.seriesId}), 모델은 ${modelFromMessage}로 설정했습니다.`,
      `예측기간은 ${context.horizonMonths ?? 12}개월, 모드는 ${context.analysisMode ?? "holdout"}로 진행할까요?`,
      "문제없으면 '확정 실행'을 눌러주세요.",
    ].join("\n");
  }
  if (seriesFromMessage) {
    return [
      `시계열을 ${seriesFromMessage.seriesNameKo ?? seriesFromMessage.seriesId}(${seriesFromMessage.seriesId})로 반영했습니다.`,
      `모델은 ${chosenModel ?? "자동선택"}으로 두고 진행할까요?`,
      "원하면 모델/기간/모드를 추가로 지정해 주세요.",
    ].join("\n");
  }
  if (modelFromMessage) {
    return [
      `모델을 ${modelFromMessage}로 반영했습니다.`,
      chosenSeries
        ? `시계열은 ${chosenSeries.seriesNameKo ?? chosenSeries.seriesId}(${chosenSeries.seriesId})로 진행합니다.`
        : "아직 시계열이 확정되지 않았습니다. 후보에서 시계열을 선택해 주세요.",
      `예측기간은 ${context.horizonMonths ?? 12}개월, 모드는 ${context.analysisMode ?? "holdout"}입니다.`,
    ].join("\n");
  }
  if (!top.length) {
    return "매칭되는 시계열 후보를 찾지 못했습니다. 시리즈명 또는 키워드를 더 구체적으로 알려주세요.";
  }
  return [
    `질문 기준 1순위 후보는 ${top[0].seriesNameKo ?? top[0].seriesId} (${top[0].seriesId})입니다.`,
    "아래 후보 중에서 선택하거나, 모델/기간/모드를 지정해 주세요.",
    listText,
  ].join("\n");
};

const streamRule = async (text: string, onToken: (chunk: string) => void) => {
  for (const ch of text) {
    onToken(ch);
    await new Promise((resolve) => setTimeout(resolve, 6));
  }
};

const streamOllama = async (
  model: string,
  prompt: string,
  onToken: (chunk: string) => void,
) => {
  if (!OLLAMA_URL) throw new Error("OLLAMA_URL이 설정되지 않았습니다.");
  const response = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: true }),
    },
    120000,
  );
  if (!response.ok || !response.body) {
    const raw = await response.text();
    throw new Error(raw || "Ollama 스트리밍 호출 실패");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseJsonSafe(trimmed) as { response?: string; done?: boolean } | null;
      if (parsed?.response) onToken(parsed.response);
    }
  }
};

const streamOpenAi = async (
  model: string,
  prompt: string,
  onToken: (chunk: string) => void,
) => {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
  const response = await fetchWithTimeout(
    `${OPENAI_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        stream: true,
        messages: [
          { role: "system", content: "You are a Korean forecasting assistant." },
          { role: "user", content: prompt },
        ],
      }),
    },
    120000,
  );
  if (!response.ok || !response.body) {
    const raw = await response.text();
    throw new Error(raw || "OpenAI 스트리밍 호출 실패");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      const parsed = parseJsonSafe(data) as
        | { choices?: Array<{ delta?: { content?: string } }> }
        | null;
      const token = parsed?.choices?.[0]?.delta?.content;
      if (token) onToken(token);
    }
  }
};

const buildSummaryPrompt = (messages: Array<{ role: string; content: string }>) => [
  "아래 대화를 한국어로 8줄 이내 요약하세요.",
  "시계열 선택, 모델 선택, 기간, 모드, 사용자의 의사결정을 중심으로 정리하세요.",
  "",
  ...messages.slice(-30).map((item) => `${item.role}: ${item.content}`),
].join("\n");

export async function POST(request: Request) {
  let payload: StreamPayload | null = null;
  try {
    payload = (await request.json()) as StreamPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "요청 본문이 비어있습니다." }, { status: 400 });
  }

  const userId = (payload?.userId ?? "").trim();
  const userMessage = (payload?.message ?? "").trim();
  const provider = payload?.chatProvider === "ollama" || payload?.chatProvider === "openai"
    ? payload.chatProvider
    : "rule";
  const requestedModel = (payload?.chatModel ?? "").trim();
  if (!userId || !userMessage) {
    return NextResponse.json({ ok: false, error: "userId, message가 필요합니다." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }

  const sessionId = (payload?.sessionId ?? "").trim() || randomUUID();
  const client = createDbClient();
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    await connectWithTimeout(client);
    await ensureSession(client, { sessionId, userId });
    await insertMessage(client, {
      sessionId,
      role: "user",
      content: userMessage,
      metadata: { provider, requestedModel: requestedModel || null },
    });
    const messages = await getMessages(client, sessionId, 120);
    const summaryRow = await getSummary(client, sessionId);
    const latestAssistantWithCandidates = [...messages]
      .reverse()
      .find((item) => item.role === "assistant" && Array.isArray((item.metadata as { candidates?: unknown[] } | null)?.candidates));
    const prevCandidateIds = Array.isArray((latestAssistantWithCandidates?.metadata as { candidates?: unknown[] } | null)?.candidates)
      ? ((latestAssistantWithCandidates?.metadata as { candidates?: unknown[] } | null)?.candidates ?? [])
          .filter((item): item is string => typeof item === "string")
      : [];
    const allSeriesIntent = isAllSeriesIntent(userMessage);
    const modelListIntent = isModelListIntent(userMessage);
    const greetingIntent = isGreetingIntent(userMessage);
    const listIntent = isListIntent(userMessage) || allSeriesIntent;
    const selectionIntent = parseSelectionIndex(userMessage) != null;
    const currentCandidates = await getCandidates(client, userMessage);
    const previousCandidates = prevCandidateIds.length ? await getCandidatesByIds(client, prevCandidateIds) : [];
    const candidates =
      (selectionIntent || listIntent) && previousCandidates.length ? previousCandidates : currentCandidates;

    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
    const recentUserText = userMessages.slice(-12).join("\n");
    const selectedModel = findModelMention(recentUserText);
    const selectedSeries =
      inferSeriesFromText(userMessage, candidates) ??
      inferSeriesFromText(recentUserText, candidates) ??
      null;
    const horizonMatch = recentUserText.match(/(\d+)\s*(?:개?월|months?)/i);
    const horizonMonths = horizonMatch ? Math.max(1, Math.min(24, Number(horizonMatch[1]) || 12)) : 12;
    const mode: "holdout" | "future" = /future|미래예측|실제미래/i.test(recentUserText)
      ? "future"
      : "holdout";

    let summaryText = summaryRow?.summaryText ?? null;
    if (!summaryText || messages.length >= 20) {
      const summaryPrompt = buildSummaryPrompt(messages.map((m) => ({ role: m.role, content: m.content })));
      let generatedSummary: string | null = null;
      if (provider === "ollama") {
        const model = requestedModel || (OLLAMA_MODEL ?? "").trim();
        if (model) generatedSummary = await callOllamaNonStream(model, summaryPrompt);
      } else if (provider === "openai") {
        const model = requestedModel || (OPENAI_MODEL ?? "").trim() || "gpt-4o-mini";
        generatedSummary = await callOpenAiNonStream(model, summaryPrompt);
      }
      summaryText = generatedSummary ?? fallbackSummary(messages);
      await upsertSummary(client, {
        sessionId,
        summaryText,
        summarizedThroughMessageId: messages[messages.length - 1]?.messageId ?? null,
      });
    }

    const prompt = buildPrompt({
      summary: summaryText,
      candidates,
      recentMessages: messages.map((m) => ({ role: m.role, content: m.content })),
      userMessage,
      intents: {
        greeting: greetingIntent,
        list: listIntent,
        allSeries: allSeriesIntent,
        modelList: modelListIntent,
      },
    });

    const encoder = new TextEncoder();
    let assistantText = "";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const onToken = (chunk: string) => {
          assistantText += chunk;
          controller.enqueue(encoder.encode(chunk));
        };

        void (async () => {
          try {
            if (provider === "rule") {
              const reply = buildRuleReply(userMessage, candidates, {
                selectedSeries,
                selectedModel,
                horizonMonths,
                analysisMode: mode,
              });
              await streamRule(reply, onToken);
            } else if (provider === "ollama") {
              const model = requestedModel || (OLLAMA_MODEL ?? "").trim();
              if (!model) throw new Error("Ollama 모델명이 비어 있습니다.");
              await streamOllama(model, prompt, onToken);
            } else {
              const model = requestedModel || (OPENAI_MODEL ?? "").trim() || "gpt-4o-mini";
              await streamOpenAi(model, prompt, onToken);
            }

            const finalText = assistantText.trim() || "응답이 비어 있습니다.";
            await insertMessage(client, {
              sessionId,
              role: "assistant",
              content: finalText,
              metadata: {
                provider,
                model:
                  provider === "ollama"
                    ? requestedModel || (OLLAMA_MODEL ?? "").trim() || null
                    : provider === "openai"
                      ? requestedModel || (OPENAI_MODEL ?? "").trim() || "gpt-4o-mini"
                      : "rule",
                candidates: candidates.slice(0, 5).map((c) => c.seriesId),
              },
            });
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : "스트리밍 처리 실패";
            controller.enqueue(encoder.encode(`\n[error] ${message}`));
            controller.close();
          } finally {
            try {
              await client.end();
            } catch {
              // ignore
            }
          }
        })();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (error) {
    try {
      await client.end();
    } catch {
      // ignore
    }
    const message = error instanceof Error ? error.message : "채팅 처리 실패";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
