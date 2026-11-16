import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { connectNewsClient } from "./news-collect";
import { ensureDartSchema, readDartSource } from "./dart-source";

const LIST_URL = "https://opendart.fss.or.kr/api/list.json";
const PAGE_SIZE = 100;
const CHUNK_DAYS = 89;
const SPLIT_PAGES = 100;

export type DartDisclosureRow = {
  rceptNo: string;
  rceptDt: string;
  corpCode: string;
  corpName: string;
  stockCode: string;
  corpCls: string;
  corpClsName: string;
  reportNm: string;
  flrNm: string;
  rm: string;
  url: string;
};

export type DartJobState = {
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

const CORP_CLS_NAME: Record<string, string> = {
  Y: "유가",
  K: "코스닥",
  N: "코넥스",
  E: "기타",
};

const idleJob = (): DartJobState => ({
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

const getJob = (): DartJobState => {
  const globalRef = globalThis as typeof globalThis & { __dartDisclosureJob?: DartJobState };
  if (!globalRef.__dartDisclosureJob) globalRef.__dartDisclosureJob = idleJob();
  return globalRef.__dartDisclosureJob;
};

export const readDartJob = () => {
  const job = getJob();
  if (job.running && job.startedAt > 0) job.elapsedMs = Date.now() - job.startedAt;
  return { ...job };
};

const formatElapsed = (elapsedMs: number) => {
  const total = Math.max(0, Math.round(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
};

const addDays = (iso: string, days: number) => {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const midpoint = (start: string, end: string) => {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const startMs = Date.UTC(startYear, startMonth - 1, startDay);
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);
  return new Date(startMs + Math.floor((endMs - startMs) / 2)).toISOString().slice(0, 10);
};

const chunkRange = (start: string, end: string) => {
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = start;
  while (cursor <= end) {
    const candidate = addDays(cursor, CHUNK_DAYS);
    const chunkEnd = candidate < end ? candidate : end;
    chunks.push({ start: cursor, end: chunkEnd });
    if (chunkEnd === end) break;
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
};

const toYmd = (iso: string) => iso.replaceAll("-", "");

const toIsoDate = (ymd: string) => {
  if (!/^\d{8}$/.test(ymd)) return "";
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
};

const corpClsName = (code: string) => CORP_CLS_NAME[code] ?? code;

const disclosureUrl = (rceptNo: string) =>
  `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(rceptNo)}`;

const readDartApiKey = () => {
  const fromEnv = (process.env.DART_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const candidates = [path.join(process.cwd(), "web", ".env"), path.join(process.cwd(), ".env")];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      if (trimmed.slice(0, eq).trim() !== "DART_API_KEY") continue;
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  return "";
};

type DartListItem = {
  corp_cls?: string;
  corp_name?: string;
  corp_code?: string;
  stock_code?: string;
  report_nm?: string;
  rcept_no?: string;
  flr_nm?: string;
  rcept_dt?: string;
  rm?: string;
};

type DartListResponse = {
  status?: string;
  message?: string;
  total_page?: number | string;
  list?: DartListItem[];
};

const fetchPage = async (key: string, start: string, end: string, page: number) => {
  const url = new URL(LIST_URL);
  url.searchParams.set("crtfc_key", key);
  url.searchParams.set("bgn_de", toYmd(start));
  url.searchParams.set("end_de", toYmd(end));
  url.searchParams.set("page_no", String(page));
  url.searchParams.set("page_count", String(PAGE_SIZE));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const payload = (await response.json()) as DartListResponse;
  return payload;
};

const upsertPage = async (
  settingId: number | null,
  items: DartListItem[],
) => {
  const byNo = new Map<string, DartListItem>();
  for (const item of items) {
    const rceptNo = (item.rcept_no ?? "").trim();
    const rceptDt = toIsoDate((item.rcept_dt ?? "").trim());
    if (!rceptNo || !rceptDt) continue;
    byNo.set(rceptNo, item);
  }
  const rows = [...byNo.values()];
  if (!rows.length) return 0;
  const client = await connectNewsClient(settingId);
  try {
    const result = await client.query(
      `insert into dp.dart_disclosure (
         rcept_no, rcept_dt, corp_code, corp_name, stock_code, corp_cls, report_nm, flr_nm, rm, fetched_at
       )
       select v.rcept_no, v.rcept_dt::date, v.corp_code, v.corp_name, v.stock_code, v.corp_cls,
              v.report_nm, v.flr_nm, v.rm, now()
         from unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
         ) as v(rcept_no, rcept_dt, corp_code, corp_name, stock_code, corp_cls, report_nm, flr_nm, rm)
       on conflict (rcept_no) do update
         set rcept_dt = excluded.rcept_dt,
             corp_code = excluded.corp_code,
             corp_name = excluded.corp_name,
             stock_code = excluded.stock_code,
             corp_cls = excluded.corp_cls,
             report_nm = excluded.report_nm,
             flr_nm = excluded.flr_nm,
             rm = excluded.rm,
             fetched_at = now()`,
      [
        rows.map((row) => (row.rcept_no ?? "").trim()),
        rows.map((row) => toIsoDate((row.rcept_dt ?? "").trim())),
        rows.map((row) => (row.corp_code ?? "").trim()),
        rows.map((row) => (row.corp_name ?? "").trim()),
        rows.map((row) => (row.stock_code ?? "").trim()),
        rows.map((row) => (row.corp_cls ?? "").trim()),
        rows.map((row) => (row.report_nm ?? "").trim()),
        rows.map((row) => (row.flr_nm ?? "").trim()),
        rows.map((row) => (row.rm ?? "").trim()),
      ],
    );
    return result.rowCount ?? rows.length;
  } finally {
    await client.end();
  }
};

const collectRange = async (startDate: string, endDate: string, dbSettingId: number | null) => {
  const setting = await readDartSource(dbSettingId);
  const key = setting.apiKey.trim() || readDartApiKey();
  if (!key) {
    throw new Error("설정에서 OpenDART 인증키를 입력하세요.");
  }
  const job = getJob();
  const collectChunk = async (start: string, end: string): Promise<number> => {
    job.message = `${start}~${end} 목록을 확인하는 중`;
    const first = await fetchPage(key, start, end, 1);
    const status = first.status ?? "";
    if (status === "013") return 0;
    if (status !== "000") {
      throw new Error(first.message || `OpenDART 조회에 실패했습니다. (${status || "응답 없음"})`);
    }
    const totalPage = Math.max(1, Number(first.total_page) || 1);
    if (totalPage > SPLIT_PAGES && start < end) {
      const mid = midpoint(start, end);
      const rightStart = addDays(mid, 1);
      const left = await collectChunk(start, mid);
      const right = rightStart <= end ? await collectChunk(rightStart, end) : 0;
      return left + right;
    }
    let saved = await upsertPage(dbSettingId, first.list ?? []);
    job.saved += saved;
    for (let page = 2; page <= totalPage; page += 1) {
      job.message = `${start}~${end} ${page}/${totalPage}페이지를 가져오는 중`;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const payload = await fetchPage(key, start, end, page);
      const pageStatus = payload.status ?? "";
      if (pageStatus === "013") break;
      if (pageStatus !== "000") {
        throw new Error(payload.message || `OpenDART 조회에 실패했습니다. (${pageStatus || "응답 없음"})`);
      }
      const count = await upsertPage(dbSettingId, payload.list ?? []);
      saved += count;
      job.saved += count;
    }
    return saved;
  };

  let saved = 0;
  for (const chunk of chunkRange(startDate, endDate)) {
    saved += await collectChunk(chunk.start, chunk.end);
  }
  return saved;
};

export const startDartDisclosureJob = (
  startDate: string,
  endDate: string,
  dbSettingId?: number | null,
) => {
  const job = getJob();
  if (job.running) return { started: false, job: { ...job } };
  const settingId = typeof dbSettingId === "number" ? dbSettingId : null;
  job.running = true;
  job.startedAt = Date.now();
  job.startDate = startDate;
  job.endDate = endDate;
  job.phase = "list";
  job.saved = 0;
  job.elapsedMs = 0;
  job.error = "";
  job.message = "공시 목록을 가져오는 중";
  void collectRange(startDate, endDate, settingId)
    .then((saved) => {
      const current = getJob();
      current.phase = "done";
      current.saved = saved;
      current.message = `${startDate}~${endDate} 공시 ${saved}건을 반영했습니다. 소요 ${formatElapsed(Date.now() - current.startedAt)}.`;
    })
    .catch((error: unknown) => {
      const current = getJob();
      current.phase = "error";
      current.error = error instanceof Error ? error.message : "DART 공시 수집에 실패했습니다.";
      current.message = current.error;
    })
    .finally(() => {
      const current = getJob();
      current.running = false;
      current.elapsedMs = Date.now() - current.startedAt;
    });
  return { started: true, job: { ...job } };
};

type DisclosureDbRow = {
  rcept_no: string;
  rcept_dt: string;
  corp_code: string;
  corp_name: string;
  stock_code: string;
  corp_cls: string;
  report_nm: string;
  flr_nm: string;
  rm: string;
};

const mapDisclosure = (row: DisclosureDbRow): DartDisclosureRow => ({
  rceptNo: row.rcept_no,
  rceptDt: typeof row.rcept_dt === "string" ? row.rcept_dt.slice(0, 10) : "",
  corpCode: row.corp_code,
  corpName: row.corp_name,
  stockCode: row.stock_code,
  corpCls: row.corp_cls,
  corpClsName: corpClsName(row.corp_cls),
  reportNm: row.report_nm,
  flrNm: row.flr_nm,
  rm: row.rm,
  url: disclosureUrl(row.rcept_no),
});

export const readDartDisclosures = async (
  startDate: string,
  endDate: string,
  dbSettingId?: number | null,
) => {
  await ensureDartSchema(dbSettingId);
  const client = await connectNewsClient(dbSettingId);
  try {
    const counts = await client.query<{ total: number }>(
      `select count(*)::int as total
         from dp.dart_disclosure
        where rcept_dt between $1::date and $2::date`,
      [startDate, endDate],
    );
    const preview = await client.query<DisclosureDbRow>(
      `select rcept_no, rcept_dt::text, corp_code, corp_name, stock_code, corp_cls, report_nm, flr_nm, rm
         from dp.dart_disclosure
        where rcept_dt between $1::date and $2::date
        order by rcept_dt desc, corp_name
        limit 12`,
      [startDate, endDate],
    );
    return {
      total: counts.rows[0]?.total ?? 0,
      disclosures: preview.rows.map(mapDisclosure),
    };
  } finally {
    await client.end();
  }
};
