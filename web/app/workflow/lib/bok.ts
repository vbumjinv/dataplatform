import type { BokCycle, BokNodeOptions } from "../types";

export const BOK_CYCLES: BokCycle[] = ["D", "M", "Q", "S", "A"];

export const BOK_CYCLE_LABELS: Record<BokCycle, string> = {
  D: "일",
  M: "월",
  Q: "분기",
  S: "반기",
  A: "년",
};

const BOK_LOAD_LIMIT = 100000;

const pad = (value: number) => String(value).padStart(2, "0");

const parseIsoDate = (value: string) => {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!matched) return null;
  return {
    year: Number(matched[1]),
    month: Number(matched[2]),
    day: Number(matched[3]),
  };
};

export const isBokCycle = (value: string): value is BokCycle =>
  BOK_CYCLES.includes(value as BokCycle);

export const primaryBokCycle = (value: string): BokCycle => {
  const tokens = value
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  return BOK_CYCLES.find((cycle) => tokens.includes(cycle)) ?? "M";
};

export const formatBokDate = (value: string, cycle: BokCycle) => {
  const trimmed = value.trim();
  const parsed = parseIsoDate(trimmed);
  if (!parsed) return trimmed;

  const year = String(parsed.year);
  const month = pad(parsed.month);
  const day = pad(parsed.day);
  if (cycle === "D") return `${year}${month}${day}`;
  if (cycle === "Q") return `${year}Q${Math.floor((parsed.month - 1) / 3) + 1}`;
  if (cycle === "S") return `${year}S${parsed.month <= 6 ? 1 : 2}`;
  if (cycle === "A") return year;
  return `${year}${month}`;
};

export const buildBokSearchUrl = (
  options: BokNodeOptions,
  start = 1,
  count = 10,
) => {
  const key = options.apiKey.trim();
  const code = options.statCode.trim();
  const startValue = formatBokDate(options.startDate, options.cycle);
  const endValue = formatBokDate(options.endDate, options.cycle);
  const startIndex = Math.max(1, start);
  const endIndex = Math.max(startIndex, count);
  if (!key || !code || !isBokCycle(options.cycle) || !startValue || !endValue) return "";

  return `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(
    key,
  )}/json/kr/${startIndex}/${endIndex}/${encodeURIComponent(code)}/${
    options.cycle
  }/${encodeURIComponent(startValue)}/${encodeURIComponent(endValue)}`;
};

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asRows = (value: unknown) => {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};

const readBokError = (payload: unknown) => {
  const record = asRecord(payload);
  const result = asRecord(record?.RESULT);
  const code = String(result?.CODE ?? "");
  const message = String(result?.MESSAGE ?? "");
  if (!code && !message) return "";
  return message || code;
};

const readBokSearchCount = (payload: unknown) => {
  const record = asRecord(payload);
  const search = asRecord(record?.StatisticSearch);
  const total = Number(search?.list_total_count ?? 0);
  return Number.isFinite(total) ? total : 0;
};

const parseBokRows = (payload: unknown) => {
  const record = asRecord(payload);
  const search = asRecord(record?.StatisticSearch);
  const rows = asRows(search?.row).filter(
    (row): row is Record<string, unknown> => Boolean(asRecord(row)),
  );
  if (rows.length === 0) {
    return {
      ok: false as const,
      error: readBokError(payload) || "조회된 데이터가 없습니다.",
    };
  }
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return {
    ok: true as const,
    columns,
    rows: rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, String(row[column] ?? "")])),
    ),
  };
};

export const fetchBokStatistic = async (
  options: BokNodeOptions,
  limit = BOK_LOAD_LIMIT,
  rejectOverLimit = true,
) => {
  const probeUrl = buildBokSearchUrl(options, 1, 1);
  if (!probeUrl) {
    return { ok: false as const, error: "API KEY, 통계코드, 주기, 시작일, 종료일을 입력해주세요." };
  }

  const probeResponse = await fetch(probeUrl, { cache: "no-store" });
  const probePayload = (await probeResponse.json()) as unknown;
  const total = readBokSearchCount(probePayload);
  if (!probeResponse.ok || total < 1) {
    const parsed = parseBokRows(probePayload);
    if (!parsed.ok) return parsed;
    return { ...parsed, total: parsed.rows.length };
  }
  if (rejectOverLimit && total > limit) {
    return {
      ok: false as const,
      error: `조회 건수가 ${total.toLocaleString("ko-KR")}건이라 한 번에 가져올 수 없습니다.`,
    };
  }

  const count = Math.min(Math.max(total, 1), limit);
  const url = buildBokSearchUrl(options, 1, count);
  const response = await fetch(url, { cache: "no-store" });
  const payload = (await response.json()) as unknown;
  const parsed = parseBokRows(payload);
  if (!parsed.ok) return parsed;
  return { ...parsed, total: Math.max(total, parsed.rows.length) };
};
