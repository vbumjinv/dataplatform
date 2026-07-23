import { Client } from "pg";
import { resolveDbConfig } from "../db/_lib/connection";

const CONNECT_TIMEOUT_MS = 5000;
const MAX_BIND_PARAMS_PER_QUERY = 30000;
const parsePositiveInt = (raw: string | undefined, fallback: number) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) return fallback;
  return normalized;
};
const API_FETCH_TIMEOUT_MS = parsePositiveInt(
  process.env.INGESTION_API_FETCH_TIMEOUT_MS,
  60000,
);
const API_FETCH_MAX_ATTEMPTS = parsePositiveInt(
  process.env.INGESTION_API_FETCH_MAX_ATTEMPTS,
  3,
);
const BOK_PAGE_MAX_ROWS = parsePositiveInt(process.env.INGESTION_BOK_PAGE_SIZE, 100000);
const BOK_MAX_PAGES = parsePositiveInt(process.env.INGESTION_BOK_MAX_PAGES, 50);
const KRX_GOLD_MAX_DAYS = parsePositiveInt(process.env.INGESTION_KRX_GOLD_MAX_DAYS, 10000);
const KRX_GOLD_REQUEST_DELAY_MS = parsePositiveInt(process.env.INGESTION_KRX_GOLD_REQUEST_DELAY_MS, 350);
// 공공데이터포털 특일정보(SpcdeInfoService)는 solYear/solMonth 로 월 단위 1회씩만 조회 가능하여
// 기간만큼 월별로 반복 호출한다.
const SPCDE_MAX_MONTHS = parsePositiveInt(process.env.INGESTION_SPCDE_MAX_MONTHS, 600);
const SPCDE_DEFAULT_NUM_OF_ROWS = "100";
// UN Population Division Data Portal: /data 응답은 100건씩 nextPage 로 페이지네이션된다.
const UNDP_MAX_PAGES = parsePositiveInt(process.env.INGESTION_UNDP_MAX_PAGES, 2000);
// UN 데이터 엔드포인트는 고정이므로 등록된 base_url 표기 편차와 무관하게 항상 이 값을 사용한다.
const UNDP_DATA_BASE_URL = "https://population.un.org/dataportalapi/api/v1/data";
// yfinance 수집은 HTTP API 가 아니라 python-forecast-api(/yfinance) 실행으로 처리한다.
const PY_YFINANCE_API_URL = process.env.PY_YFINANCE_API_URL ?? "http://127.0.0.1:8001/yfinance";
const PY_YFINANCE_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.PY_YFINANCE_TIMEOUT_MS ?? 120000) || 120000,
);
const END_LATEST_TOKEN = "__TODAY__";
const START_RELATIVE_TOKEN_REGEX = /^__TODAY_MINUS_(\d+)(D|M|Q|A|Y)__$/i;
const START_RELATIVE_KO_REGEX = /^(\d+)\s*(일|개월|분기|년)\s*전$/;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const formatErrorWithCause = (error: unknown) => {
  if (!(error instanceof Error)) return String(error ?? "unknown");
  const cause = error.cause as { code?: string; errno?: string; syscall?: string } | undefined;
  const parts = [`${error.name}: ${error.message}`];
  if (cause?.code) parts.push(`cause.code=${cause.code}`);
  if (cause?.errno) parts.push(`cause.errno=${cause.errno}`);
  if (cause?.syscall) parts.push(`cause.syscall=${cause.syscall}`);
  return parts.join(" | ");
};
const makeLoadAbortError = () => {
  const error = new Error("적재가 취소되었습니다.");
  error.name = "AbortError";
  return error;
};
const isLoadAbortError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" || error.message.includes("적재가 취소되었습니다."));
const throwIfLoadAborted = (signal?: AbortSignal | null) => {
  if (signal?.aborted) {
    throw makeLoadAbortError();
  }
};

const isRetryableStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
const parseRetryAfterMs = (value: string | null) => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.trunc(seconds * 1000);
  }
  const targetTime = Date.parse(value);
  if (Number.isNaN(targetTime)) return null;
  const ms = targetTime - Date.now();
  return ms > 0 ? ms : null;
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeJdbcUrl = (raw: string) => {
  if (raw.startsWith("jdbc:")) {
    return raw.replace(/^jdbc:/, "");
  }
  return raw;
};
const buildConnectionString = (payload: {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
}) => {
  if (!payload.url) return null;
  const normalized = normalizeJdbcUrl(payload.url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return null;
  }
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};
const escapeIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

const castForColumn = (dataType: string, colRef: string): string => {
  const t = dataType?.toLowerCase() ?? "text";
  if (
    t === "numeric" ||
    t === "decimal" ||
    t === "real" ||
    t === "double precision"
  ) {
    return `case
      when ${colRef} is null then null
      when nullif(regexp_replace((${colRef})::text, ',', '', 'g'), '') is null then null
      when nullif(regexp_replace((${colRef})::text, ',', '', 'g'), '') ~ '^[-+]?\\d+(\\.\\d+)?$'
        then (nullif(regexp_replace((${colRef})::text, ',', '', 'g'), ''))::numeric
      else null
    end`;
  }
  if (
    t === "smallint" ||
    t === "integer" ||
    t === "bigint" ||
    t === "serial" ||
    t === "bigserial"
  ) {
    return `case
      when ${colRef} is null then null
      when nullif(regexp_replace((${colRef})::text, ',', '', 'g'), '') is null then null
      when nullif(regexp_replace((${colRef})::text, ',', '', 'g'), '') ~ '^[-+]?\\d+$'
        then (nullif(regexp_replace((${colRef})::text, ',', '', 'g'), ''))::bigint
      else null
    end`;
  }
  return colRef;
};
const normalizeCellByType = (value: unknown, dataType: string) => {
  if (value == null) return null;
  const t = dataType?.toLowerCase() ?? "text";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (
      t === "numeric" ||
      t === "decimal" ||
      t === "real" ||
      t === "double precision"
    ) {
      const cleaned = trimmed.replaceAll(",", "");
      if (!cleaned) return null;
      return /^[-+]?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
    }
    if (
      t === "smallint" ||
      t === "integer" ||
      t === "bigint" ||
      t === "serial" ||
      t === "bigserial"
    ) {
      const cleaned = trimmed.replaceAll(",", "");
      if (!cleaned) return null;
      return /^[-+]?\d+$/.test(cleaned) ? cleaned : null;
    }
    return trimmed;
  }
  return value;
};
const decodeSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const normalizeValue = (value: string, mode?: string) => {
  const normalized = mode === "decode" ? decodeSafe(value) : value;
  if (mode === "none") return normalized;
  return encodeURIComponent(normalized);
};
// Path 값은 "/"를 경로 구분자로 보존하고, 각 세그먼트만 개별 인코딩한다.
// (예: "openapi/service/SpcdeInfoService" 의 "/"가 %2F로 깨지지 않도록)
const normalizePathValue = (value: string, mode?: string) =>
  value
    .split("/")
    .map((segment) => normalizeValue(segment, mode))
    .join("/");
const parseXmlRows = (value: string): Array<Record<string, string>> | null => {
  const xmlCandidate = value.includes("&lt;")
    ? value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
    : value;
  const xmlStart = xmlCandidate.indexOf("<");
  if (xmlStart < 0) return null;
  const trimmed = xmlCandidate.slice(xmlStart).trim();
  if (!trimmed.startsWith("<")) return null;
  const rowMatches = Array.from(
    trimmed.matchAll(/<(?:[\w-]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?row>/gi),
  );
  const itemMatches = Array.from(
    trimmed.matchAll(/<(?:[\w-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?item>/gi),
  );
  const targets = rowMatches.length > 0 ? rowMatches : itemMatches;
  if (!targets.length) return null;

  const rows: Array<Record<string, string>> = [];
  for (const match of targets) {
    const block = match[1] ?? "";
    const record: Record<string, string> = {};
    const fieldMatches = Array.from(
      block.matchAll(
        /<((?:[\w-]+:)?[a-zA-Z0-9_:-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g,
      ),
    );
    for (const field of fieldMatches) {
      const rawKey = field[1]?.trim();
      const key = rawKey ? rawKey.split(":").pop()?.trim() ?? rawKey : "";
      if (!key) continue;
      const rawValue = (field[2] ?? "").trim();
      record[key] = decodeSafe(rawValue);
    }
    if (Object.keys(record).length > 0) {
      rows.push(record);
    }
  }
  return rows.length ? rows : null;
};
const toPeriodValue = (date: Date, period: string) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  if (period === "D") return `${year}${pad(month)}${pad(day)}`;
  if (period === "M") return `${year}${pad(month)}`;
  if (period === "Q") return `${year}Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "A" || period === "Y") return `${year}`;
  return "";
};
const toIsoDateValue = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const shouldUseIsoDateParamFormat = (paramKey: string) => {
  const normalized = paramKey.trim().toLowerCase();
  return normalized === "observation_start" || normalized === "observation_end";
};
const shouldUseDailyCompactParamFormat = (paramKey: string) =>
  paramKey.trim().toLowerCase() === "basdd";
// OECD(SDMX) startPeriod/endPeriod 는 하이픈 표기(YYYY / YYYY-Qn / YYYY-MM / YYYY-MM-DD)를 쓴다.
const shouldUseOecdPeriodFormat = (paramKey: string) => {
  const normalized = paramKey.trim().toLowerCase();
  return normalized === "startperiod" || normalized === "endperiod";
};
const toOecdPeriodValue = (date: Date, period: string) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const pad2 = (value: number) => String(value).padStart(2, "0");
  if (period === "A" || period === "Y") return `${year}`;
  if (period === "Q") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "D") return `${year}-${pad2(month)}-${pad2(date.getDate())}`;
  return `${year}-${pad2(month)}`;
};
const toParamDateValue = (date: Date, period: string, paramKey: string) => {
  if (shouldUseIsoDateParamFormat(paramKey)) {
    return toIsoDateValue(date);
  }
  if (shouldUseDailyCompactParamFormat(paramKey)) {
    return toPeriodValue(date, "D");
  }
  if (shouldUseOecdPeriodFormat(paramKey)) {
    return toOecdPeriodValue(date, period);
  }
  return toPeriodValue(date, period);
};
const shiftDateByUnit = (base: Date, offset: number, unit: "D" | "M" | "Q" | "A" | "Y") => {
  const next = new Date(base);
  if (unit === "D") {
    next.setDate(next.getDate() - offset);
    return next;
  }
  if (unit === "M") {
    next.setMonth(next.getMonth() - offset);
    return next;
  }
  if (unit === "Q") {
    next.setMonth(next.getMonth() - offset * 3);
    return next;
  }
  next.setFullYear(next.getFullYear() - offset);
  return next;
};
const resolveRelativeStartValue = (raw: string, period: string, paramKey: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const tokenMatch = START_RELATIVE_TOKEN_REGEX.exec(trimmed);
  if (tokenMatch) {
    const offset = Number(tokenMatch[1]);
    const unit = tokenMatch[2].toUpperCase() as "D" | "M" | "Q" | "A" | "Y";
    if (!Number.isFinite(offset) || offset < 0) return null;
    const shifted = shiftDateByUnit(new Date(), offset, unit);
    return toParamDateValue(shifted, period, paramKey);
  }
  const koMatch = START_RELATIVE_KO_REGEX.exec(trimmed);
  if (koMatch) {
    const offset = Number(koMatch[1]);
    if (!Number.isFinite(offset) || offset < 0) return null;
    const unitText = koMatch[2];
    const unit =
      unitText === "일"
        ? "D"
        : unitText === "개월"
          ? "M"
          : unitText === "분기"
            ? "Q"
            : "Y";
    const shifted = shiftDateByUnit(new Date(), offset, unit);
    return toParamDateValue(shifted, period, paramKey);
  }
  return null;
};
const parseDateText = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{8}$/.test(trimmed)) {
    const normalized = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    const parsed = new Date(`${normalized}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(`${trimmed}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const formatAsYmdCompact = (date: Date) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate(),
  ).padStart(2, "0")}`;
// World Bank date=시작:종료 의 각 구간을 "연도"로 해석한다.
//   - __TODAY__ → 올해, __TODAY_MINUS_{n}Y__ / "{n}년 전" → 올해-n (연 단위 데이터라 n을 연으로 취급)
//   - 그 외 값에서 4자리 연도를 추출 (예: '1980', '1980-01-01' → '1980')
const resolveWorldBankYear = (raw: string): string | null => {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const now = new Date();
  if (value === END_LATEST_TOKEN) return String(now.getFullYear());
  const tokenMatch = START_RELATIVE_TOKEN_REGEX.exec(value);
  if (tokenMatch) {
    const n = Number(tokenMatch[1]);
    return Number.isFinite(n) ? String(now.getFullYear() - n) : null;
  }
  const koMatch = START_RELATIVE_KO_REGEX.exec(value);
  if (koMatch) {
    const n = Number(koMatch[1]);
    return Number.isFinite(n) ? String(now.getFullYear() - n) : null;
  }
  const year = value.match(/(\d{4})/);
  return year ? year[1] : null;
};
// "시작:종료"(또는 단일 값)를 실제 연도 범위로 해석한다. 토큰이 섞여 있어도 처리한다.
const resolveWorldBankDateRange = (raw: string): string | null => {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.includes(":")) {
    const [start, end] = value.split(":");
    const startYear = resolveWorldBankYear(start);
    const endYear = resolveWorldBankYear(end);
    if (startYear && endYear) return `${startYear}:${endYear}`;
    return startYear ?? endYear ?? null;
  }
  return resolveWorldBankYear(value);
};
const parsePeriodDate = (value: string, period: string) => {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (period === "D") {
    if (!/^\d{8}$/.test(text)) return null;
    const parsed = new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (period === "M") {
    if (!/^\d{6}$/.test(text)) return null;
    const parsed = new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-01T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (period === "Q") {
    const match = /^(\d{4})Q([1-4])$/i.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const month = (quarter - 1) * 3 + 1;
    const parsed = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (period === "A" || period === "Y") {
    if (!/^\d{4}$/.test(text)) return null;
    const parsed = new Date(`${text}-01-01T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};
const addPeriodUnits = (base: Date, period: string, units: number) => {
  const next = new Date(base);
  if (period === "D") {
    next.setDate(next.getDate() + units);
    return next;
  }
  if (period === "M") {
    next.setMonth(next.getMonth() + units);
    return next;
  }
  if (period === "Q") {
    next.setMonth(next.getMonth() + units * 3);
    return next;
  }
  next.setFullYear(next.getFullYear() + units);
  return next;
};
const splitDateRangeByYearLimit = (start: Date, end: Date, period: string) => {
  const maxUnitsPerRequest =
    period === "D" ? 365 : period === "M" ? 12 : period === "Q" ? 4 : 1;
  const windows: Array<{ startDate: Date; endDate: Date }> = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    let windowEnd = addPeriodUnits(cursor, period, maxUnitsPerRequest - 1);
    if (windowEnd > end) {
      windowEnd = new Date(end);
    }
    windows.push({
      startDate: new Date(cursor),
      endDate: new Date(windowEnd),
    });
    cursor = addPeriodUnits(windowEnd, period, 1);
  }
  return windows;
};
const normalizeKrxEndpointUrl = (rawUrl: string) => {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed;
  }
};
const stripUrlSearch = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    url.search = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
};
const buildUrlFromSourceParams = (
  sourceItem: {
    baseUrl: string;
    apiKey?: string | null;
    apiKeyParamKey?: string | null;
    apiKeyLocation?: string | null;
    apiKeyOrder?: number | null;
    apiKeyEncodeMode?: string | null;
  },
  rawParams: Array<{
    key: string;
    value: string;
    location: "path" | "query";
    order: number;
    encodeMode?: string | null;
  }>,
) => {
  const url = new URL(sourceItem.baseUrl);
  const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
  const apiKeyKey = sourceItem.apiKeyParamKey?.trim() || "";
  const apiKeyLocation = sourceItem.apiKeyLocation || "query";
  const apiKeyOrder = Number.isFinite(sourceItem.apiKeyOrder)
    ? Number(sourceItem.apiKeyOrder)
    : 0;
  const apiKeyValue = sourceItem.apiKey ?? "";

  const pathParams = rawParams
    .filter((item) => item.location === "path" && item.value.trim())
    .map((item) => ({ ...item, encodeMode: item.encodeMode ?? "encode" }));
  const queryParams = rawParams
    .filter(
      (item) =>
        item.location === "query" &&
        item.key.trim() &&
        item.value.trim() &&
        (!apiKeyKey || item.key !== apiKeyKey),
    )
    .map((item) => ({ ...item, encodeMode: item.encodeMode ?? "encode" }));

  if (apiKeyValue && apiKeyKey) {
    if (apiKeyLocation === "path") {
      pathParams.push({
        key: apiKeyKey,
        value: apiKeyValue,
        location: "path",
        order: apiKeyOrder,
        encodeMode: sourceItem.apiKeyEncodeMode ?? "encode",
      });
    } else {
      queryParams.push({
        key: apiKeyKey,
        value: apiKeyValue,
        location: "query",
        order: apiKeyOrder,
        encodeMode: sourceItem.apiKeyEncodeMode ?? "encode",
      });
    }
  }

  const pathSegment = pathParams
    .sort((a, b) => a.order - b.order)
    .map((item) => normalizePathValue(item.value, item.encodeMode))
    .join("/");
  const queryPairs = queryParams
    .sort((a, b) => a.order - b.order)
    .map(
      (item) =>
        `${encodeURIComponent(item.key)}=${normalizeValue(
          item.value,
          item.encodeMode,
        )}`,
    )
    .join("&");
  const existingQuery = url.search.replace(/^\?/, "");
  const mergedQuery = [existingQuery, queryPairs].filter(Boolean).join("&");
  const fullPath = pathSegment ? `${base}/${pathSegment}` : base;
  return mergedQuery ? `${fullPath}?${mergedQuery}` : fullPath;
};
const normalizeApiPayload = (payload: unknown): unknown => {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    const xmlRows = parseXmlRows(trimmed);
    if (xmlRows) return xmlRows;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return parsed;
      } catch {
        return payload;
      }
    }
    return payload;
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.OutBlock_1)) return record.OutBlock_1;
    if (Array.isArray(record.OUTBLOCK_1)) return record.OUTBLOCK_1;
    if (Array.isArray(record.observations)) return record.observations;
    if (Array.isArray(record.observation)) return record.observation;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.rows)) return record.rows;
    if (Array.isArray(record.row)) return record.row;
    if (Array.isArray(record.items)) return record.items;
    if (record.data && typeof record.data === "object") {
      const nested = record.data as Record<string, unknown>;
      if (Array.isArray(nested.list)) return nested.list;
      if (Array.isArray(nested.rows)) return nested.rows;
      if (Array.isArray(nested.row)) return nested.row;
      if (Array.isArray(nested.items)) return nested.items;
    }
    const statisticSearch = record.StatisticSearch;
    if (statisticSearch && typeof statisticSearch === "object") {
      const nested = statisticSearch as Record<string, unknown>;
      if (Array.isArray(nested.row)) return nested.row;
      if (Array.isArray(nested.rows)) return nested.rows;
      if (Array.isArray(nested.items)) return nested.items;
      if (Array.isArray(nested.list)) return nested.list;
    }
    const kosisResult = record.result ?? record.Result;
    if (kosisResult && typeof kosisResult === "object") {
      const nested = kosisResult as Record<string, unknown>;
      if (Array.isArray(nested.list)) return nested.list;
      if (Array.isArray(nested.data)) return nested.data;
      if (Array.isArray(nested.rows)) return nested.rows;
      if (Array.isArray(nested.row)) return nested.row;
      if (Array.isArray(nested.items)) return nested.items;
    }
    const response = record.response;
    if (response && typeof response === "object") {
      const responseRecord = response as Record<string, unknown>;
      const body = responseRecord.body;
      if (body && typeof body === "object") {
        const bodyRecord = body as Record<string, unknown>;
        const items = bodyRecord.items;
        if (items && typeof items === "object") {
          const itemsRecord = items as Record<string, unknown>;
          if (Array.isArray(itemsRecord.item)) return itemsRecord.item;
          if (Array.isArray(itemsRecord.items)) return itemsRecord.items;
        }
      }
    }
    return record;
  }
  return payload;
};
const buildTabularFromApi = (payload: unknown) => {
  const normalized = normalizeApiPayload(payload);
  if (normalized == null) return { header: [] as string[], dataRows: [] as unknown[][] };
  const rows = Array.isArray(normalized) ? normalized : [normalized];
  if (rows.length === 0) return { header: [] as string[], dataRows: [] as unknown[][] };
  const first = rows[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    // NOTE:
    // Some KRX payloads omit null/empty fields on specific rows.
    // If we only use the first row keys, downstream column mapping loses fields and inserts NULL.
    // Build header from the union of all row keys to keep schema stable.
    const headerSet = new Set<string>();
    rows.forEach((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      Object.keys(row as Record<string, unknown>).forEach((key) => {
        if (!headerSet.has(key)) headerSet.add(key);
      });
    });
    const header = Array.from(headerSet);
    const dataRows = rows.map((row) =>
      header.map((key) => (row as Record<string, unknown>)[key] ?? null),
    );
    return { header, dataRows };
  }
  return {
    header: ["value"],
    dataRows: rows.map((row) => [row]),
  };
};
const parseApiBodyToRows = (body: unknown) => {
  let { header, dataRows } = buildTabularFromApi(body);
  if (
    typeof body === "string" &&
    header.length === 1 &&
    header[0] === "value"
  ) {
    const reparsedXmlRows = parseXmlRows(body);
    if (reparsedXmlRows?.length) {
      header = Object.keys(reparsedXmlRows[0] ?? {});
      dataRows = reparsedXmlRows.map((row) =>
        header.map((key) => row[key] ?? null),
      );
    }
  }
  return { header, dataRows };
};
// 구조화된 행을 못 만들고 원본 문자열을 그대로 1건으로 담은 fallback 인지 판별.
// (예: 공휴일 없는 달의 <items/> 응답 → 원본 XML 이 value 컬럼 한 칸에 들어옴)
const isRawValueFallback = (parsed: { header: string[] }) =>
  parsed.header.length === 1 && parsed.header[0] === "value";
// OECD(SDMX-JSON, format=jsondata&dimensionAtObservation=AllDimensions) 전용 파서.
// 다른 기관(평평한 JSON/XML 행)과 달리 OECD 응답은 차원 인덱스 튜플로 키가 매겨진
// observations 객체라 normalizeApiPayload 로는 풀 수 없어 별도 파싱한다.
// 출력 컬럼: [차원 id...] + OBS_VALUE + [속성 id...] (예: REF_AREA, TIME_PERIOD, OBS_VALUE, OBS_STATUS ...)
type SdmxDimOrAttr = { id?: string; values?: Array<{ id?: string; name?: string }> };
const parseSdmxJsonToRows = (
  body: unknown,
): { header: string[]; dataRows: unknown[][] } => {
  const empty = { header: [] as string[], dataRows: [] as unknown[][] };
  let root: unknown = body;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return empty;
    try {
      root = JSON.parse(trimmed);
    } catch {
      return empty;
    }
  }
  if (!root || typeof root !== "object") return empty;
  const data = (root as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return empty;
  const dataRecord = data as Record<string, unknown>;
  const structuresValue = dataRecord.structures;
  const structure = Array.isArray(structuresValue)
    ? (structuresValue[0] as Record<string, unknown> | undefined)
    : (dataRecord.structure as Record<string, unknown> | undefined);
  const dataSetsValue = dataRecord.dataSets;
  const dataSet = Array.isArray(dataSetsValue)
    ? (dataSetsValue[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!structure || !dataSet) return empty;
  const dimensions = (structure.dimensions as Record<string, unknown> | undefined)
    ?.observation;
  const attributes = (structure.attributes as Record<string, unknown> | undefined)
    ?.observation;
  const dims: SdmxDimOrAttr[] = Array.isArray(dimensions)
    ? (dimensions as SdmxDimOrAttr[])
    : [];
  const attrs: SdmxDimOrAttr[] = Array.isArray(attributes)
    ? (attributes as SdmxDimOrAttr[])
    : [];
  const observations = dataSet.observations;
  if (!dims.length || !observations || typeof observations !== "object") {
    return empty;
  }
  const header = [
    ...dims.map((dim, index) => dim.id ?? `DIM_${index}`),
    "OBS_VALUE",
    ...attrs.map((attr, index) => attr.id ?? `ATTR_${index}`),
  ];
  const resolveCode = (
    entry: SdmxDimOrAttr | undefined,
    index: number,
  ): string | null => {
    if (!entry || !Array.isArray(entry.values)) return null;
    if (!Number.isInteger(index) || index < 0) return null;
    const value = entry.values[index];
    if (!value) return null;
    return value.id ?? value.name ?? null;
  };
  const dataRows: unknown[][] = [];
  for (const [key, rawArr] of Object.entries(
    observations as Record<string, unknown>,
  )) {
    const arr = Array.isArray(rawArr) ? rawArr : [];
    const idxs = key.split(":").map((part) => Number(part));
    const row: unknown[] = [];
    dims.forEach((dim, position) => {
      row.push(resolveCode(dim, idxs[position] ?? -1));
    });
    row.push(arr[0] ?? null);
    attrs.forEach((attr, position) => {
      const valueIndex = arr[position + 1];
      row.push(
        typeof valueIndex === "number" ? resolveCode(attr, valueIndex) : null,
      );
    });
    dataRows.push(row);
  }
  return { header, dataRows };
};
// World Bank Open Data API 전용 파서.
// 응답은 [meta, dataArray] 형태이고 각 행이 중첩객체(indicator/country)를 가져
// 평평한 행으로 풀어야 컬럼 매핑이 된다.
// 출력 컬럼: DATE, VALUE, COUNTRY, COUNTRY_ISO3, INDICATOR, INDICATOR_NAME
const parseWorldBankRows = (
  body: unknown,
): { header: string[]; dataRows: unknown[][]; pages: number } => {
  const header = ["DATE", "VALUE", "COUNTRY", "COUNTRY_ISO3", "INDICATOR", "INDICATOR_NAME"];
  const empty = { header, dataRows: [] as unknown[][], pages: 1 };
  let root: unknown = body;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return empty;
    try {
      root = JSON.parse(trimmed);
    } catch {
      return empty;
    }
  }
  if (!Array.isArray(root) || root.length < 2) return empty;
  const meta = root[0] as Record<string, unknown> | undefined;
  const dataArray = Array.isArray(root[1]) ? (root[1] as unknown[]) : [];
  const pages = Number(meta?.pages);
  const getField = (row: unknown, key: string) =>
    row && typeof row === "object" ? (row as Record<string, unknown>)[key] : null;
  const getNested = (row: unknown, key: string, sub: string) => {
    const obj = getField(row, key);
    return obj && typeof obj === "object" ? ((obj as Record<string, unknown>)[sub] ?? null) : null;
  };
  const dataRows = dataArray.map((row) => [
    getField(row, "date") ?? null,
    getField(row, "value") ?? null,
    getNested(row, "country", "value") ?? null,
    getField(row, "countryiso3code") ?? null,
    getNested(row, "indicator", "id") ?? null,
    getNested(row, "indicator", "value") ?? null,
  ]);
  return { header, dataRows, pages: Number.isFinite(pages) && pages > 0 ? pages : 1 };
};
// UN Population Division /data 응답의 nextPage(다음 페이지 절대 URL)를 추출한다.
// http:// 로 내려오는 경우가 있어 https 로 정규화한다.
const extractUndpNextPage = (body: unknown): string | null => {
  let root: unknown = body;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return null;
    try {
      root = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!root || typeof root !== "object") return null;
  const next = (root as Record<string, unknown>).nextPage;
  if (typeof next !== "string") return null;
  const trimmed = next.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^http:\/\//i, "https://");
};
const fetchApiBodyWithRetry = async (
  url: string,
  abortSignal?: AbortSignal | null,
  init?: RequestInit,
) => {
  throwIfLoadAborted(abortSignal);
  let body: unknown = null;
  let response: Response | null = null;
  let lastFetchError: unknown = null;
  for (let attempt = 1; attempt <= API_FETCH_MAX_ATTEMPTS; attempt += 1) {
    throwIfLoadAborted(abortSignal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    const abortTimer = setTimeout(() => {
      controller.abort();
    }, API_FETCH_TIMEOUT_MS);
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      const contentType = response.headers.get("content-type") ?? "";
      body = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
      if (response.ok) {
        lastFetchError = null;
        break;
      }
      const message =
        typeof body === "string"
          ? body
          : ((body as { error?: string }).error ?? `API 응답 오류(${response.status})`);
      if (isRetryableStatus(response.status) && attempt < API_FETCH_MAX_ATTEMPTS) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const defaultBackoffMs =
          response.status === 429 ? 1200 * attempt : 400 * attempt;
        const waitMs = retryAfterMs ? Math.max(retryAfterMs, defaultBackoffMs) : defaultBackoffMs;
        lastFetchError = new Error(
          `API 응답 재시도(${attempt}/${API_FETCH_MAX_ATTEMPTS}): ${message}`,
        );
        await sleep(waitMs);
        continue;
      }
      throw new Error(message);
    } catch (error) {
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
      const isNetworkFetchError =
        error instanceof Error &&
        (error.name === "TypeError" ||
          error.message.toLowerCase().includes("fetch failed") ||
          error.message.toLowerCase().includes("network"));
      if (isAbortError) {
        if (abortSignal?.aborted) {
          throw makeLoadAbortError();
        }
        lastFetchError = new Error(
          `API 호출 시간 초과(${API_FETCH_TIMEOUT_MS}ms) 시도 ${attempt}/${API_FETCH_MAX_ATTEMPTS}`,
        );
      } else {
        lastFetchError = error;
      }
      if (!(isAbortError || isNetworkFetchError)) {
        throw error;
      }
      if (attempt < API_FETCH_MAX_ATTEMPTS) {
        await sleep(400 * attempt);
        continue;
      }
    } finally {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      clearTimeout(abortTimer);
    }
  }
  if (!response || lastFetchError) {
    throw new Error(`API 호출 실패: ${formatErrorWithCause(lastFetchError)}`);
  }
  return { response, body };
};

export const executeApiGroupLoad = async (payload: {
  sourceId: number;
  groupId: number;
  truncate?: boolean;
  triggerType?: "manual" | "schedule";
  dbSettingId?: number;
},
options?: {
  abortSignal?: AbortSignal | null;
  onDbBackendPid?: (pid: number) => void;
}) => {
  throwIfLoadAborted(options?.abortSignal);
  const resolvedDb = await resolveDbConfig({ settingId: payload.dbSettingId ?? null });
  if (!resolvedDb) {
    throw new Error("DB 연결 설정을 찾을 수 없습니다.");
  }
  const connectionString = buildConnectionString(resolvedDb);
  if (!connectionString) {
    throw new Error("DB 접속 URL 형식이 올바르지 않습니다.");
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;
  let inTransaction = false;
  let loadLogId: number | null = null;
  const startedAtMs = Date.now();
  const triggerType = payload.triggerType === "schedule" ? "schedule" : "manual";
  let errorStage: "setup" | "api_fetch" | "table_load" | "merge_sql" | "unknown" = "setup";
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    throwIfLoadAborted(options?.abortSignal);
    try {
      const pidResult = await client.query<{ pid: number }>("select pg_backend_pid()::int as pid");
      const pid = Number(pidResult.rows[0]?.pid ?? 0);
      if (Number.isFinite(pid) && pid > 0) {
        options?.onDbBackendPid?.(pid);
      }
    } catch {
      // ignore backend pid lookup errors
    }

    const rows = await client.query(
      `
        select
          s.base_url,
          s.provider,
          s.api_key,
          s.api_key_param_key,
          s.api_key_location,
          s.api_key_order,
          s.api_key_encode_mode,
          g.target_schema,
          g.target_table,
          g.target_truncate,
          g.target_merge_sql,
          p.param_key,
          p.param_value,
          p.param_location,
          p.param_order,
          p.encode_mode,
          p.param_role
        from dp.api_param_group g
        join dp.api_source s on s.id = g.source_id
        join dp.api_param p on p.group_id = g.id
        where g.id = $1
          and g.source_id = $2
          and g.is_template = false
        order by p.param_order asc, p.id asc
      `,
      [payload.groupId, payload.sourceId],
    );
    if (!rows.rowCount) {
      throw new Error("API 파라미터가 존재하지 않습니다.");
    }
    const first = rows.rows[0];
    const targetSchema = (first.target_schema as string | null) ?? "public";
    const targetTable = (first.target_table as string | null) ?? "";
    const targetMergeSql = ((first.target_merge_sql as string | null) ?? "").trim();
    if (!targetTable.trim()) {
      throw new Error("적재 테이블 매핑이 필요합니다.");
    }
    const resolvedParamRows = rows.rows.map((row) => ({
      key: String(row.param_key ?? ""),
      value: String(row.param_value ?? ""),
      location: ((row.param_location as "path" | "query") ?? "query"),
      order: Number.isFinite(row.param_order) ? Number(row.param_order) : 0,
      encodeMode: (row.encode_mode as string | null) ?? "encode",
      role: (row.param_role as string | null) ?? null,
    }));
    const roleKeyMap = new Map<string, string>();
    resolvedParamRows.forEach((param) => {
      if (!param.role || roleKeyMap.has(param.role)) return;
      roleKeyMap.set(param.role, param.key);
    });
    const paramValueByKey = new Map<string, string>(
      resolvedParamRows.map((param) => [param.key, param.value]),
    );
    const paramValueByKeyLower = new Map<string, string>(
      resolvedParamRows.map((param) => [param.key.trim().toLowerCase(), param.value]),
    );
    const periodTypeKey =
      roleKeyMap.get("period_type") ??
      (["period", "prdse", "periodtype", "frequency", "freq"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const endKey =
      roleKeyMap.get("end") ??
      (["apiend", "endprdde", "endyymm", "observation_end", "endperiod", "basdd"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const startKey =
      roleKeyMap.get("start") ??
      (["apistart", "startprdde", "strtyymm", "observation_start", "startperiod"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const periodTypeKeyLower = periodTypeKey?.trim().toLowerCase() ?? null;
    const startKeyLower = startKey?.trim().toLowerCase() ?? null;
    const endKeyLower = endKey?.trim().toLowerCase() ?? null;
    const periodTypeValueRaw = periodTypeKeyLower
      ? paramValueByKeyLower.get(periodTypeKeyLower) ?? "M"
      : "M";
    const periodTypeValue = periodTypeValueRaw.trim().toUpperCase();
    const effectivePeriod =
      periodTypeValue && ["D", "M", "Q", "A", "Y"].includes(periodTypeValue)
        ? periodTypeValue
        : "M";
    const requestParams = resolvedParamRows.map((param) => {
      const paramKey = param.key.trim().toLowerCase();
      const isEndParamByKey = [
        "apiend",
        "endprdde",
        "endyymm",
        "observation_end",
        "endperiod",
        "basdd",
      ].includes(paramKey);
      const isStartParamByKey = [
        "apistart",
        "startprdde",
        "strtyymm",
        "observation_start",
        "startperiod",
      ].includes(paramKey);
      const shouldResolveLatest =
        param.value === END_LATEST_TOKEN &&
        (paramKey === "basdd" ||
          (endKeyLower && paramKey === endKeyLower) ||
          (!endKeyLower && isEndParamByKey));
      if (shouldResolveLatest) {
        return {
          ...param,
          value: toParamDateValue(new Date(), effectivePeriod, param.key),
        };
      }
      const shouldResolveStartRelative =
        (startKeyLower && paramKey === startKeyLower) || (!startKeyLower && isStartParamByKey);
      const shouldResolveEndRelative =
        (endKeyLower && paramKey === endKeyLower) || (!endKeyLower && isEndParamByKey);
      if (shouldResolveStartRelative) {
        const startValue = resolveRelativeStartValue(param.value, effectivePeriod, param.key);
        if (startValue) {
          return { ...param, value: startValue };
        }
      }
      if (shouldResolveEndRelative) {
        const endValue = resolveRelativeStartValue(param.value, effectivePeriod, param.key);
        if (endValue) {
          return { ...param, value: endValue };
        }
      }
      return param;
    });
    const sourceProvider = String(first.provider ?? "").trim().toLowerCase();
    const requestParamsForFetch =
      sourceProvider === "kosis"
        ? requestParams.filter((param) => {
            const key = param.key.trim().toLowerCase();
            return key !== "vwcd" && key !== "statid" && key !== "sendde";
          })
        : requestParams;
    const url = buildUrlFromSourceParams(
      {
        baseUrl:
          sourceProvider === "undp"
            ? UNDP_DATA_BASE_URL
            : String(first.base_url ?? ""),
        apiKey: (first.api_key as string | null) ?? "",
        apiKeyParamKey: (first.api_key_param_key as string | null) ?? "",
        apiKeyLocation: (first.api_key_location as string | null) ?? "query",
        apiKeyOrder: Number.isFinite(first.api_key_order)
          ? Number(first.api_key_order)
          : 0,
        apiKeyEncodeMode: (first.api_key_encode_mode as string | null) ?? "encode",
      },
      requestParamsForFetch,
    );
    try {
      const logInsert = await client.query<{ load_log_id: number }>(
        `
          insert into dp.api_load_log (
            source_id,
            group_id,
            trigger_type,
            status,
            started_at,
            request_url,
            target_table,
            merge_configured
          )
          values ($1, $2, $3, 'running', now(), $4, $5, $6)
          returning load_log_id
        `,
        [
          payload.sourceId,
          payload.groupId,
          triggerType,
          url,
          `${targetSchema}.${targetTable}`,
          Boolean(targetMergeSql),
        ],
      );
      loadLogId = Number(logInsert.rows[0]?.load_log_id ?? 0) || null;
    } catch {
      // ignore log insert errors to not block ingestion
    }
    throwIfLoadAborted(options?.abortSignal);

    errorStage = "api_fetch";
    const sourceInfo = {
      baseUrl:
        sourceProvider === "krx"
          ? normalizeKrxEndpointUrl(String(first.base_url ?? ""))
          : sourceProvider === "undp"
            ? UNDP_DATA_BASE_URL
            : String(first.base_url ?? ""),
      apiKey: (first.api_key as string | null) ?? "",
      apiKeyParamKey: (first.api_key_param_key as string | null) ?? "",
      apiKeyLocation: (first.api_key_location as string | null) ?? "query",
      apiKeyOrder: Number.isFinite(first.api_key_order)
        ? Number(first.api_key_order)
        : 0,
      apiKeyEncodeMode: (first.api_key_encode_mode as string | null) ?? "encode",
    };
    // 특일정보(SpcdeInfoService): 경로(서비스명)에 SpcdeInfoService 가 포함되면 월별 반복 조회로 처리한다.
    const isDatagokrSpcde =
      sourceProvider === "datagokr" &&
      (requestParams.some(
        (param) => param.location === "path" && /spcdeinfoservice/i.test(param.value),
      ) ||
        /spcdeinfoservice/i.test(sourceInfo.baseUrl));
    const startParam = requestParams.find((param) => param.key === "start");
    const endParam = requestParams.find((param) => param.key === "end");
    const initialStart = Number(startParam?.value ?? "");
    const initialEnd = Number(endParam?.value ?? "");
    const configuredPageSize = initialEnd - initialStart + 1;
    const pageSize = Math.max(
      1,
      Number.isFinite(configuredPageSize) && configuredPageSize > 0
        ? configuredPageSize
        : BOK_PAGE_MAX_ROWS,
    );
    const shouldPaginateBok =
      sourceProvider === "bok" &&
      Boolean(startParam) &&
      Boolean(endParam) &&
      Number.isFinite(initialStart) &&
      Number.isFinite(initialEnd) &&
      initialStart > 0 &&
      initialEnd >= initialStart;

    let header: string[] = [];
    let dataRows: unknown[][] = [];
    if (sourceProvider === "yfinance") {
      // yfinance 는 HTTP API 가 아니라 python-forecast-api(/yfinance) 실행으로 수집한다.
      // apiStart/apiEnd(상대일 토큰 포함)는 위에서 이미 resolveRelativeStartValue/
      // toParamDateValue 로 해석돼 requestParams 에 들어있다. 대소문자 무시로 값을 찾는다.
      const valueByLower = new Map(
        requestParams.map((param) => [param.key.trim().toLowerCase(), param.value]),
      );
      const lookup = (key: string | null) =>
        !key ? "" : valueByLower.get(key.trim().toLowerCase()) ?? "";
      const ticker = (lookup("ticker") || "").trim();
      const interval = (lookup("interval") || "1d").trim() || "1d";
      const startDateObj = parseDateText(lookup(startKey));
      const endDateObj = parseDateText(lookup(endKey));
      if (!ticker) throw new Error("yfinance 티커(ticker)가 지정되지 않았습니다.");
      if (!startDateObj || !endDateObj) {
        throw new Error("yfinance 수집 시작일/종료일을 해석하지 못했습니다.");
      }
      // 파이썬 엔드포인트는 ISO(YYYY-MM-DD)를 기대한다. 시작>종료면 서로 바꾼다.
      const toIso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`;
      const startIso = toIso(startDateObj <= endDateObj ? startDateObj : endDateObj);
      const endIso = toIso(startDateObj <= endDateObj ? endDateObj : startDateObj);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PY_YFINANCE_TIMEOUT_MS);
      let responseBody = "";
      try {
        const response = await fetch(PY_YFINANCE_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker, start: startIso, end: endIso, interval }),
          signal: controller.signal,
        });
        responseBody = await response.text();
        if (!response.ok) {
          let detail = responseBody;
          try {
            const parsedErr = JSON.parse(responseBody) as { detail?: unknown };
            detail =
              typeof parsedErr.detail === "string"
                ? parsedErr.detail
                : JSON.stringify(parsedErr.detail ?? parsedErr);
          } catch {
            // keep raw body
          }
          throw new Error(`yfinance 조회 실패: ${detail}`);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "AbortError" || /aborted|timeout/i.test(error.message))
        ) {
          throw new Error(
            `yfinance 응답 시간 초과(${Math.round(
              PY_YFINANCE_TIMEOUT_MS / 1000,
            )}초). python-forecast-api(8001) 기동을 확인하세요.`,
          );
        }
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeoutId);
      }

      let parsed: {
        rows?: Array<{
          date?: string;
          open?: number | null;
          high?: number | null;
          low?: number | null;
          close?: number | null;
          adj_close?: number | null;
          volume?: number | null;
          ticker?: string;
        }>;
      };
      try {
        parsed = JSON.parse(responseBody) as typeof parsed;
      } catch {
        throw new Error("yfinance 응답 형식이 올바르지 않습니다.");
      }
      const rows = parsed.rows ?? [];
      // OHLCV 전체 + 수정종가를 컬럼으로 내려, 매핑 단계에서 필요한 값을 시리즈로 만들 수 있게 한다.
      header = ["DATE", "OPEN", "HIGH", "LOW", "CLOSE", "ADJ_CLOSE", "VOLUME", "TICKER"];
      dataRows = rows.map((row) => [
        row.date ?? null,
        row.open ?? null,
        row.high ?? null,
        row.low ?? null,
        row.close ?? null,
        row.adj_close ?? null,
        row.volume ?? null,
        row.ticker ?? ticker,
      ]);
      if (!dataRows.length) throw new Error("적재할 데이터가 없습니다.");
    } else if (sourceProvider === "krx") {
      const krxParamValueMapRaw = new Map(requestParams.map((param) => [param.key, param.value]));
      // param_role 이 없으면 startKey/endKey 가 소문자 후보키(apistart/apiend)로 잡히는데,
      // 값 맵은 원본 대소문자 키(apiStart/apiEnd)라 대소문자 무시 조회로 값을 찾는다.
      // (역할 미지정으로 등록된 기존 KRX API도 기간 순회가 동작하도록)
      const krxParamValueMapByLower = new Map(
        requestParams.map((param) => [param.key.trim().toLowerCase(), param.value]),
      );
      const lookupKrxValue = (key: string | null) =>
        !key
          ? ""
          : krxParamValueMapRaw.get(key) ??
            krxParamValueMapByLower.get(key.trim().toLowerCase()) ??
            "";
      const resolvedStartText = lookupKrxValue(startKey);
      const resolvedEndText = lookupKrxValue(endKey);
      const basDdKey =
        requestParams.find((param) => param.key.toLowerCase() === "basdd")?.key ?? "basDd";
      const startDate = parseDateText(resolvedStartText);
      const endDate = parseDateText(resolvedEndText);
      const singleDate = parseDateText(krxParamValueMapRaw.get(basDdKey) ?? "");
      const runDates: string[] = [];
      if (startDate && endDate && startDate <= endDate) {
        const cursor = new Date(startDate);
        let guard = 0;
        while (cursor <= endDate) {
          runDates.push(formatAsYmdCompact(cursor));
          cursor.setDate(cursor.getDate() + 1);
          guard += 1;
          if (guard > KRX_GOLD_MAX_DAYS) {
            throw new Error(
              `KRX 조회 기간 제한(${KRX_GOLD_MAX_DAYS}일)을 초과했습니다. INGESTION_KRX_GOLD_MAX_DAYS 값을 늘려주세요.`,
            );
          }
        }
      } else if (singleDate) {
        runDates.push(formatAsYmdCompact(singleDate));
      } else if (endDate) {
        runDates.push(formatAsYmdCompact(endDate));
      } else {
        runDates.push(formatAsYmdCompact(new Date()));
      }
      const krxEndpointUrl = stripUrlSearch(sourceInfo.baseUrl);
      let parsedKrxUrl: URL;
      try {
        parsedKrxUrl = new URL(krxEndpointUrl);
      } catch {
        throw new Error(`KRX base_url 형식이 올바르지 않습니다: ${krxEndpointUrl}`);
      }
      const krxPath = parsedKrxUrl.pathname.replace(/\/+$/, "");
      const krxParamValueMapLower = new Map(
        requestParams.map((param) => [param.key.trim().toLowerCase(), param.value.trim()]),
      );
      const pathInBaseUrl =
        krxPath.includes("/svc/apis/") && krxPath.split("/").length >= 5;
      const apiPathParam =
        krxParamValueMapLower.get("apipath") ??
        krxParamValueMapLower.get("api_path") ??
        krxParamValueMapLower.get("krxapipath") ??
        "";
      const apiIdParam =
        krxParamValueMapLower.get("apiid") ??
        krxParamValueMapLower.get("api_id") ??
        krxParamValueMapLower.get("krxapiid") ??
        "";
      const normalizedApiPath = apiPathParam.replace(/^\/+|\/+$/g, "");
      const normalizedApiId = apiIdParam.replace(/^\/+|\/+$/g, "");
      const effectiveKrxEndpoint = pathInBaseUrl
        ? `${parsedKrxUrl.origin}${krxPath}`
        : normalizedApiPath && normalizedApiId
          ? `${parsedKrxUrl.origin}/svc/apis/${normalizedApiPath}/${normalizedApiId}`
          : "";
      if (!effectiveKrxEndpoint) {
        throw new Error(
          "KRX 엔드포인트를 구성하지 못했습니다. base_url은 도메인만 사용 가능하며, 그룹 파라미터에 apiPath/apiId(path)가 필요합니다.",
        );
      }
      for (const basDd of runDates) {
        throwIfLoadAborted(options?.abortSignal);
        const bodyPayload: Record<string, string> = {
          [basDdKey]: basDd,
        };
        const authKey = (sourceInfo.apiKey ?? "").trim();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (authKey) {
          headers.AUTH_KEY = authKey;
        }
        const { body } = await fetchApiBodyWithRetry(
          effectiveKrxEndpoint,
          options?.abortSignal,
          {
            method: "POST",
            headers,
            body: JSON.stringify(bodyPayload),
          },
        );
        const parsed = parseApiBodyToRows(body);
        if (!parsed.header.length || !parsed.dataRows.length) {
          if (KRX_GOLD_REQUEST_DELAY_MS > 0) {
            await sleep(KRX_GOLD_REQUEST_DELAY_MS);
          }
          continue;
        }
        if (!header.length) {
          header = parsed.header;
        }
        dataRows.push(...parsed.dataRows);
        if (KRX_GOLD_REQUEST_DELAY_MS > 0) {
          await sleep(KRX_GOLD_REQUEST_DELAY_MS);
        }
      }
      if (!dataRows.length) {
        throw new Error("적재할 데이터가 없습니다.");
      }
    } else if (isDatagokrSpcde && startKeyLower && endKeyLower) {
      // 특일정보: 기간(strtYymm~endYymm)을 월 단위로 쪼개 solYear/solMonth 로 매월 조회 후 누적.
      const valueByKey = new Map(
        requestParams.map((param) => [param.key.trim().toLowerCase(), param.value]),
      );
      const startValue = valueByKey.get(startKeyLower) ?? "";
      const endValue = valueByKey.get(endKeyLower) ?? "";
      const parsedStart = parsePeriodDate(startValue, "M");
      const parsedEnd = parsePeriodDate(endValue, "M");
      if (!parsedStart || !parsedEnd) {
        const { body } = await fetchApiBodyWithRetry(url, options?.abortSignal);
        const parsed = parseApiBodyToRows(body);
        header = parsed.header;
        dataRows = parsed.dataRows;
      } else {
        const rangeStart = parsedStart <= parsedEnd ? parsedStart : parsedEnd;
        const rangeEnd = parsedStart <= parsedEnd ? parsedEnd : parsedStart;
        // 기간/주기 파라미터(strtYymm·endYymm·periodType)와 기존 solYear/solMonth 는 제외하고,
        // 매월 solYear/solMonth 를 새로 채워 요청한다.
        const baseParams = requestParams.filter((param) => {
          const key = param.key.trim().toLowerCase();
          if (key === startKeyLower || key === endKeyLower) return false;
          if (periodTypeKeyLower && key === periodTypeKeyLower) return false;
          if (key === "solyear" || key === "solmonth") return false;
          return true;
        });
        const hasNumOfRows = baseParams.some(
          (param) => param.key.trim().toLowerCase() === "numofrows",
        );
        const cursor = new Date(rangeStart);
        let guard = 0;
        while (cursor <= rangeEnd) {
          throwIfLoadAborted(options?.abortSignal);
          const solYear = String(cursor.getFullYear());
          const solMonth = String(cursor.getMonth() + 1).padStart(2, "0");
          const monthParams = [
            ...baseParams,
            {
              key: "solYear",
              value: solYear,
              location: "query" as const,
              order: 50,
              encodeMode: "encode",
              role: null,
            },
            {
              key: "solMonth",
              value: solMonth,
              location: "query" as const,
              order: 51,
              encodeMode: "encode",
              role: null,
            },
          ];
          if (!hasNumOfRows) {
            monthParams.push({
              key: "numOfRows",
              value: SPCDE_DEFAULT_NUM_OF_ROWS,
              location: "query" as const,
              order: 52,
              encodeMode: "encode",
              role: null,
            });
          }
          const monthUrl = buildUrlFromSourceParams(sourceInfo, monthParams);
          const { body } = await fetchApiBodyWithRetry(monthUrl, options?.abortSignal);
          const parsed = parseApiBodyToRows(body);
          // 공휴일 없는 달(<items/>, totalCount=0)은 원본 XML 이 그대로 담긴 fallback 이므로 건너뛴다.
          if (parsed.header.length && parsed.dataRows.length && !isRawValueFallback(parsed)) {
            if (!header.length) {
              header = parsed.header;
            }
            dataRows.push(...parsed.dataRows);
          }
          cursor.setMonth(cursor.getMonth() + 1);
          guard += 1;
          if (guard > SPCDE_MAX_MONTHS) {
            throw new Error(
              `특일정보 조회 기간 제한(${SPCDE_MAX_MONTHS}개월)을 초과했습니다. INGESTION_SPCDE_MAX_MONTHS 값을 늘려주세요.`,
            );
          }
        }
        if (!dataRows.length) {
          throw new Error("적재할 데이터가 없습니다.");
        }
      }
    } else if (sourceProvider === "datagokr" && startKeyLower && endKeyLower) {
      const valueByKey = new Map(
        requestParams.map((param) => [param.key.trim().toLowerCase(), param.value]),
      );
      const startValue = valueByKey.get(startKeyLower) ?? "";
      const endValue = valueByKey.get(endKeyLower) ?? "";
      const parsedStart = parsePeriodDate(startValue, effectivePeriod);
      const parsedEnd = parsePeriodDate(endValue, effectivePeriod);
      if (!parsedStart || !parsedEnd) {
        const { body } = await fetchApiBodyWithRetry(url, options?.abortSignal);
        const parsed = parseApiBodyToRows(body);
        header = parsed.header;
        dataRows = parsed.dataRows;
      } else {
        const rangeStart = parsedStart <= parsedEnd ? parsedStart : parsedEnd;
        const rangeEnd = parsedStart <= parsedEnd ? parsedEnd : parsedStart;
        const windows = splitDateRangeByYearLimit(rangeStart, rangeEnd, effectivePeriod);
        for (const window of windows) {
          throwIfLoadAborted(options?.abortSignal);
          const windowStart = toPeriodValue(window.startDate, effectivePeriod);
          const windowEnd = toPeriodValue(window.endDate, effectivePeriod);
          const windowParams = requestParams.map((param) => {
            const paramKey = param.key.trim().toLowerCase();
            if (paramKey === startKeyLower) return { ...param, value: windowStart };
            if (paramKey === endKeyLower) return { ...param, value: windowEnd };
            return param;
          });
          const windowUrl = buildUrlFromSourceParams(sourceInfo, windowParams);
          const { body } = await fetchApiBodyWithRetry(windowUrl, options?.abortSignal);
          const parsed = parseApiBodyToRows(body);
          if (!parsed.header.length || !parsed.dataRows.length || isRawValueFallback(parsed)) {
            continue;
          }
          if (!header.length) {
            header = parsed.header;
          }
          dataRows.push(...parsed.dataRows);
        }
      }
    } else if (sourceProvider === "oecd") {
      // OECD(SDMX-JSON): 단일 호출 후 차원/관측치 구조를 평평한 행으로 변환한다.
      // Accept-Language 헤더가 없으면 OECD 서버가 500(languageTag) 을 반환하므로 반드시 지정한다.
      const { body } = await fetchApiBodyWithRetry(url, options?.abortSignal, {
        headers: { "Accept-Language": "en" },
      });
      const parsed = parseSdmxJsonToRows(body);
      header = parsed.header;
      dataRows = parsed.dataRows;
      if (!header.length || !dataRows.length) {
        throw new Error("적재할 데이터가 없습니다.");
      }
    } else if (sourceProvider === "undp") {
      // UN Population Division Data Portal: /data 엔드포인트는 Authorization: Bearer 토큰이 필수다.
      // (지표/지역 목록은 공개지만 데이터 조회는 인증 필요) 응답은 { data:[...], nextPage } 형태로
      // 100건씩 페이지네이션되므로 nextPage 를 따라가며 전량 누적한다.
      // 등록된 토큰에 "Bearer " 접두어가 포함돼 있어도 중복되지 않도록 제거한다.
      const undpToken = (sourceInfo.apiKey ?? "").trim().replace(/^Bearer\s+/i, "");
      if (!undpToken) {
        throw new Error(
          "UN Population Division 토큰이 필요합니다. 기관 관리에서 API Key(토큰)를 등록하세요.",
        );
      }
      const undpHeaders: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${undpToken}`,
      };
      let nextUrl: string | null = url;
      let guard = 0;
      while (nextUrl) {
        throwIfLoadAborted(options?.abortSignal);
        const { body } = await fetchApiBodyWithRetry(nextUrl, options?.abortSignal, {
          headers: undpHeaders,
        });
        const parsed = parseApiBodyToRows(body);
        if (parsed.header.length && parsed.dataRows.length && !isRawValueFallback(parsed)) {
          if (!header.length) {
            header = parsed.header;
          }
          dataRows.push(...parsed.dataRows);
        }
        nextUrl = extractUndpNextPage(body);
        guard += 1;
        if (guard > UNDP_MAX_PAGES) {
          throw new Error(
            `UN 데이터 페이지 제한(${UNDP_MAX_PAGES}페이지)을 초과했습니다. INGESTION_UNDP_MAX_PAGES 값을 늘려주세요.`,
          );
        }
      }
      if (!dataRows.length) {
        throw new Error("적재할 데이터가 없습니다.");
      }
    } else if (sourceProvider === "worldbank") {
      // World Bank: url(country/{code}/indicator/{code}?...&date=...)을 조회.
      // date 값에 상대일 토큰(__TODAY__, __TODAY_MINUS_{n}Y__)이 있으면 실행 시점 연도로 해석해
      // date=시작연:종료연 으로 치환한다. (스케줄러가 매번 최신 연도까지 수집하도록)
      const rawDate = requestParams.find((param) => param.key.trim().toLowerCase() === "date")?.value ?? "";
      const resolvedDate = resolveWorldBankDateRange(rawDate);
      let fetchUrl = url;
      if (resolvedDate) {
        fetchUrl = /([?&]date=)[^&]*/i.test(url)
          ? url.replace(/([?&]date=)[^&]*/i, `$1${resolvedDate}`)
          : `${url}${url.includes("?") ? "&" : "?"}date=${resolvedDate}`;
      }
      // 응답 [meta,[행]] 을 평탄화하고, meta.pages 만큼만 추가 페이지를 이어붙인다.
      const WORLDBANK_MAX_PAGES = 50;
      const first = await fetchApiBodyWithRetry(fetchUrl, options?.abortSignal);
      const firstParsed = parseWorldBankRows(first.body);
      header = firstParsed.header;
      // 값이 없는(미발표) 연도 행은 저장하지 않는다.
      dataRows.push(...firstParsed.dataRows.filter((row) => row[1] != null));
      const totalPages = Math.min(firstParsed.pages, WORLDBANK_MAX_PAGES);
      for (let page = 2; page <= totalPages; page += 1) {
        throwIfLoadAborted(options?.abortSignal);
        const sep = fetchUrl.includes("?") ? "&" : "?";
        const { body } = await fetchApiBodyWithRetry(`${fetchUrl}${sep}page=${page}`, options?.abortSignal);
        const parsed = parseWorldBankRows(body);
        dataRows.push(...parsed.dataRows.filter((row) => row[1] != null));
      }
      if (!dataRows.length) {
        throw new Error("적재할 데이터가 없습니다. (국가/지표/연도 범위를 확인하세요)");
      }
    } else if (!shouldPaginateBok) {
      const { body } = await fetchApiBodyWithRetry(url, options?.abortSignal);
      const parsed = parseApiBodyToRows(body);
      header = parsed.header;
      dataRows = parsed.dataRows;
    } else {
      let pageStart = initialStart;
      let pageEnd = initialEnd;
      let reachedPageLimit = true;
      for (let page = 1; page <= BOK_MAX_PAGES; page += 1) {
        throwIfLoadAborted(options?.abortSignal);
        const pageParams = requestParams.map((param) => {
          if (param.key === "start") return { ...param, value: String(pageStart) };
          if (param.key === "end") return { ...param, value: String(pageEnd) };
          return param;
        });
        const pageUrl = buildUrlFromSourceParams(sourceInfo, pageParams);
        const { body } = await fetchApiBodyWithRetry(pageUrl, options?.abortSignal);
        const parsed = parseApiBodyToRows(body);
        if (!parsed.header.length || !parsed.dataRows.length) {
          reachedPageLimit = false;
          break;
        }
        if (!header.length) {
          header = parsed.header;
        }
        dataRows.push(...parsed.dataRows);
        if (parsed.dataRows.length < pageSize) {
          reachedPageLimit = false;
          break;
        }
        pageStart += pageSize;
        pageEnd += pageSize;
      }
      if (reachedPageLimit) {
        throw new Error(
          `BOK 페이지 제한(${BOK_MAX_PAGES})에 도달했습니다. INGESTION_BOK_MAX_PAGES 값을 늘려주세요.`,
        );
      }
      if (!dataRows.length) {
        throw new Error("적재할 데이터가 없습니다.");
      }
    }
    if (!header.length || !dataRows.length) {
      throw new Error("적재할 데이터가 없습니다.");
    }

    const columnRows = await client.query(
      `
        select column_name, data_type
        from information_schema.columns
        where table_schema = $1
          and table_name = $2
        order by ordinal_position
      `,
      [targetSchema, targetTable],
    );
    const tableColumns = columnRows.rows.map((row) => row.column_name as string);
    const columnTypes = new Map(
      columnRows.rows.map((row) => [
        (row.column_name as string).toLowerCase(),
        (row.data_type as string) || "text",
      ]),
    );
    if (!tableColumns.length) {
      throw new Error("테이블 컬럼을 찾을 수 없습니다.");
    }

    const normalizeColumnKey = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const headerIndex = new Map<string, number>();
    header.forEach((name, index) => {
      const key = normalizeColumnKey(String(name));
      if (!key || headerIndex.has(key)) return;
      headerIndex.set(key, index);
    });
    const columnsToInsert = tableColumns.filter((column) =>
      headerIndex.has(normalizeColumnKey(column)),
    );
    if (!columnsToInsert.length) {
      throw new Error(
        `API 컬럼과 테이블 컬럼이 맞지 않습니다. API 헤더=[${header.join(
          ", ",
        )}] / 테이블 컬럼=[${tableColumns.join(", ")}]`,
      );
    }

    const insertRows = dataRows
      .map((row) =>
        columnsToInsert.map((column) => {
          const index = headerIndex.get(normalizeColumnKey(column));
          const rawValue = index == null ? null : (row[index] ?? null);
          const dt = columnTypes.get(column.toLowerCase()) ?? "text";
          return normalizeCellByType(rawValue, dt);
        }),
      )
      .filter((row) => row.some((value) => value !== null && value !== ""));
    if (!insertRows.length) {
      throw new Error("적재할 데이터가 없습니다.");
    }

    const escapedTable = `${escapeIdentifier(targetSchema)}.${escapeIdentifier(
      targetTable,
    )}`;
    const shouldTruncate =
      payload.truncate ?? Boolean(first.target_truncate);
    errorStage = "table_load";
    await client.query("begin");
    inTransaction = true;
    if (shouldTruncate) {
      await client.query(`truncate table ${escapedTable}`);
    }
    const escapedColumns = columnsToInsert.map(escapeIdentifier).join(", ");
    const aliasColumns = columnsToInsert.map(escapeIdentifier).join(", ");
    const selectExpressions = columnsToInsert
      .map((col) => {
        const escaped = escapeIdentifier(col);
        const dt = columnTypes.get(col.toLowerCase()) ?? "text";
        return castForColumn(dt, `v.${escaped}`);
      })
      .join(", ");
    const placeholderCasts = columnsToInsert.map((col) => {
      const dt = columnTypes.get(col.toLowerCase()) ?? "text";
      if (
        dt === "numeric" ||
        dt === "decimal" ||
        dt === "real" ||
        dt === "double precision"
      )
        return "::numeric";
      if (
        dt === "smallint" ||
        dt === "integer" ||
        dt === "bigint" ||
        dt === "serial" ||
        dt === "bigserial"
      )
        return "::bigint";
      return "";
    });
    let insertedCount = 0;
    const maxRowsPerBatch = Math.max(
      1,
      Math.floor(MAX_BIND_PARAMS_PER_QUERY / Math.max(columnsToInsert.length, 1)),
    );
    const dedupeCondition = columnsToInsert
      .map((column) => {
        const escaped = escapeIdentifier(column);
        return `(t.${escaped})::text is not distinct from (v.${escaped})::text`;
      })
      .join(" and ");

    for (let start = 0; start < insertRows.length; start += maxRowsPerBatch) {
      throwIfLoadAborted(options?.abortSignal);
      const batchRows = insertRows.slice(start, start + maxRowsPerBatch);
      const values: unknown[] = [];
      const placeholders = batchRows
        .map((row, rowIndex) => {
          const base = rowIndex * columnsToInsert.length;
          const rowPlaceholders = columnsToInsert.map((_, colIndex) => {
            values.push(row[colIndex] ?? null);
            const cast = placeholderCasts[colIndex] ?? "";
            return `$${base + colIndex + 1}${cast}`;
          });
          return `(${rowPlaceholders.join(", ")})`;
        })
        .join(", ");

      if (shouldTruncate) {
        const insertResult = await client.query(
          `insert into ${escapedTable} (${escapedColumns}) values ${placeholders}`,
          values,
        );
        insertedCount += insertResult.rowCount ?? 0;
      } else {
        const insertResult = await client.query(
          `
            insert into ${escapedTable} (${escapedColumns})
            select ${selectExpressions}
            from (values ${placeholders}) as v (${aliasColumns})
            where not exists (
              select 1
              from ${escapedTable} t
              where ${dedupeCondition}
            )
          `,
          values,
        );
        insertedCount += insertResult.rowCount ?? 0;
      }
    }
    if (targetMergeSql) {
      errorStage = "merge_sql";
      throwIfLoadAborted(options?.abortSignal);
      await client.query(targetMergeSql);
    }
    await client.query("commit");
    inTransaction = false;
    if (loadLogId) {
      try {
        await client.query(
          `
            update dp.api_load_log
            set
              status = 'success',
              finished_at = now(),
              elapsed_ms = $2,
              inserted_count = $3,
              error_message = null,
              error_stage = null
            where load_log_id = $1
          `,
          [loadLogId, Math.max(0, Date.now() - startedAtMs), insertedCount],
        );
      } catch {
        // ignore log update errors to not block ingestion
      }
    }

    return {
      loadLogId,
      inserted: insertedCount,
      url,
      table: `${targetSchema}.${targetTable}`,
      columns: columnsToInsert,
      mergeConfigured: Boolean(targetMergeSql),
    };
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("rollback");
      } catch {
        // ignore rollback errors
      }
    }
    if (loadLogId) {
      const message = isLoadAbortError(error) ? "적재가 취소되었습니다." : formatErrorWithCause(error);
      const stage =
        errorStage === "setup" ||
        errorStage === "api_fetch" ||
        errorStage === "table_load" ||
        errorStage === "merge_sql"
          ? errorStage
          : "unknown";
      try {
        await client.query(
          `
            update dp.api_load_log
            set
              status = 'error',
              finished_at = now(),
              elapsed_ms = $2,
              error_message = $3,
              error_stage = $4
            where load_log_id = $1
          `,
          [loadLogId, Math.max(0, Date.now() - startedAtMs), message, stage],
        );
      } catch {
        // ignore log update errors to not block ingestion
      }
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};
