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
const toParamDateValue = (date: Date, period: string, paramKey: string) => {
  if (shouldUseIsoDateParamFormat(paramKey)) {
    return toIsoDateValue(date);
  }
  if (shouldUseDailyCompactParamFormat(paramKey)) {
    return toPeriodValue(date, "D");
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
    .map((item) => normalizeValue(item.value, item.encodeMode))
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
      (["apiend", "endprdde", "endyymm", "observation_end", "basdd"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const startKey =
      roleKeyMap.get("start") ??
      (["apistart", "startprdde", "strtyymm", "observation_start"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const periodTypeValueRaw = periodTypeKey ? paramValueByKeyLower.get(periodTypeKey) ?? "M" : "M";
    const periodTypeValue = periodTypeValueRaw.trim().toUpperCase();
    const effectivePeriod =
      periodTypeValue && ["D", "M", "Q", "A", "Y"].includes(periodTypeValue)
        ? periodTypeValue
        : "M";
    const requestParams = resolvedParamRows.map((param) => {
      const paramKey = param.key.trim().toLowerCase();
      const isEndParamByKey = ["apiend", "endprdde", "endyymm", "observation_end", "basdd"].includes(
        paramKey,
      );
      const isStartParamByKey = ["apistart", "startprdde", "strtyymm", "observation_start"].includes(
        paramKey,
      );
      const shouldResolveLatest =
        param.value === END_LATEST_TOKEN &&
        (paramKey === "basdd" || (endKey && paramKey === endKey) || (!endKey && isEndParamByKey));
      if (shouldResolveLatest) {
        return {
          ...param,
          value: toParamDateValue(new Date(), effectivePeriod, param.key),
        };
      }
      const shouldResolveStartRelative =
        (startKey && paramKey === startKey) || (!startKey && isStartParamByKey);
      const shouldResolveEndRelative =
        (endKey && paramKey === endKey) || (!endKey && isEndParamByKey);
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
    const url = buildUrlFromSourceParams(
      {
        baseUrl: String(first.base_url ?? ""),
        apiKey: (first.api_key as string | null) ?? "",
        apiKeyParamKey: (first.api_key_param_key as string | null) ?? "",
        apiKeyLocation: (first.api_key_location as string | null) ?? "query",
        apiKeyOrder: Number.isFinite(first.api_key_order)
          ? Number(first.api_key_order)
          : 0,
        apiKeyEncodeMode: (first.api_key_encode_mode as string | null) ?? "encode",
      },
      requestParams,
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
    const sourceProvider = String(first.provider ?? "").trim().toLowerCase();
    const sourceInfo = {
      baseUrl:
        sourceProvider === "krx"
          ? normalizeKrxEndpointUrl(String(first.base_url ?? ""))
          : String(first.base_url ?? ""),
      apiKey: (first.api_key as string | null) ?? "",
      apiKeyParamKey: (first.api_key_param_key as string | null) ?? "",
      apiKeyLocation: (first.api_key_location as string | null) ?? "query",
      apiKeyOrder: Number.isFinite(first.api_key_order)
        ? Number(first.api_key_order)
        : 0,
      apiKeyEncodeMode: (first.api_key_encode_mode as string | null) ?? "encode",
    };
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
    if (sourceProvider === "krx") {
      const krxParamValueMapRaw = new Map(requestParams.map((param) => [param.key, param.value]));
      const resolvedStartText = startKey ? krxParamValueMapRaw.get(startKey) ?? "" : "";
      const resolvedEndText = endKey ? krxParamValueMapRaw.get(endKey) ?? "" : "";
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
    } else if (sourceProvider === "datagokr" && startKey && endKey) {
      const valueByKey = new Map(requestParams.map((param) => [param.key, param.value]));
      const startValue = valueByKey.get(startKey) ?? "";
      const endValue = valueByKey.get(endKey) ?? "";
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
            if (param.key === startKey) return { ...param, value: windowStart };
            if (param.key === endKey) return { ...param, value: windowEnd };
            return param;
          });
          const windowUrl = buildUrlFromSourceParams(sourceInfo, windowParams);
          const { body } = await fetchApiBodyWithRetry(windowUrl, options?.abortSignal);
          const parsed = parseApiBodyToRows(body);
          if (!parsed.header.length || !parsed.dataRows.length) {
            continue;
          }
          if (!header.length) {
            header = parsed.header;
          }
          dataRows.push(...parsed.dataRows);
        }
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
