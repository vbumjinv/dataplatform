import { connectNewsClient } from "./news-collect";
import { ensureNytSchema, readNytSource } from "./nyt-source";

const SEARCH_URL = "https://api.nytimes.com/svc/search/v2/articlesearch.json";
const PAGE_GAP_MS = 12_000;
const MAX_PAGE = 100;
const FILTER = 'typeOfMaterials:News AND section.name:("World", "U.S.", "Business", "Politics")';

export const nytKeywordTerms = (keywords: string) =>
  keywords
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter(Boolean);

const keywordTermQuery = (term: string) => (/\s/.test(term) ? `"${term.replaceAll('"', "")}"` : term);

export type NytArticleRow = {
  articleId: string;
  webUrl: string;
  headline: string;
  abstract: string;
  sectionName: string;
  publishedAt: string;
};

export type NytJobState = {
  running: boolean;
  startedAt: number;
  startDate: string;
  endDate: string;
  phase: "list" | "done" | "error";
  saved: number;
  elapsedMs: number;
  message: string;
  error: string;
};

const idleJob = (): NytJobState => ({
  running: false,
  startedAt: 0,
  startDate: "",
  endDate: "",
  phase: "done",
  saved: 0,
  elapsedMs: 0,
  message: "",
  error: "",
});

const getJob = (): NytJobState => {
  const globalRef = globalThis as typeof globalThis & { __nytNewsJob?: NytJobState };
  if (!globalRef.__nytNewsJob) globalRef.__nytNewsJob = idleJob();
  return globalRef.__nytNewsJob;
};

export const readNytJob = () => {
  const job = getJob();
  if (job.running && job.startedAt > 0) job.elapsedMs = Date.now() - job.startedAt;
  return { ...job };
};

const formatElapsed = (elapsedMs: number) => {
  const total = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
};

const listDates = (start: string, end: string) => {
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

const toYmd = (iso: string) => iso.replaceAll("-", "");

type NytDoc = {
  uri?: string;
  _id?: string;
  web_url?: string;
  abstract?: string;
  snippet?: string;
  pub_date?: string;
  section_name?: string;
  headline?: { main?: string } | string;
  section?: { name?: string };
};

type NytSearchResponse = {
  status?: string;
  message?: string;
  fault?: { faultstring?: string };
  response?: {
    docs?: NytDoc[] | null;
    meta?: { hits?: number };
    metadata?: { hits?: number };
  };
};

const headlineOf = (doc: NytDoc) => {
  if (typeof doc.headline === "string") return doc.headline.trim();
  return (doc.headline?.main ?? "").trim();
};

const sectionOf = (doc: NytDoc) => (doc.section?.name ?? doc.section_name ?? "").trim();

const articleIdOf = (doc: NytDoc) => (doc.uri ?? doc._id ?? doc.web_url ?? "").trim();

const fetchPage = async (key: string, day: string, page: number, query: string) => {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("fq", FILTER);
  url.searchParams.set("begin_date", toYmd(day));
  url.searchParams.set("end_date", toYmd(day));
  url.searchParams.set("sort", "newest");
  url.searchParams.set("page", String(page));
  url.searchParams.set("api-key", key);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const payload = (await response.json()) as NytSearchResponse;
  return { response, payload };
};

const upsertDocs = async (settingId: number | null, docs: NytDoc[]) => {
  const byId = new Map<string, NytDoc>();
  for (const doc of docs) {
    const articleId = articleIdOf(doc);
    if (!articleId || !headlineOf(doc)) continue;
    byId.set(articleId, doc);
  }
  const rows = [...byId.values()];
  if (!rows.length) return 0;
  const client = await connectNewsClient(settingId);
  try {
    const result = await client.query(
      `insert into dp.news_nyt_article (
         article_id, web_url, headline, abstract, section_name, published_at, pub_date, fetched_at
       )
       select v.article_id, v.web_url, v.headline, v.abstract, v.section_name,
              nullif(v.published_at, '')::timestamptz, nullif(v.pub_date, '')::date, now()
         from unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
         ) as v(article_id, web_url, headline, abstract, section_name, published_at, pub_date)
       on conflict (article_id) do update
         set web_url = excluded.web_url,
             headline = excluded.headline,
             abstract = excluded.abstract,
             section_name = excluded.section_name,
             published_at = excluded.published_at,
             pub_date = excluded.pub_date,
             fetched_at = now()`,
      [
        rows.map((row) => articleIdOf(row)),
        rows.map((row) => (row.web_url ?? "").trim()),
        rows.map((row) => headlineOf(row)),
        rows.map((row) => (row.abstract ?? row.snippet ?? "").trim()),
        rows.map((row) => sectionOf(row)),
        rows.map((row) => (row.pub_date ?? "").trim()),
        rows.map((row) => ((row.pub_date ?? "").trim().slice(0, 10))),
      ],
    );
    return result.rowCount ?? rows.length;
  } finally {
    await client.end();
  }
};

const collectRange = async (startDate: string, endDate: string, dbSettingId: number | null) => {
  const setting = await readNytSource(dbSettingId);
  const key = setting.apiKey.trim();
  const terms = nytKeywordTerms(setting.keywords);
  if (!key) throw new Error("설정에서 NYT API 키를 입력하세요.");
  if (!terms.length) throw new Error("설정에서 키워드를 하나 이상 입력하세요.");
  const job = getJob();
  const seen = new Set<string>();
  let requests = 0;
  const dates = listDates(startDate, endDate);
  for (const day of dates) {
    for (const term of terms) {
      let page = 0;
      while (page <= MAX_PAGE) {
        if (requests > 0) await new Promise((resolve) => setTimeout(resolve, PAGE_GAP_MS));
        job.message = `${day} ${term} ${page + 1}페이지를 가져오는 중`;
        const { response, payload } = await fetchPage(key, day, page, keywordTermQuery(term));
        requests += 1;
        if (response.status === 429) {
          throw new Error(
            `NYT 호출 한도에 도달했습니다. ${day} ${term}에서 멈췄습니다. 나중에 같은 기간으로 다시 실행하면 받은 기사는 갱신됩니다.`,
          );
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error("NYT API 키를 확인하세요.");
        }
        if (!response.ok || (payload.status && payload.status !== "OK")) {
          const detail = payload.fault?.faultstring || payload.message || payload.status || String(response.status);
          throw new Error(`NYT 조회에 실패했습니다. (${detail})`);
        }
        const docs = Array.isArray(payload.response?.docs) ? payload.response.docs : [];
        if (!docs.length) break;
        await upsertDocs(dbSettingId, docs);
        for (const doc of docs) {
          const articleId = articleIdOf(doc);
          if (articleId) seen.add(articleId);
        }
        job.saved = seen.size;
        const hits = Number(payload.response?.metadata?.hits ?? payload.response?.meta?.hits ?? 0);
        if (docs.length < 10 || (hits > 0 && (page + 1) * 10 >= hits) || page >= MAX_PAGE) break;
        page += 1;
      }
    }
  }
  return seen.size;
};

export const startNytNewsJob = (startDate: string, endDate: string, dbSettingId?: number | null) => {
  const job = getJob();
  if (job.running) return { started: false, job: { ...job } };
  const settingId = typeof dbSettingId === "number" ? dbSettingId : null;
  const startedAt = Date.now();
  job.running = true;
  job.startedAt = startedAt;
  job.startDate = startDate;
  job.endDate = endDate;
  job.phase = "list";
  job.saved = 0;
  job.elapsedMs = 0;
  job.error = "";
  job.message = "NYT 기사를 가져오는 중";
  void collectRange(startDate, endDate, settingId)
    .then((saved) => {
      const current = getJob();
      current.phase = "done";
      current.saved = saved;
      current.message = `${startDate}~${endDate} 기사 ${saved}건을 반영했습니다. 소요 ${formatElapsed(Date.now() - startedAt)}.`;
    })
    .catch((error: unknown) => {
      const current = getJob();
      current.phase = "error";
      current.error = error instanceof Error ? error.message : "NYT 뉴스 수집에 실패했습니다.";
      current.message = current.error;
    })
    .finally(() => {
      const current = getJob();
      current.running = false;
      current.elapsedMs = Date.now() - current.startedAt;
    });
  return { started: true, job: { ...job } };
};

type ArticleDbRow = {
  article_id: string;
  web_url: string;
  headline: string;
  abstract: string;
  section_name: string;
  published_at: string | null;
};

export const readNytArticles = async (startDate: string, endDate: string, dbSettingId?: number | null) => {
  await ensureNytSchema(dbSettingId);
  const client = await connectNewsClient(dbSettingId);
  try {
    const counts = await client.query<{ total: number }>(
      `select count(*)::int as total
         from dp.news_nyt_article
        where pub_date between $1::date and $2::date`,
      [startDate, endDate],
    );
    const preview = await client.query<ArticleDbRow>(
      `select article_id, web_url, headline, abstract, section_name, published_at::text
         from dp.news_nyt_article
        where pub_date between $1::date and $2::date
        order by published_at desc nulls last
        limit 12`,
      [startDate, endDate],
    );
    return {
      total: counts.rows[0]?.total ?? 0,
      articles: preview.rows.map(
        (row): NytArticleRow => ({
          articleId: row.article_id,
          webUrl: row.web_url,
          headline: row.headline,
          abstract: row.abstract,
          sectionName: row.section_name,
          publishedAt: row.published_at ?? "",
        }),
      ),
    };
  } finally {
    await client.end();
  }
};
