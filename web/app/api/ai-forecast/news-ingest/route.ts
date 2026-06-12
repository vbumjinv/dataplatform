import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";

export const runtime = "nodejs";

type Provider = "auto" | "openai" | "ollama";

type IngestPayload = {
  queries?: string[];
  displayPerQuery?: number;
  marketCode?: string;
  provider?: Provider;
  model?: string;
  dryRun?: boolean;
};

type NaverNewsItem = {
  title?: string;
  originallink?: string;
  link?: string;
  description?: string;
  pubDate?: string;
};

type ExtractedNewsFeatures = {
  relevance_kospi: number;
  sentiment_score: number;
  novelty_score: number;
  source_weight: number;
  event_weight: number;
  topic_macro: number;
  topic_rate: number;
  topic_semiconductor: number;
  topic_fx: number;
  topic_oil: number;
  quality_flag: string;
};

const NAVER_NEWS_URL = "https://openapi.naver.com/v1/search/news.json";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";

const DEFAULT_QUERIES = [
  "코스피",
  "한국은행 기준금리",
  "원달러 환율",
  "반도체 수출",
  "유가",
  "미국 금리",
];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const toFiniteNumber = (value: unknown, fallback: number) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const stripHtml = (raw: string) =>
  raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const normalizeText = (raw: string) => stripHtml(raw || "");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const parsePublishedAt = (value: string | undefined) => {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
};

const extractByRules = (title: string, body: string): ExtractedNewsFeatures => {
  const text = `${title} ${body}`.toLowerCase();
  const has = (keywords: string[]) => keywords.some((keyword) => text.includes(keyword));
  const posWords = ["상승", "개선", "호조", "확대", "완화", "성장"];
  const negWords = ["하락", "둔화", "악화", "축소", "긴축", "침체", "리스크", "우려"];

  let sentiment = 0;
  if (has(posWords)) sentiment += 0.25;
  if (has(negWords)) sentiment -= 0.25;
  sentiment = clamp(sentiment, -1, 1);

  const relevance = has(["코스피", "kospi", "유가증권", "주식시장"]) ? 0.9 : 0.6;
  const macro = has(["금리", "fomc", "cpi", "인플레이션", "통화정책"]) ? 1 : 0;
  const rate = has(["금리", "기준금리", "채권금리"]) ? 1 : 0;
  const semi = has(["반도체", "메모리", "삼성전자", "sk하이닉스"]) ? 1 : 0;
  const fx = has(["환율", "원달러", "달러"]) ? 1 : 0;
  const oil = has(["유가", "wti", "브렌트"]) ? 1 : 0;

  return {
    relevance_kospi: relevance,
    sentiment_score: sentiment,
    novelty_score: 0.6,
    source_weight: 1.0,
    event_weight: macro || rate || fx || oil ? 1.2 : 1.0,
    topic_macro: macro,
    topic_rate: rate,
    topic_semiconductor: semi,
    topic_fx: fx,
    topic_oil: oil,
    quality_flag: "rule_based",
  };
};

const extractByOpenAi = async (
  title: string,
  body: string,
  model: string,
): Promise<ExtractedNewsFeatures> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY 환경변수가 없어 OpenAI 추출을 실행할 수 없습니다.");
  }
  const prompt = [
    "당신은 금융 뉴스 구조화 엔진입니다.",
    "아래 기사를 KOSPI 단기 예측 관점에서 수치화하세요.",
    "JSON만 반환하세요.",
    "",
    "[출력 스키마]",
    "{",
    '  "relevance_kospi": 0~1,',
    '  "sentiment_score": -1~1,',
    '  "novelty_score": 0~1,',
    '  "source_weight": 0.5~1.5,',
    '  "event_weight": 1~2,',
    '  "topic_macro": 0~1,',
    '  "topic_rate": 0~1,',
    '  "topic_semiconductor": 0~1,',
    '  "topic_fx": 0~1,',
    '  "topic_oil": 0~1,',
    '  "quality_flag": "normal|low_quality"',
    "}",
    "",
    `[제목] ${title}`,
    `[본문] ${body.slice(0, 3000)}`,
  ].join("\n");

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return strict JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI 뉴스 추출 실패: ${raw}`);
  }
  const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content ?? "{}";
  const json = JSON.parse(content) as Record<string, unknown>;
  return {
    relevance_kospi: clamp(toFiniteNumber(json.relevance_kospi, 0.5), 0, 1),
    sentiment_score: clamp(toFiniteNumber(json.sentiment_score, 0), -1, 1),
    novelty_score: clamp(toFiniteNumber(json.novelty_score, 0.5), 0, 1),
    source_weight: clamp(toFiniteNumber(json.source_weight, 1), 0.5, 1.5),
    event_weight: clamp(toFiniteNumber(json.event_weight, 1), 1, 2),
    topic_macro: clamp(toFiniteNumber(json.topic_macro, 0), 0, 1),
    topic_rate: clamp(toFiniteNumber(json.topic_rate, 0), 0, 1),
    topic_semiconductor: clamp(toFiniteNumber(json.topic_semiconductor, 0), 0, 1),
    topic_fx: clamp(toFiniteNumber(json.topic_fx, 0), 0, 1),
    topic_oil: clamp(toFiniteNumber(json.topic_oil, 0), 0, 1),
    quality_flag: String(json.quality_flag ?? "normal"),
  };
};

const extractByOllama = async (
  title: string,
  body: string,
  model: string,
): Promise<ExtractedNewsFeatures> => {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) {
    throw new Error("OLLAMA_URL 환경변수가 없어 Ollama 추출을 실행할 수 없습니다.");
  }
  const prompt = [
    "아래 기사에 대해 KOSPI 예측용 지표를 JSON으로만 반환하세요.",
    '{"relevance_kospi":0,"sentiment_score":0,"novelty_score":0,"source_weight":1,"event_weight":1,"topic_macro":0,"topic_rate":0,"topic_semiconductor":0,"topic_fx":0,"topic_oil":0,"quality_flag":"normal"}',
    `[제목] ${title}`,
    `[본문] ${body.slice(0, 3000)}`,
  ].join("\n");
  const response = await fetch(ollamaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: 0 },
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama 뉴스 추출 실패: ${raw}`);
  }
  const parsedEnvelope = JSON.parse(raw) as { response?: string };
  const json = JSON.parse(parsedEnvelope.response ?? "{}") as Record<string, unknown>;
  return {
    relevance_kospi: clamp(toFiniteNumber(json.relevance_kospi, 0.5), 0, 1),
    sentiment_score: clamp(toFiniteNumber(json.sentiment_score, 0), -1, 1),
    novelty_score: clamp(toFiniteNumber(json.novelty_score, 0.5), 0, 1),
    source_weight: clamp(toFiniteNumber(json.source_weight, 1), 0.5, 1.5),
    event_weight: clamp(toFiniteNumber(json.event_weight, 1), 1, 2),
    topic_macro: clamp(toFiniteNumber(json.topic_macro, 0), 0, 1),
    topic_rate: clamp(toFiniteNumber(json.topic_rate, 0), 0, 1),
    topic_semiconductor: clamp(toFiniteNumber(json.topic_semiconductor, 0), 0, 1),
    topic_fx: clamp(toFiniteNumber(json.topic_fx, 0), 0, 1),
    topic_oil: clamp(toFiniteNumber(json.topic_oil, 0), 0, 1),
    quality_flag: String(json.quality_flag ?? "normal"),
  };
};

const fetchNaverNews = async (query: string, display: number) => {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 필요합니다.");
  }
  const url = new URL(NAVER_NEWS_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("display", String(display));
  url.searchParams.set("start", "1");
  url.searchParams.set("sort", "date");

  const response = await fetch(url.toString(), {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`네이버 뉴스 조회 실패: ${body}`);
  }
  const parsed = JSON.parse(body) as { items?: NaverNewsItem[] };
  return parsed.items ?? [];
};

export async function POST(request: Request) {
  let payload: IngestPayload | null = null;
  try {
    payload = (await request.json()) as IngestPayload;
  } catch {
    payload = {};
  }

  const provider: Provider = payload?.provider ?? "auto";
  const marketCode = (payload?.marketCode ?? "KOSPI").trim() || "KOSPI";
  const displayPerQuery = clamp(Math.trunc(payload?.displayPerQuery ?? 30), 1, 100);
  const dryRun = payload?.dryRun === true;
  const queries = (payload?.queries?.filter((q) => q.trim()) ?? DEFAULT_QUERIES).slice(0, 20);

  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const client = createDbClient();
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const ingestBatchId = `news_${Date.now()}`;
  const model = (payload?.model ?? "").trim();
  const effectiveProvider: Provider =
    provider === "auto" ? (process.env.OPENAI_API_KEY ? "openai" : process.env.OLLAMA_URL ? "ollama" : "auto") : provider;
  const effectiveModel =
    model ||
    (effectiveProvider === "openai" ? DEFAULT_OPENAI_MODEL : effectiveProvider === "ollama" ? DEFAULT_OLLAMA_MODEL : "rule_based");

  const upsertRawSql = `
    INSERT INTO dp.news_raw (
      market_code, source, source_article_id, published_at, collected_at,
      title, body, url, lang, dedup_hash, ingest_batch_id
    )
    VALUES ($1, 'naver_openapi', $2, $3, now(), $4, $5, $6, 'ko', $7, $8)
    ON CONFLICT (source, source_article_id) DO UPDATE
    SET
      market_code = EXCLUDED.market_code,
      published_at = EXCLUDED.published_at,
      collected_at = now(),
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      url = EXCLUDED.url,
      dedup_hash = EXCLUDED.dedup_hash,
      ingest_batch_id = EXCLUDED.ingest_batch_id
    RETURNING news_id, published_at
  `;

  const upsertEnrichedSql = `
    INSERT INTO dp.news_enriched (
      news_id, published_date, relevance_kospi, sentiment_score, novelty_score,
      source_weight, event_weight, impact_score,
      topic_macro, topic_rate, topic_semiconductor, topic_fx, topic_oil,
      is_duplicate, quality_flag, model_version, enriched_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11, $12, $13,
      false, $14, $15, now()
    )
    ON CONFLICT (news_id) DO UPDATE
    SET
      published_date = EXCLUDED.published_date,
      relevance_kospi = EXCLUDED.relevance_kospi,
      sentiment_score = EXCLUDED.sentiment_score,
      novelty_score = EXCLUDED.novelty_score,
      source_weight = EXCLUDED.source_weight,
      event_weight = EXCLUDED.event_weight,
      impact_score = EXCLUDED.impact_score,
      topic_macro = EXCLUDED.topic_macro,
      topic_rate = EXCLUDED.topic_rate,
      topic_semiconductor = EXCLUDED.topic_semiconductor,
      topic_fx = EXCLUDED.topic_fx,
      topic_oil = EXCLUDED.topic_oil,
      quality_flag = EXCLUDED.quality_flag,
      model_version = EXCLUDED.model_version,
      enriched_at = now()
  `;

  try {
    await connectWithTimeout(client);
    await client.query("BEGIN");

    let fetchedCount = 0;
    let savedCount = 0;
    let enrichedCount = 0;

    for (const query of queries) {
      const items = await fetchNaverNews(query, displayPerQuery);
      fetchedCount += items.length;
      for (const item of items) {
        const title = normalizeText(item.title ?? "");
        const body = normalizeText(item.description ?? "");
        const url = (item.originallink ?? item.link ?? "").trim();
        if (!title || !url) continue;

        const sourceArticleId = url;
        const publishedAt = parsePublishedAt(item.pubDate).toISOString();
        const dedupHash = sha256(`${title}|${body}`.toLowerCase().trim());

        let extracted: ExtractedNewsFeatures;
        if (effectiveProvider === "openai") {
          extracted = await extractByOpenAi(title, body, effectiveModel);
        } else if (effectiveProvider === "ollama") {
          extracted = await extractByOllama(title, body, effectiveModel);
        } else {
          extracted = extractByRules(title, body);
        }
        const impactScore =
          extracted.relevance_kospi *
          extracted.sentiment_score *
          extracted.novelty_score *
          extracted.source_weight *
          extracted.event_weight;

        if (!dryRun) {
          const rawInsert = await client.query(upsertRawSql, [
            marketCode,
            sourceArticleId,
            publishedAt,
            title,
            body,
            url,
            dedupHash,
            ingestBatchId,
          ]);
          const newsId = Number(rawInsert.rows[0]?.news_id ?? 0);
          const rawPublishedAt = rawInsert.rows[0]?.published_at ?? publishedAt;
          const publishedDate = (() => {
            if (rawPublishedAt instanceof Date) {
              return rawPublishedAt.toISOString().slice(0, 10);
            }
            const parsed = new Date(String(rawPublishedAt));
            if (!Number.isNaN(parsed.getTime())) {
              return parsed.toISOString().slice(0, 10);
            }
            return new Date().toISOString().slice(0, 10);
          })();
          if (newsId > 0) {
            await client.query(upsertEnrichedSql, [
              newsId,
              publishedDate,
              extracted.relevance_kospi,
              extracted.sentiment_score,
              extracted.novelty_score,
              extracted.source_weight,
              extracted.event_weight,
              impactScore,
              extracted.topic_macro,
              extracted.topic_rate,
              extracted.topic_semiconductor,
              extracted.topic_fx,
              extracted.topic_oil,
              extracted.quality_flag,
              `${effectiveProvider}:${effectiveModel}`,
            ]);
            savedCount += 1;
            enrichedCount += 1;
          }
        } else {
          savedCount += 1;
          enrichedCount += 1;
        }
      }
    }

    if (!dryRun) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      marketCode,
      provider: effectiveProvider,
      model: effectiveModel,
      ingestBatchId,
      fetchedCount,
      savedCount,
      enrichedCount,
      queries,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    const message = error instanceof Error ? error.message : "뉴스 고도화 수집 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
