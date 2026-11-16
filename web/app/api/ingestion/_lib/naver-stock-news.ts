import { createHash } from "crypto";
import { runInNewContext } from "node:vm";
import v8 from "node:v8";
import * as cheerio from "cheerio";
import type { Client } from "pg";
import { connectNewsClient } from "./news-collect";

const LIST_URL = "https://stock.naver.com/api/domestic/news/list";
const PAGE_SIZE = 100;
const MAX_PAGES = 80;
const MIN_BODY_CHARS = 200;
const LIST_DELAY_MS = 80;
const BODY_CONCURRENCY = 8;
const BODY_GAP_MS = 60;
const BODY_WRITE_BATCH = 16;
const HTTP_TIMEOUT_MS = 25000;

const CATEGORIES = [
  { key: "flashnews", code: "FLASHNEWS" },
  { key: "mainnews", code: "MAINNEWS" },
] as const;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
};

export type StockNewsProgress = {
  date: string;
  phase: "list" | "body" | "done" | "error";
  listCount: number;
  bodyTotal: number;
  bodyDone: number;
  bodyOk: number;
  message: string;
  error: string;
};

export type StockNewsRangeProgress = StockNewsProgress & {
  startDate: string;
  endDate: string;
  dayIndex: number;
  dayCount: number;
  elapsedMs: number;
};

type ListRow = {
  articleKey: string;
  officeId: string;
  articleId: string;
  category: string;
  publishedAt: string;
  title: string;
  summary: string;
  publisher: string;
  url: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let bodiesSinceRelease = 0;

const releaseHeap = () => {
  bodiesSinceRelease = 0;
  try {
    v8.setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose-gc");
    collect();
  } catch {
    // 가비지 수집을 못 해도 수집 자체는 계속한다.
  }
};

const cleanText = (value: unknown) =>
  String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

export const isCrawlDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00+09:00`));

export const listCrawlDates = (startDate: string, endDate: string) => {
  const start = startDate.trim();
  const end = endDate.trim();
  if (!isCrawlDate(start) || !isCrawlDate(end)) {
    throw new Error("날짜를 선택하세요.");
  }
  if (start > end) {
    throw new Error("시작일이 종료일보다 늦습니다.");
  }
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  const last = new Date(Date.UTC(endYear, endMonth - 1, endDay));
  const dates: string[] = [];
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
};

export const formatElapsed = (elapsedMs: number) => {
  const total = Math.max(0, Math.round(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
};

const toKstTimestamp = (value: string) => {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) return null;
  return `${match[1]}T${match[2]}+09:00`;
};

const articleUrl = (officeId: string, articleId: string) =>
  `https://n.news.naver.com/mnews/article/${officeId}/${articleId}`;

const contentHash = (title: string, body: string) =>
  createHash("sha256").update(`${title}|${body}`.toLowerCase().trim()).digest("hex");

const fetchText = async (url: string) => {
  const response = await fetch(url, {
    cache: "no-store",
    headers: HEADERS,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response;
};

const LIST_PAGE_SIZES = [100, 50, 20, 10, 1];

const isServerError = (error: unknown) => error instanceof Error && /^HTTP 5\d\d$/.test(error.message);

const fetchListPage = async (categoryCode: string, yyyymmdd: string, page: number, pageSize: number) => {
  const url = new URL(LIST_URL);
  url.searchParams.set("category", categoryCode);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("date", yyyymmdd);
  const response = await fetchText(url.toString());
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    throw new Error("목록 응답이 JSON이 아닙니다.");
  }
  const payload = (await response.json()) as { articles?: unknown };
  if (!Array.isArray(payload.articles)) {
    throw new Error("목록 응답 형식이 예상과 다릅니다.");
  }
  return payload.articles as Array<Record<string, unknown>>;
};

const fetchListPageRetry = async (categoryCode: string, yyyymmdd: string, page: number, pageSize: number) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchListPage(categoryCode, yyyymmdd, page, pageSize);
    } catch (error) {
      lastError = error;
      if (!isServerError(error) || attempt === 1) throw error;
      await sleep(400);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("목록 수집 실패");
};

const chooseListPageSize = (offset: number, count: number) => {
  for (const size of LIST_PAGE_SIZES) {
    if (size <= count && offset % size === 0) return size;
  }
  return 1;
};

const parseListItem = (item: Record<string, unknown>, category: string, day: string): ListRow | "older" | null => {
  const officeId = cleanText(item.officeId);
  const articleId = cleanText(item.articleId);
  const publishedAt = toKstTimestamp(cleanText(item.datetime));
  if (!officeId || !articleId || !publishedAt) return null;
  const rowDay = publishedAt.slice(0, 10);
  if (rowDay < day) return "older";
  if (rowDay > day) return null;
  return {
    articleKey: `${officeId}_${articleId}`,
    officeId,
    articleId,
    category,
    publishedAt,
    title: cleanText(item.title),
    summary: cleanText(item.subcontent),
    publisher: cleanText(item.officeHname),
    url: articleUrl(officeId, articleId),
  };
};

const collectCategory = async (categoryKey: string, categoryCode: string, day: string) => {
  const yyyymmdd = day.replaceAll("-", "");
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  const maxItems = MAX_PAGES * PAGE_SIZE;

  const readWindow = async (
    offset: number,
    count: number,
  ): Promise<{ items: Array<Record<string, unknown>>; consumed: number; done: boolean }> => {
    const size = chooseListPageSize(offset, count);
    const page = Math.floor(offset / size) + 1;
    try {
      if (offset > 0) await sleep(LIST_DELAY_MS);
      const items =
        size <= 1
          ? await fetchListPageRetry(categoryCode, yyyymmdd, page, size)
          : await fetchListPage(categoryCode, yyyymmdd, page, size);
      return { items, consumed: items.length, done: items.length < size };
    } catch (error) {
      if (!isServerError(error)) throw error;
      if (size <= 1) return { items: [], consumed: 1, done: false };
      const smaller = LIST_PAGE_SIZES.find((candidate) => candidate < size) ?? 1;
      const items: Array<Record<string, unknown>> = [];
      let cursor = offset;
      const end = offset + size;
      while (cursor < end) {
        const part = await readWindow(cursor, Math.min(smaller, end - cursor));
        items.push(...part.items);
        cursor += Math.max(part.consumed, 1);
        if (part.done) return { items, consumed: cursor - offset, done: true };
      }
      return { items, consumed: size, done: false };
    }
  };

  let offset = 0;
  while (offset < maxItems) {
    const window = await readWindow(offset, PAGE_SIZE);
    if (window.items.length === 0) {
      if (window.done) break;
      offset += Math.max(window.consumed, 1);
      continue;
    }
    let older = 0;
    let added = 0;
    for (const item of window.items) {
      const parsed = parseListItem(item, categoryKey, day);
      if (parsed === "older") {
        older += 1;
        continue;
      }
      if (!parsed || seen.has(parsed.articleKey)) continue;
      seen.add(parsed.articleKey);
      rows.push(parsed);
      added += 1;
    }
    if (older > 0 || window.done) break;
    if (added === 0) break;
    offset += Math.max(window.consumed, 1);
  }
  return rows;
};

const upsertLists = async (client: Client, day: string, rows: ListRow[]) => {
  if (rows.length === 0) return;
  await client.query(
    `insert into dp.news_stock_article (
       article_key, office_id, article_id, category, published_at, title, summary,
       publisher, url, crawl_date
     )
     select *
     from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[],
       $6::text[], $7::text[], $8::text[], $9::text[], $10::date[]
     ) as t(
       article_key, office_id, article_id, category, published_at, title, summary,
       publisher, url, crawl_date
     )
     on conflict (article_key) do update
       set category = (
         select string_agg(distinct part, '|' order by part)
         from unnest(string_to_array(dp.news_stock_article.category || '|' || excluded.category, '|')) as part
         where part <> ''
       ),
       title = excluded.title,
       summary = case when excluded.summary <> '' then excluded.summary else dp.news_stock_article.summary end,
       publisher = case when excluded.publisher <> '' then excluded.publisher else dp.news_stock_article.publisher end,
       published_at = excluded.published_at,
       url = excluded.url,
       crawl_date = excluded.crawl_date,
       list_fetched_at = now()`,
    [
      rows.map((row) => row.articleKey),
      rows.map((row) => row.officeId),
      rows.map((row) => row.articleId),
      rows.map((row) => row.category),
      rows.map((row) => row.publishedAt),
      rows.map((row) => row.title),
      rows.map((row) => row.summary),
      rows.map((row) => row.publisher),
      rows.map((row) => row.url),
      rows.map(() => day),
    ],
  );
};

const parseClockText = (text: string) => {
  const match = cleanText(text).match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  let hour = Number(match[5]);
  const minute = match[6];
  if (match[4] === "오후" && hour < 12) hour += 12;
  if (match[4] === "오전" && hour === 12) hour = 0;
  const month = match[2].padStart(2, "0");
  const day = match[3].padStart(2, "0");
  return `${match[1]}-${month}-${day}T${String(hour).padStart(2, "0")}:${minute}:00+09:00`;
};

const elementSlice = (html: string, marker: string, from = 0) => {
  const at = html.indexOf(marker, from);
  if (at < 0) return "";
  const start = html.lastIndexOf("<", at);
  if (start < 0) return "";
  const openEnd = html.indexOf(">", start);
  if (openEnd < 0) return "";
  const tag = html.slice(start + 1, openEnd).match(/^([a-z0-9]+)/i)?.[1];
  if (!tag) return "";
  const close = `</${tag}>`;
  const openToken = `<${tag}`;
  let depth = 1;
  let index = openEnd + 1;
  while (index < html.length && depth > 0) {
    const nextOpen = html.indexOf(openToken, index);
    const nextClose = html.indexOf(close, index);
    if (nextClose < 0) return "";
    const nextChar = html[nextOpen + openToken.length];
    const openIsTag =
      nextOpen >= 0 &&
      nextOpen < nextClose &&
      (nextChar === ">" || nextChar === " " || nextChar === "/" || nextChar === "\n" || nextChar === "\t");
    if (openIsTag) {
      depth += 1;
      index = nextOpen + openToken.length;
    } else {
      depth -= 1;
      index = nextClose + close.length;
    }
  }
  return html.slice(start, index);
};

const elementText = (html: string, marker: string) =>
  cleanText(elementSlice(html, marker).replace(/<[^>]+>/g, " "));

const textByClass = (html: string, className: string) => {
  const match = new RegExp(`class=["'][^"']*\\b${className}\\b[^"']*["']`).exec(html);
  if (!match) return "";
  return cleanText(elementSlice(html, match[0], match.index).replace(/<[^>]+>/g, " "));
};

const attrNear = (html: string, marker: string, attr: string, span = 800) => {
  const at = html.indexOf(marker);
  if (at < 0) return "";
  const window = html.slice(at, at + span);
  const match = window.match(new RegExp(`${attr}=["']([^"']*)["']`, "i"));
  return cleanText(match?.[1]);
};

const metaProperty = (html: string, property: string) => {
  const quoted = [`property="${property}"`, `property='${property}'`];
  const at = quoted.map((token) => html.indexOf(token)).find((index) => index >= 0) ?? -1;
  if (at < 0) return "";
  const window = html.slice(Math.max(0, at - 180), at + 220);
  const match = window.match(/content=["']([^"']*)["']/i);
  return cleanText(match?.[1]);
};

const extractArticle = (html: string) => {
  const fragment =
    elementSlice(html, 'id="dic_area"') ||
    elementSlice(html, "id='dic_area'") ||
    elementSlice(html, 'id="newsct_article"') ||
    elementSlice(html, "id='newsct_article'");
  if (!fragment) {
    const hasBodyMarker =
      html.includes('id="dic_area"') ||
      html.includes("id='dic_area'") ||
      html.includes('id="newsct_article"') ||
      html.includes("id='newsct_article'");
    const lowered = html.toLowerCase();
    if (!hasBodyMarker && (lowered.includes("captcha") || html.includes("비정상적인 접근") || html.includes("접근이 제한"))) {
      throw new Error("BLOCKED");
    }
    throw new Error("기사 본문 영역을 찾지 못했습니다.");
  }
  const $ = cheerio.load(fragment);
  const bodyTag = $("#dic_area").length ? $("#dic_area") : $("#newsct_article");
  bodyTag.find("script, style, iframe, .end_photo_org, .vod_area, .ab_source, em.img_desc").remove();
  const body = cleanText(bodyTag.text());
  const title =
    elementText(html, 'id="title_area"') ||
    elementText(html, "media_end_head_headline") ||
    metaProperty(html, "og:title");
  const publisher = attrNear(html, "media_end_head_top_logo", "alt") || elementText(html, "media_end_head_top_logo");
  const reporter = textByClass(html, "media_end_head_journalist_name") || textByClass(html, "byline_s");
  const modifiedRaw =
    attrNear(html, "_ARTICLE_MODIFY_DATE_TIME", "data-date-time", 500) ||
    attrNear(html, "_ARTICLE_MODIFY_DATE_TIME", "datetime", 500) ||
    metaProperty(html, "article:modified_time");
  const modifiedAt =
    toKstTimestamp(modifiedRaw) || parseClockText(elementText(html, "_ARTICLE_MODIFY_DATE_TIME"));
  return { title, publisher, reporter, modifiedAt, body, bodyChars: body.length };
};

const fetchArticleHtml = async (url: string) => {
  const response = await fetchText(url);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const html = await response.text();
  if (!contentType.includes("html") && !html.trimStart().startsWith("<")) {
    throw new Error("기사 페이지가 HTML이 아닙니다.");
  }
  return html;
};

class NewsWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewsWriteError";
  }
}

export const crawlStockNewsDay = async (options: {
  date: string;
  dbSettingId?: number | null;
  bodyLimit?: number;
  onProgress?: (progress: StockNewsProgress) => void;
}): Promise<StockNewsProgress> => {
  const date = options.date.trim();
  if (!isCrawlDate(date)) {
    throw new Error("날짜를 선택하세요.");
  }
  const progress: StockNewsProgress = {
    date,
    phase: "list",
    listCount: 0,
    bodyTotal: 0,
    bodyDone: 0,
    bodyOk: 0,
    message: "목록을 가져오는 중",
    error: "",
  };
  const report = () => options.onProgress?.({ ...progress });
  report();

  const client = await connectNewsClient(options.dbSettingId);
  try {
    const merged = new Map<string, ListRow>();
    for (const category of CATEGORIES) {
      const rows = await collectCategory(category.key, category.code, date);
      for (const row of rows) {
        const existing = merged.get(row.articleKey);
        if (!existing) {
          merged.set(row.articleKey, row);
          continue;
        }
        const categories = new Set(`${existing.category}|${row.category}`.split("|").filter(Boolean));
        existing.category = [...categories].sort().join("|");
        if (row.summary) existing.summary = row.summary;
        if (row.publisher) existing.publisher = row.publisher;
        if (row.title) existing.title = row.title;
      }
      progress.listCount = merged.size;
      progress.message = `${category.key} 목록까지 ${merged.size}건`;
      report();
    }
    const listRows = [...merged.values()];
    await upsertLists(client, date, listRows);
    progress.listCount = listRows.length;

    const pending = await client.query<{ article_key: string; url: string }>(
      `select article_key, url
       from dp.news_stock_article
       where crawl_date = $1::date
         and body_status in ('pending', 'failed')
       order by published_at desc`,
      [date],
    );
    const targets =
      typeof options.bodyLimit === "number" && options.bodyLimit >= 0
        ? pending.rows.slice(0, options.bodyLimit)
        : pending.rows;
    progress.phase = "body";
    progress.bodyTotal = targets.length;
    progress.message = `본문 ${targets.length}건 수집`;
    report();

    let nextBodyAt = 0;
    const waitBodyGap = async () => {
      const now = Date.now();
      const start = Math.max(now, nextBodyAt);
      nextBodyAt = start + BODY_GAP_MS;
      if (start > now) await sleep(start - now);
    };

    type BodyWrite = {
      articleKey: string;
      title: string;
      publisher: string;
      reporter: string;
      modifiedAt: string | null;
      body: string;
      bodyChars: number;
      hash: string;
      status: string;
      error: string;
    };
    const buffer: BodyWrite[] = [];
    let commitChain: Promise<void> = Promise.resolve();
    const applyRows = async (rows: BodyWrite[]) => {
      try {
        await client.query(
          `update dp.news_stock_article as n
           set title = case when v.title <> '' then v.title else n.title end,
               publisher = case when v.publisher <> '' then v.publisher else n.publisher end,
               reporter = case when v.body_status = 'failed' then n.reporter else v.reporter end,
               modified_at = case when v.body_status = 'failed' then n.modified_at else v.modified_at end,
               body = case when v.body_status = 'failed' then n.body else v.body end,
               body_chars = case when v.body_status = 'failed' then n.body_chars else v.body_chars end,
               content_hash = case when v.body_status = 'failed' then n.content_hash else v.content_hash end,
               body_fetched_at = now(),
               body_status = v.body_status,
               body_error = v.body_error
           from unnest(
             $1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[],
             $6::text[], $7::int[], $8::text[], $9::text[], $10::text[]
           ) as v(
             article_key, title, publisher, reporter, modified_at, body, body_chars, content_hash, body_status, body_error
           )
           where n.article_key = v.article_key`,
          [
            rows.map((row) => row.articleKey),
            rows.map((row) => row.title),
            rows.map((row) => row.publisher),
            rows.map((row) => row.reporter),
            rows.map((row) => row.modifiedAt),
            rows.map((row) => row.body),
            rows.map((row) => row.bodyChars),
            rows.map((row) => row.hash),
            rows.map((row) => row.status),
            rows.map((row) => row.error),
          ],
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : "본문 저장 실패";
        throw new NewsWriteError(detail.slice(0, 300));
      }
      for (const row of rows) {
        if (row.status === "ok") progress.bodyOk += 1;
        progress.bodyDone += 1;
      }
      progress.message = `본문 ${progress.bodyDone}/${progress.bodyTotal}`;
      report();
      bodiesSinceRelease += rows.length;
      if (bodiesSinceRelease >= 400) releaseHeap();
    };
    const enqueueBody = (row: BodyWrite) => {
      buffer.push(row);
      if (buffer.length < BODY_WRITE_BATCH) return Promise.resolve();
      const rows = buffer.splice(0, buffer.length);
      commitChain = commitChain.then(() => applyRows(rows));
      return commitChain;
    };

    let cursor = 0;
    let blocked = false;
    const workerCount = Math.min(BODY_CONCURRENCY, targets.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!blocked) {
        const current = cursor;
        cursor += 1;
        if (current >= targets.length) return;
        const target = targets[current];
        await waitBodyGap();
        if (blocked) return;
        try {
          const parsed = extractArticle(await fetchArticleHtml(target.url));
          if (blocked) return;
          const status = parsed.bodyChars >= MIN_BODY_CHARS ? "ok" : "low_quality";
          await enqueueBody({
            articleKey: target.article_key,
            title: parsed.title,
            publisher: parsed.publisher,
            reporter: parsed.reporter,
            modifiedAt: parsed.modifiedAt,
            body: parsed.body,
            bodyChars: parsed.bodyChars,
            hash: contentHash(parsed.title, parsed.body),
            status,
            error: status === "ok" ? "" : "본문 길이가 기준보다 짧습니다.",
          });
        } catch (error) {
          if (error instanceof NewsWriteError) throw error;
          const message = error instanceof Error ? error.message : "본문 수집 실패";
          if (message === "BLOCKED") {
            blocked = true;
            progress.phase = "error";
            progress.error =
              "기사 페이지 접근이 제한되었습니다. 잠시 뒤 같은 날짜로 다시 실행하면 남은 기사만 이어 받습니다.";
            progress.message = progress.error;
            report();
            return;
          }
          await enqueueBody({
            articleKey: target.article_key,
            title: "",
            publisher: "",
            reporter: "",
            modifiedAt: null,
            body: "",
            bodyChars: 0,
            hash: "",
            status: "failed",
            error: message.slice(0, 300),
          });
        }
      }
    });
    await Promise.all(workers);
    if (buffer.length > 0) {
      const rows = buffer.splice(0, buffer.length);
      commitChain = commitChain.then(() => applyRows(rows));
    }
    await commitChain;
    if (blocked) return progress;

    progress.phase = "done";
    progress.message = `목록 ${progress.listCount}건, 이번 실행에서 본문 ${progress.bodyOk}건을 저장했습니다.`;
    report();
    return progress;
  } catch (error) {
    progress.phase = "error";
    progress.error = error instanceof Error ? error.message : "뉴스 수집에 실패했습니다.";
    progress.message = progress.error;
    report();
    return progress;
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
    releaseHeap();
  }
};

export const crawlStockNewsRange = async (options: {
  startDate: string;
  endDate: string;
  dbSettingId?: number | null;
  onProgress?: (progress: StockNewsRangeProgress) => void;
}): Promise<StockNewsRangeProgress> => {
  const dates = listCrawlDates(options.startDate, options.endDate);
  const startedAt = Date.now();
  const progress: StockNewsRangeProgress = {
    date: dates[0],
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    dayIndex: 0,
    dayCount: dates.length,
    phase: "list",
    listCount: 0,
    bodyTotal: 0,
    bodyDone: 0,
    bodyOk: 0,
    elapsedMs: 0,
    message: `${dates[0]}부터 ${dates.length}일 수집을 시작합니다.`,
    error: "",
  };
  const report = () => {
    progress.elapsedMs = Date.now() - startedAt;
    options.onProgress?.({ ...progress });
  };
  report();

  let listCount = 0;
  let bodyOk = 0;
  let bodyDone = 0;
  let bodyTotal = 0;
  for (let index = 0; index < dates.length; index += 1) {
    const day = dates[index];
    progress.date = day;
    progress.dayIndex = index + 1;
    const dayResult = await crawlStockNewsDay({
      date: day,
      dbSettingId: options.dbSettingId,
      onProgress: (dayProgress) => {
        progress.date = day;
        progress.dayIndex = index + 1;
        progress.phase = dayProgress.phase === "done" ? "body" : dayProgress.phase;
        progress.listCount = listCount + dayProgress.listCount;
        progress.bodyOk = bodyOk + dayProgress.bodyOk;
        progress.bodyDone = bodyDone + dayProgress.bodyDone;
        progress.bodyTotal = bodyTotal + dayProgress.bodyTotal;
        progress.error = dayProgress.error;
        progress.message = `${day} (${index + 1}/${dates.length}일) ${dayProgress.message}`;
        report();
      },
    });
    listCount += dayResult.listCount;
    bodyOk += dayResult.bodyOk;
    bodyDone += dayResult.bodyDone;
    bodyTotal += dayResult.bodyTotal;
    progress.listCount = listCount;
    progress.bodyOk = bodyOk;
    progress.bodyDone = bodyDone;
    progress.bodyTotal = bodyTotal;
    if (dayResult.phase === "error") {
      progress.phase = "error";
      progress.error = dayResult.error;
      progress.message = `${day}에서 멈췄습니다. ${dayResult.error} 소요 ${formatElapsed(Date.now() - startedAt)}.`;
      report();
      return progress;
    }
  }

  progress.phase = "done";
  progress.message = `${progress.startDate}~${progress.endDate} 목록 ${listCount}건을 확인했습니다. 이번에 새로 저장한 본문 ${bodyOk}건. 소요 ${formatElapsed(Date.now() - startedAt)}.`;
  report();
  return progress;
};

export type StockNewsPreview = {
  articleKey: string;
  publishedAt: string;
  publisher: string;
  title: string;
  bodyStatus: string;
  bodyChars: number;
};

export const readStockNewsDay = async (
  startDate: string,
  endDate: string,
  dbSettingId?: number | null,
) => {
  const dates = listCrawlDates(startDate, endDate);
  const client = await connectNewsClient(dbSettingId);
  try {
    const counts = await client.query<{ total: number; ok_count: number; pending_count: number }>(
      `select count(*)::int as total,
              count(*) filter (where body_status = 'ok')::int as ok_count,
              count(*) filter (where body_status in ('pending', 'failed'))::int as pending_count
       from dp.news_stock_article
       where crawl_date between $1::date and $2::date`,
      [dates[0], dates[dates.length - 1]],
    );
    const preview = await client.query<{
      article_key: string;
      published_at: string;
      publisher: string;
      title: string;
      body_status: string;
      body_chars: number;
    }>(
      `select article_key, published_at, publisher, title, body_status, body_chars
       from dp.news_stock_article
       where crawl_date between $1::date and $2::date
       order by published_at desc
       limit 12`,
      [dates[0], dates[dates.length - 1]],
    );
    const row = counts.rows[0];
    return {
      total: Number(row?.total ?? 0),
      okCount: Number(row?.ok_count ?? 0),
      pendingCount: Number(row?.pending_count ?? 0),
      articles: preview.rows.map((item) => ({
        articleKey: item.article_key,
        publishedAt: item.published_at,
        publisher: item.publisher,
        title: item.title,
        bodyStatus: item.body_status,
        bodyChars: Number(item.body_chars) || 0,
      })) satisfies StockNewsPreview[],
    };
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
};
