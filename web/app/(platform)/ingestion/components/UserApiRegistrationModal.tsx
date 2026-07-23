"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ApiParam = {
  id: number;
  param_key: string;
  param_value: string;
  param_location: string;
  param_order: number;
  encode_mode?: string | null;
  param_role?: string | null;
};

type ApiGroup = {
  id: number;
  name: string | null;
  is_template?: boolean;
  created_at: string;
  params: ApiParam[];
};

type ApiSource = {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  api_key: string | null;
  api_key_param_key?: string | null;
  api_key_location?: string | null;
  api_key_order?: number | null;
  api_key_encode_mode?: string | null;
  enabled: boolean;
  is_template?: boolean;
  created_at: string;
  groups: ApiGroup[];
};

type Props = {
  open: boolean;
  templates: ApiSource[];
  sources: ApiSource[];
  onClose: () => void;
  onCompleted: () => void;
};

type Step =
  | "org"
  | "target"
  | "kosisUserStats"
  | "datagokrSpec"
  | "krxApiApply"
  | "period"
  | "extra"
  | "name"
  | "confirm";

type ExtraParam = { key: string; value: string };

type BokStatItem = {
  p_stat_code: string;
  stat_code: string;
  stat_name: string;
  cycle: string;
  srch_yn: string;
  org_name: string;
};
type KosisStatItem = {
  node_id: number;
  p_stat_code: string;
  stat_code: string;
  tree_no?: string;
  stat_name_no?: string;
  stat_name: string;
  cycle?: string;
  srch_yn: string;
  org_name?: string;
  vw_cd: string;
  stat_id?: string;
  send_de?: string;
  full_path?: string;
};
type DatagokrStatItem = {
  p_stat_code: string;
  stat_code: string;
  stat_name: string;
  srch_yn: string;
  org_cd: string;
  org_name: string;
  list_url?: string;
};
type FredStatItem = {
  node_id: string;
  parent_node_id: string | null;
  node_name: string;
  node_type: string;
  category_id?: number | null;
  stat_code?: string | null;
  cycle?: string | null;
  srch_yn?: string | null;
  lvl?: number | null;
  leaf_yn?: string | null;
  sort_ord?: number | null;
  org_name?: string | null;
};
type KrxApiItem = {
  p_api_id: string;
  api_id: string;
  api_name: string;
  api_path: string;
  category_name: string;
  cycle: string;
  srch_yn: string;
  category_sort: number;
  api_sort: number;
  guide_url?: string;
};
type OecdApiItem = {
  id: string;
  category_name: string;
  indicator_name: string;
  flow_ref: string;
  data_key: string;
  ref_area: string;
  cycle: string;
  srch_yn: string;
  category_sort: number;
  item_sort: number;
};
type YfinanceApiItem = {
  ticker: string;
  item_name: string;
  category_name: string;
  cycle: string;
  srch_yn: string;
  category_sort: number;
  item_sort: number;
};
type WorldBankApiItem = {
  id: string;
  item_name: string;
  country_code: string;
  country_name: string;
  indicator_code: string;
  indicator_name: string;
  category_name: string;
  cycle: string;
  srch_yn: string;
  category_sort: number;
  item_sort: number;
};
type UndpIndicator = {
  id: string;
  name: string;
  short_name: string;
  display_name: string;
  description: string;
  topic_id: number;
  topic_name: string;
  source_start_year: number | null;
  source_end_year: number | null;
};
type UndpLocation = {
  id: string;
  name: string;
  iso3: string;
  iso2: string;
};
type DatagokrTreeNode = DatagokrStatItem & {
  children: DatagokrTreeNode[];
  selectable: boolean;
};
type FredTreeNode = FredStatItem & {
  children: FredTreeNode[];
  selectable: boolean;
};

/** 통계청 트리/검색 표시용: `stat_name_no`(번호+이름) 우선, 없으면 `stat_name` */
const kosisDisplayLabel = (item: Pick<KosisStatItem, "stat_name_no" | "stat_name">) =>
  (item.stat_name_no ?? "").trim() || item.stat_name;

type BokTreeNode = BokStatItem & {
  children: BokTreeNode[];
  selectable: boolean;
};
const ORG_CATALOG = [
  {
    provider: "bok",
    name: "한국은행",
    description: "경제/금융 주요 지표를 쉽게 가져옵니다.",
  },
  {
    provider: "kosis",
    name: "통계청",
    description: "국가 통계 데이터를 수집할 수 있습니다.",
  },
  {
    provider: "datagokr",
    name: "공공데이터포털",
    description: "공공기관 오픈데이터를 연동합니다.",
  },
  {
    provider: "fred",
    name: "FRED",
    description: "미국 세인트루이스 연준 경제시계열을 연동합니다.",
  },
  {
    provider: "krx",
    name: "KRX",
    description: "한국거래소 API 데이터를 수집합니다.",
  },
  {
    provider: "oecd",
    name: "OECD",
    description: "OECD 핵심 경제지표(CLI·물가·실업률 등)를 수집합니다.",
  },
  {
    provider: "undp",
    name: "UN Population Division",
    description: "UN 세계 인구 통계(인구·출생·사망 등)를 수집합니다.",
  },
  {
    provider: "yfinance",
    name: "Yahoo Finance",
    description: "주가·지수·환율·원자재 시세를 티커로 수집합니다.",
  },
  {
    provider: "worldbank",
    name: "World Bank",
    description: "세계은행 개발지표(GDP 등)를 국가별로 수집합니다.",
  },
];

const DEFAULT_STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "org", label: "기관 선택" },
  { key: "target", label: "수집대상 선택" },
  { key: "period", label: "기간 입력" },
  { key: "extra", label: "추가 파라미터 입력(선택)" },
  { key: "name", label: "API 명 입력" },
  { key: "confirm", label: "완료" },
];
const KOSIS_STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "org", label: "기관 선택" },
  { key: "target", label: "수집대상 선택" },
  { key: "kosisUserStats", label: "userStatsId 입력" },
  { key: "period", label: "주기+기간 입력" },
  { key: "extra", label: "추가 파라미터 입력(선택)" },
  { key: "name", label: "API 명 입력" },
  { key: "confirm", label: "완료" },
];
const DATAGOKR_STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "org", label: "기관 선택" },
  { key: "target", label: "수집대상 선택" },
  { key: "datagokrSpec", label: "API 정보 입력" },
  { key: "period", label: "기간 입력" },
  { key: "extra", label: "추가 파라미터 입력(선택)" },
  { key: "name", label: "API 명 입력" },
  { key: "confirm", label: "완료" },
];
const KRX_STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "org", label: "기관 선택" },
  { key: "target", label: "수집대상 선택" },
  { key: "krxApiApply", label: "API 신청 확인" },
  { key: "period", label: "기간 입력" },
  { key: "extra", label: "추가 파라미터 입력(선택)" },
  { key: "name", label: "API 명 입력" },
  { key: "confirm", label: "완료" },
];
// KRX Data Marketplace OPEN API 포털(로그인 후 인증키·컨텐츠별 이용신청)
const KRX_OPENAPI_PORTAL_URL = "https://openapi.krx.co.kr/";
const normalizeProvider = (provider?: string | null) => {
  const value = (provider ?? "").trim().toLowerCase();
  if (!value) return "custom";
  if (value === "data-go-kr" || value === "data_go_kr") return "datagokr";
  return value;
};
const KRX_API_BASE_PATH = "https://data-dbg.krx.co.kr/svc/apis";
// OECD SDMX REST 데이터 엔드포인트(고정). 데이터플로우/필터키는 path 파라미터로 들어간다.
const OECD_DATA_BASE_URL = "https://sdmx.oecd.org/public/rest/data";
// UN Population Division Data Portal 데이터 엔드포인트(고정). 지표/지역/기간을 path 로 이어붙인다.
// 예: .../api/v1/data/indicators/{지표ID}/locations/{지역ID}/start/{시작연}/end/{종료연}
const UNDP_DATA_BASE_URL = "https://population.un.org/dataportalapi/api/v1/data";
// API 키가 필요 없는 기관이지만 등록 API 검증이 비어있는 키를 허용하지 않으므로 센티넬 값을 사용한다.
// api_key_param_key 가 없으므로 실제 호출 URL 에는 절대 포함되지 않는다.
const OECD_PUBLIC_KEY = "OECD_PUBLIC";
// yfinance 는 HTTP API 가 아니라 Python(yfinance) 실행으로 수집한다.
// base_url 은 buildUrlFromSourceParams/previewUrl 의 new URL() 파싱을 통과해야 하므로
// 실제 Yahoo 호스트를 센티넬로 둔다. api_key_param_key 를 null 로 두면 키가 URL 에 절대 안 붙는다.
const YFINANCE_BASE_URL = "https://query1.finance.yahoo.com";
const YFINANCE_PUBLIC_KEY = "YFINANCE_PUBLIC";
// World Bank Open Data API. 키가 필요 없다. 최종 URL:
//   {base}/country/{국가코드}/indicator/{지표코드}?format=json&per_page=20000&date=시작연:종료연
const WORLDBANK_BASE_URL = "https://api.worldbank.org/v2";
const WORLDBANK_PUBLIC_KEY = "WORLDBANK_PUBLIC";
// OECD startPeriod/endPeriod 표기: 연 YYYY / 분기 YYYY-Qn / 월 YYYY-MM / 일 YYYY-MM-DD
const formatOecdPeriod = (dateText: string, period: string) => {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (period === "A" || period === "Y") return `${year}`;
  if (period === "Q") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "D") return `${year}-${pad(month)}-${pad(date.getDate())}`;
  return `${year}-${pad(month)}`;
};
const END_LATEST_TOKEN = "__TODAY__";
const START_RELATIVE_TOKEN_REGEX = /^__TODAY_MINUS_(\d+)(D|M|Q|A|Y)__$/i;
const START_RELATIVE_KO_REGEX = /^(\d+)\s*(일|개월|분기|년)\s*전$/;
const buildKrxEndpointUrl = (apiPath: string, apiId: string) => {
  const normalizedPath = (apiPath.trim() || "gen").replace(/^\/+|\/+$/g, "");
  const normalizedApiId = apiId.trim().replace(/^\/+/, "");
  return `${KRX_API_BASE_PATH}/${normalizedPath}/${normalizedApiId}`;
};

const pad = (value: number) => String(value).padStart(2, "0");

const formatForPeriod = (dateText: string, period: string) => {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (period === "D") return `${year}${pad(month)}${pad(date.getDate())}`;
  if (period === "Q") return `${year}Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "A" || period === "Y") return `${year}`;
  return `${year}${pad(month)}`;
};
const formatDateForPeriod = (date: Date, period: string) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (period === "D") return `${year}${pad(month)}${pad(date.getDate())}`;
  if (period === "Q") return `${year}Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "A" || period === "Y") return `${year}`;
  return `${year}${pad(month)}`;
};
const formatIsoDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const shouldUseIsoDateParamFormat = (paramKey: string) => {
  const normalized = paramKey.trim().toLowerCase();
  return normalized === "observation_start" || normalized === "observation_end";
};
// OECD(SDMX) startPeriod/endPeriod: 하이픈 표기(YYYY / YYYY-Qn / YYYY-MM / YYYY-MM-DD)
const shouldUseOecdPeriodFormat = (paramKey: string) => {
  const normalized = paramKey.trim().toLowerCase();
  return normalized === "startperiod" || normalized === "endperiod";
};
const formatOecdPeriodDate = (date: Date, period: string) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (period === "A" || period === "Y") return `${year}`;
  if (period === "Q") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "D") return `${year}-${pad(month)}-${pad(date.getDate())}`;
  return `${year}-${pad(month)}`;
};
const formatParamDateValue = (date: Date, period: string, paramKey: string) => {
  if (shouldUseIsoDateParamFormat(paramKey)) {
    return formatIsoDate(date);
  }
  if (shouldUseOecdPeriodFormat(paramKey)) {
    return formatOecdPeriodDate(date, period);
  }
  return formatDateForPeriod(date, period);
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
  const value = raw.trim();
  if (!value) return null;
  const tokenMatch = START_RELATIVE_TOKEN_REGEX.exec(value);
  if (tokenMatch) {
    const offset = Number(tokenMatch[1]);
    const unit = tokenMatch[2].toUpperCase() as "D" | "M" | "Q" | "A" | "Y";
    if (!Number.isFinite(offset) || offset < 0) return null;
    return formatParamDateValue(shiftDateByUnit(new Date(), offset, unit), period, paramKey);
  }
  const koMatch = START_RELATIVE_KO_REGEX.exec(value);
  if (koMatch) {
    const offset = Number(koMatch[1]);
    if (!Number.isFinite(offset) || offset < 0) return null;
    const unit =
      koMatch[2] === "일"
        ? "D"
        : koMatch[2] === "개월"
          ? "M"
          : koMatch[2] === "분기"
            ? "Q"
            : "Y";
    return formatParamDateValue(shiftDateByUnit(new Date(), offset, unit), period, paramKey);
  }
  return null;
};
const normalizePeriodType = (value?: string | null) => {
  const period = (value ?? "").trim().toUpperCase();
  if (["D", "M", "Q", "A", "Y"].includes(period)) return period;
  // 기존 등록 로직과 동일하게 미지원 주기는 월간(M) 기본값 사용
  return "M";
};

const addMonthsRange = (months: number) => {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - months);
  const toInput = (date: Date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return { start: toInput(start), end: toInput(end) };
};
const normalizeIsoDate = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
};

const decodeSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeValue = (value: string, mode?: string | null) => {
  const normalized = mode === "decode" ? decodeSafe(value) : value;
  if (mode === "none") return normalized;
  return encodeURIComponent(normalized);
};
// Path 값은 "/"를 경로 구분자로 보존하고, 각 세그먼트만 개별 인코딩한다.
// (예: "openapi/service/SpcdeInfoService" 의 "/"가 %2F로 깨지지 않도록)
const normalizePathValue = (value: string, mode?: string | null) =>
  value
    .split("/")
    .map((segment) => normalizeValue(segment, mode))
    .join("/");
const parseNumberedPrefix = (label: string) => {
  const token = (label.trim().match(/^([0-9]+(?:\.[0-9]+)*)\./) ?? [])[1] ?? "";
  if (!token) return null;
  const parts = token
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
  return parts.length ? parts : null;
};
const compareByNumberedPrefix = (a: string, b: string) => {
  const aParts = parseNumberedPrefix(a);
  const bParts = parseNumberedPrefix(b);
  if (aParts && bParts) {
    const length = Math.max(aParts.length, bParts.length);
    for (let index = 0; index < length; index += 1) {
      const left = aParts[index] ?? -1;
      const right = bParts[index] ?? -1;
      if (left !== right) return left - right;
    }
    return a.localeCompare(b, "ko");
  }
  if (aParts) return -1;
  if (bParts) return 1;
  return a.localeCompare(b, "ko");
};
const formatKrxOrderLabel = (item: Pick<KrxApiItem, "category_sort" | "api_sort">) => {
  const category = Number.isFinite(item.category_sort) ? item.category_sort : 0;
  const api = Number.isFinite(item.api_sort) ? item.api_sort : 0;
  return `${category}.${api}`;
};
const formatKrxCategoryLabel = (
  item: Pick<KrxApiItem, "category_sort" | "category_name"> | undefined,
) => {
  if (!item) return "";
  const category = Number.isFinite(item.category_sort) ? item.category_sort : 0;
  return `${category}. ${item.category_name}`;
};

export default function UserApiRegistrationModal({
  open,
  templates,
  sources,
  onClose,
  onCompleted,
}: Props) {
  const [step, setStep] = useState<Step>("org");
  const [orgQuery, setOrgQuery] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [bokAppliedQuery, setBokAppliedQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);
  const [bokStats, setBokStats] = useState<BokStatItem[]>([]);
  const [bokLoading, setBokLoading] = useState(false);
  const [bokError, setBokError] = useState("");
  const [bokExpanded, setBokExpanded] = useState<Set<string>>(new Set());
  const [bokSelectedStatCode, setBokSelectedStatCode] = useState<string | null>(null);
  const [krxStats, setKrxStats] = useState<KrxApiItem[]>([]);
  const [krxLoading, setKrxLoading] = useState(false);
  const [krxError, setKrxError] = useState("");
  const [krxAppliedQuery, setKrxAppliedQuery] = useState("");
  const [krxExpandedCategories, setKrxExpandedCategories] = useState<Set<string>>(new Set());
  const [krxSelectedApiId, setKrxSelectedApiId] = useState<string | null>(null);
  // KRX 는 통계청처럼 사이트에서 1회 로그인 후 API 이용신청을 해야 한다.
  // userStatsId 같은 입력값은 없고, 신청 완료 여부만 사용자가 확인(체크)하면 진행한다.
  const [krxApiApplied, setKrxApiApplied] = useState(false);
  const [kosisStats, setKosisStats] = useState<KosisStatItem[]>([]);
  const [kosisLoading, setKosisLoading] = useState(false);
  const [kosisLoadingParentKeys, setKosisLoadingParentKeys] = useState<Set<string>>(new Set());
  const [kosisLoadedParentKeys, setKosisLoadedParentKeys] = useState<Set<string>>(new Set());
  const [kosisSearchResults, setKosisSearchResults] = useState<KosisStatItem[]>([]);
  const [kosisSearchLoading, setKosisSearchLoading] = useState(false);
  const [kosisError, setKosisError] = useState("");
  const [kosisAppliedQuery, setKosisAppliedQuery] = useState("");
  const [kosisExpanded, setKosisExpanded] = useState<Set<number>>(new Set());
  const [kosisSelectedNodeId, setKosisSelectedNodeId] = useState<number | null>(null);
  const [kosisUserStatsId, setKosisUserStatsId] = useState("");
  const [kosisCycle, setKosisCycle] = useState("M");
  const [datagokrStats, setDatagokrStats] = useState<DatagokrStatItem[]>([]);
  const [datagokrLoading, setDatagokrLoading] = useState(false);
  const [datagokrError, setDatagokrError] = useState("");
  const [datagokrAppliedQuery, setDatagokrAppliedQuery] = useState("");
  const [datagokrSearchResults, setDatagokrSearchResults] = useState<DatagokrStatItem[]>([]);
  const [datagokrSelectedStatCode, setDatagokrSelectedStatCode] = useState<string | null>(null);
  const [datagokrExpanded, setDatagokrExpanded] = useState<Set<string>>(new Set());
  const [datagokrApiServiceName, setDatagokrApiServiceName] = useState("");
  const [datagokrFunctionName, setDatagokrFunctionName] = useState("");
  // FRED: 80만건 규모라 tree는 lazy loading으로 parent 기준 조회합니다.
  const [fredRoots, setFredRoots] = useState<FredTreeNode[]>([]);
  const [fredLoadingRoots, setFredLoadingRoots] = useState(false);
  const [fredLoadingSearch, setFredLoadingSearch] = useState(false);
  const [fredError, setFredError] = useState("");
  const [fredAppliedQuery, setFredAppliedQuery] = useState("");
  const [fredSearchResults, setFredSearchResults] = useState<FredStatItem[]>([]);
  const [fredSelectedNodeId, setFredSelectedNodeId] = useState<string | null>(null);
  const [fredSelectedStat, setFredSelectedStat] = useState<FredStatItem | null>(null);
  const [fredExpanded, setFredExpanded] = useState<Set<string>>(new Set());
  const [fredChildrenByParent, setFredChildrenByParent] = useState<Record<string, FredTreeNode[]>>({});
  const [fredLoadedParentKeys, setFredLoadedParentKeys] = useState<Set<string>>(new Set());
  const [fredLoadingParentKeys, setFredLoadingParentKeys] = useState<Set<string>>(new Set());
  // OECD: KRX 처럼 큐레이션된 지표 목록에서 선택한다. 주기는 선택 지표에 고정된다.
  const [oecdStats, setOecdStats] = useState<OecdApiItem[]>([]);
  const [oecdLoading, setOecdLoading] = useState(false);
  const [oecdError, setOecdError] = useState("");
  const [oecdAppliedQuery, setOecdAppliedQuery] = useState("");
  const [oecdExpandedCategories, setOecdExpandedCategories] = useState<Set<string>>(new Set());
  const [oecdSelectedId, setOecdSelectedId] = useState<string | null>(null);
  // yfinance: KRX/OECD 처럼 큐레이션된 티커 목록에서 선택한다. 주기는 일별로 고정.
  const [yfinanceStats, setYfinanceStats] = useState<YfinanceApiItem[]>([]);
  const [yfinanceLoading, setYfinanceLoading] = useState(false);
  const [yfinanceError, setYfinanceError] = useState("");
  const [yfinanceAppliedQuery, setYfinanceAppliedQuery] = useState("");
  const [yfinanceExpandedCategories, setYfinanceExpandedCategories] = useState<Set<string>>(new Set());
  const [yfinanceSelectedTicker, setYfinanceSelectedTicker] = useState<string | null>(null);
  // World Bank: OECD/yfinance 처럼 큐레이션된 지표×국가 목록에서 선택한다. 주기는 연간 고정.
  const [worldbankStats, setWorldbankStats] = useState<WorldBankApiItem[]>([]);
  const [worldbankLoading, setWorldbankLoading] = useState(false);
  const [worldbankError, setWorldbankError] = useState("");
  const [worldbankAppliedQuery, setWorldbankAppliedQuery] = useState("");
  const [worldbankExpandedCategories, setWorldbankExpandedCategories] = useState<Set<string>>(new Set());
  const [worldbankSelectedId, setWorldbankSelectedId] = useState<string | null>(null);
  // UN Population Division: 지표(indicator)와 지역(location)을 각각 선택하고 연 단위 기간으로 조회한다.
  const [undpIndicators, setUndpIndicators] = useState<UndpIndicator[]>([]);
  const [undpLocations, setUndpLocations] = useState<UndpLocation[]>([]);
  const [undpLoading, setUndpLoading] = useState(false);
  const [undpError, setUndpError] = useState("");
  const [undpIndicatorQuery, setUndpIndicatorQuery] = useState("");
  const [undpLocationQuery, setUndpLocationQuery] = useState("");
  const [undpSelectedIndicatorId, setUndpSelectedIndicatorId] = useState<string | null>(null);
  const [undpSelectedLocationId, setUndpSelectedLocationId] = useState<string | null>(null);
  const [undpExpandedTopics, setUndpExpandedTopics] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [extraParams, setExtraParams] = useState<ExtraParam[]>([{ key: "", value: "" }]);
  const [apiGroupName, setApiGroupName] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewHeader, setPreviewHeader] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Array<Array<unknown>>>([]);
  const [urlCopied, setUrlCopied] = useState(false);

  const providerGroups = useMemo(() => {
    const map = new Map<string, number>();
    templates.forEach((item) => {
      const provider = normalizeProvider(item.provider);
      map.set(provider, (map.get(provider) ?? 0) + 1);
    });
    return map;
  }, [templates]);

  const visibleOrgs = useMemo(() => {
    const q = orgQuery.trim().toLowerCase();
    return ORG_CATALOG.filter((org) => {
      if (!q) return true;
      return (
        org.name.toLowerCase().includes(q) ||
        org.description.toLowerCase().includes(q)
      );
    });
  }, [orgQuery]);

  const targetItems = useMemo(() => {
    if (!selectedProvider) return [];
    const rows: Array<{
      key: string;
      provider: string;
      source: ApiSource;
      group: ApiGroup;
      title: string;
      description: string;
      typeLabel: string;
      statusLabel: string;
      codeHint: string;
    }> = [];

    templates.forEach((source) => {
      const provider = normalizeProvider(source.provider);
      if (provider !== selectedProvider) return;
      (source.groups ?? []).forEach((group) => {
        const title = (group.name ?? "").trim() || source.name;
        const description = `${source.name} 데이터`;
        const typeLabel = title.includes("통계") ? "통계표" : "데이터셋";
        const statusLabel = source.enabled ? "사용 가능" : "사용 제한";
        rows.push({
          key: `${source.id}:${group.id}`,
          provider,
          source,
          group,
          title,
          description,
          typeLabel,
          statusLabel,
          codeHint: `ID ${group.id}`,
        });
      });
    });

    const q = targetQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((item) =>
      [item.title, item.description, item.typeLabel, item.codeHint]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [selectedProvider, targetQuery, templates]);

  const selectedTarget = useMemo(
    () => targetItems.find((item) => item.key === selectedTargetKey) ?? null,
    [selectedTargetKey, targetItems],
  );
  const bokTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "bok" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);
  const kosisTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "kosis" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);
  const datagokrTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "datagokr" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);
  const fredTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "fred" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);
  const krxTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "krx" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);

  const bokTreeRoots = useMemo(() => {
    if (!bokStats.length) return [] as BokTreeNode[];
    const nodeMap = new Map<string, BokTreeNode>();

    bokStats.forEach((item) => {
      const code = item.stat_code.trim();
      if (!code) return;
      nodeMap.set(code, {
        ...item,
        children: [],
        selectable: item.srch_yn.trim().toUpperCase() === "Y",
      });
    });

    const roots: BokTreeNode[] = [];
    nodeMap.forEach((node) => {
      const parentCode = node.p_stat_code.trim();
      const parent = nodeMap.get(parentCode);
      if (parentCode === "*" || !parent) {
        roots.push(node);
        return;
      }
      parent.children.push(node);
    });

    const sortNodes = (nodes: BokTreeNode[]) => {
      nodes.sort((a, b) => a.stat_name.localeCompare(b.stat_name, "ko"));
      nodes.forEach((node) => sortNodes(node.children));
    };
    sortNodes(roots);
    return roots;
  }, [bokStats]);
  const kosisParentKey = useCallback(
    (parentCode: string, vwCd?: string | null) =>
      `${vwCd?.trim() || "__ALL__"}::${parentCode.trim() || "*"}`,
    [],
  );
  const kosisChildrenByParent = useMemo(() => {
    const map = new Map<string, KosisStatItem[]>();
    kosisStats.forEach((item) => {
      const key =
        item.p_stat_code.trim() === "*"
          ? kosisParentKey("*")
          : kosisParentKey(item.p_stat_code, item.vw_cd);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    });
    map.forEach((list) => {
      list.sort((a, b) =>
        (a.tree_no ?? "").localeCompare(b.tree_no ?? "", undefined, { numeric: true }),
      );
    });
    return map;
  }, [kosisParentKey, kosisStats]);
  const kosisRootNodes = useMemo(
    () => kosisChildrenByParent.get(kosisParentKey("*")) ?? [],
    [kosisChildrenByParent, kosisParentKey],
  );
  /** 검색 시: 트리가 아닌 목록으로만 표시. 최종 선택 가능 통계표(srch_yn=Y)만 포함 */
  const bokSearchResults = useMemo(() => {
    const query = bokAppliedQuery.trim().toLowerCase();
    if (!query) return [] as BokStatItem[];
    return bokStats
      .filter((item) => {
        if (item.srch_yn.trim().toUpperCase() !== "Y") return false;
        return (
          item.stat_code.toLowerCase().includes(query) ||
          item.stat_name.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => a.stat_name.localeCompare(b.stat_name, "ko"));
  }, [bokAppliedQuery, bokStats]);
  const selectedBokStat = useMemo(
    () => bokStats.find((item) => item.stat_code === bokSelectedStatCode) ?? null,
    [bokSelectedStatCode, bokStats],
  );
  const krxSortedStats = useMemo(() => {
    return krxStats
      .filter((item) => item.srch_yn.trim().toUpperCase() === "Y")
      .sort((a, b) => {
        const categoryOrder = a.category_sort - b.category_sort;
        if (categoryOrder !== 0) return categoryOrder;
        const apiOrder = a.api_sort - b.api_sort;
        if (apiOrder !== 0) return apiOrder;
        return a.api_id.localeCompare(b.api_id, "ko");
      });
  }, [krxStats]);
  const krxCategoryGroups = useMemo(() => {
    const map = new Map<string, KrxApiItem[]>();
    krxSortedStats.forEach((item) => {
      const key = item.category_name || "기타";
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    });
    return Array.from(map.entries());
  }, [krxSortedStats]);
  const krxSearchResults = useMemo(() => {
    const query = krxAppliedQuery.trim().toLowerCase();
    if (!query) return [] as KrxApiItem[];
    return krxSortedStats.filter((item) =>
      [item.category_name, item.api_name, item.api_id].join(" ").toLowerCase().includes(query),
    );
  }, [krxAppliedQuery, krxSortedStats]);
  const selectedKrxStat = useMemo(
    () => krxStats.find((item) => item.api_id === krxSelectedApiId) ?? null,
    [krxSelectedApiId, krxStats],
  );
  const oecdSortedStats = useMemo(() => {
    return oecdStats
      .filter((item) => item.srch_yn.trim().toUpperCase() === "Y")
      .sort((a, b) => {
        const categoryOrder = a.category_sort - b.category_sort;
        if (categoryOrder !== 0) return categoryOrder;
        const itemOrder = a.item_sort - b.item_sort;
        if (itemOrder !== 0) return itemOrder;
        return a.indicator_name.localeCompare(b.indicator_name, "ko");
      });
  }, [oecdStats]);
  const oecdCategoryGroups = useMemo(() => {
    const map = new Map<string, OecdApiItem[]>();
    oecdSortedStats.forEach((item) => {
      const key = item.category_name || "기타";
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    });
    return Array.from(map.entries());
  }, [oecdSortedStats]);
  const oecdSearchResults = useMemo(() => {
    const query = oecdAppliedQuery.trim().toLowerCase();
    if (!query) return [] as OecdApiItem[];
    return oecdSortedStats.filter((item) =>
      [item.category_name, item.indicator_name, item.ref_area, item.flow_ref]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [oecdAppliedQuery, oecdSortedStats]);
  const selectedOecdStat = useMemo(
    () => oecdStats.find((item) => item.id === oecdSelectedId) ?? null,
    [oecdSelectedId, oecdStats],
  );
  const yfinanceSortedStats = useMemo(() => {
    return yfinanceStats
      .filter((item) => item.srch_yn.trim().toUpperCase() === "Y")
      .sort((a, b) => {
        const categoryOrder = a.category_sort - b.category_sort;
        if (categoryOrder !== 0) return categoryOrder;
        const itemOrder = a.item_sort - b.item_sort;
        if (itemOrder !== 0) return itemOrder;
        return a.item_name.localeCompare(b.item_name, "ko");
      });
  }, [yfinanceStats]);
  const yfinanceCategoryGroups = useMemo(() => {
    const map = new Map<string, YfinanceApiItem[]>();
    yfinanceSortedStats.forEach((item) => {
      const key = item.category_name || "기타";
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    });
    return Array.from(map.entries());
  }, [yfinanceSortedStats]);
  const yfinanceSearchResults = useMemo(() => {
    const query = yfinanceAppliedQuery.trim().toLowerCase();
    if (!query) return [] as YfinanceApiItem[];
    return yfinanceSortedStats.filter((item) =>
      [item.category_name, item.item_name, item.ticker].join(" ").toLowerCase().includes(query),
    );
  }, [yfinanceAppliedQuery, yfinanceSortedStats]);
  const selectedYfinanceStat = useMemo(
    () => yfinanceStats.find((item) => item.ticker === yfinanceSelectedTicker) ?? null,
    [yfinanceSelectedTicker, yfinanceStats],
  );
  const worldbankSortedStats = useMemo(() => {
    return worldbankStats
      .filter((item) => item.srch_yn.trim().toUpperCase() === "Y")
      .sort((a, b) => {
        const categoryOrder = a.category_sort - b.category_sort;
        if (categoryOrder !== 0) return categoryOrder;
        const itemOrder = a.item_sort - b.item_sort;
        if (itemOrder !== 0) return itemOrder;
        return a.item_name.localeCompare(b.item_name, "ko");
      });
  }, [worldbankStats]);
  const worldbankCategoryGroups = useMemo(() => {
    const map = new Map<string, WorldBankApiItem[]>();
    worldbankSortedStats.forEach((item) => {
      const key = item.category_name || "기타";
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    });
    return Array.from(map.entries());
  }, [worldbankSortedStats]);
  const worldbankSearchResults = useMemo(() => {
    const query = worldbankAppliedQuery.trim().toLowerCase();
    if (!query) return [] as WorldBankApiItem[];
    return worldbankSortedStats.filter((item) =>
      [item.category_name, item.item_name, item.country_name, item.country_code, item.indicator_code]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [worldbankAppliedQuery, worldbankSortedStats]);
  const selectedWorldbankStat = useMemo(
    () => worldbankStats.find((item) => item.id === worldbankSelectedId) ?? null,
    [worldbankSelectedId, worldbankStats],
  );
  // UN 지표는 주제(topicName)별로 묶어 접이식으로 표시한다(OECD 분류 카드와 동일 UX).
  const undpIndicatorTopics = useMemo(() => {
    const map = new Map<string, UndpIndicator[]>();
    undpIndicators.forEach((item) => {
      const key = item.topic_name || "기타";
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    });
    return Array.from(map.entries());
  }, [undpIndicators]);
  const undpIndicatorSearchResults = useMemo(() => {
    const query = undpIndicatorQuery.trim().toLowerCase();
    if (!query) return [] as UndpIndicator[];
    return undpIndicators.filter((item) =>
      [item.name, item.display_name, item.short_name, item.topic_name]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [undpIndicatorQuery, undpIndicators]);
  const undpLocationResults = useMemo(() => {
    const query = undpLocationQuery.trim().toLowerCase();
    if (!query) return undpLocations;
    return undpLocations.filter((item) =>
      [item.name, item.iso3, item.iso2].join(" ").toLowerCase().includes(query),
    );
  }, [undpLocationQuery, undpLocations]);
  const selectedUndpIndicator = useMemo(
    () => undpIndicators.find((item) => item.id === undpSelectedIndicatorId) ?? null,
    [undpIndicators, undpSelectedIndicatorId],
  );
  const selectedUndpLocation = useMemo(
    () => undpLocations.find((item) => item.id === undpSelectedLocationId) ?? null,
    [undpLocations, undpSelectedLocationId],
  );
  const datagokrTreeRoots = useMemo(() => {
    if (!datagokrStats.length) return [] as DatagokrTreeNode[];
    const nodeMap = new Map<string, DatagokrTreeNode>();
    datagokrStats.forEach((item) => {
      const code = item.stat_code.trim();
      if (!code) return;
      nodeMap.set(code, {
        ...item,
        children: [],
        selectable: item.srch_yn.trim().toUpperCase() === "Y",
      });
    });
    const roots: DatagokrTreeNode[] = [];
    nodeMap.forEach((node) => {
      const parentCode = node.p_stat_code.trim();
      const parent = nodeMap.get(parentCode);
      if (!parentCode || !parent) {
        roots.push(node);
        return;
      }
      parent.children.push(node);
    });
    const sortNodes = (nodes: DatagokrTreeNode[]) => {
      nodes.sort((a, b) => compareByNumberedPrefix(a.stat_name, b.stat_name));
      nodes.forEach((node) => sortNodes(node.children));
    };
    sortNodes(roots);
    return roots;
  }, [datagokrStats]);
  const fredTreeRoots = fredRoots;
  const kosisNodeIndex = useMemo(() => {
    const map = new Map<number, KosisStatItem>();
    kosisStats.forEach((item) => map.set(item.node_id, item));
    kosisSearchResults.forEach((item) => map.set(item.node_id, item));
    return map;
  }, [kosisSearchResults, kosisStats]);
  const selectedKosisStat = useMemo(
    () => (kosisSelectedNodeId ? kosisNodeIndex.get(kosisSelectedNodeId) ?? null : null),
    [kosisNodeIndex, kosisSelectedNodeId],
  );
  const selectedDatagokrStat = useMemo(
    () =>
      datagokrStats.find((item) => item.stat_code === datagokrSelectedStatCode) ??
      datagokrSearchResults.find((item) => item.stat_code === datagokrSelectedStatCode) ??
      null,
    [datagokrSearchResults, datagokrSelectedStatCode, datagokrStats],
  );
  const selectedFredStat = fredSelectedStat;
  const bokRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "bok" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  const kosisRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "kosis" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  const datagokrRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "datagokr" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  const fredRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "fred" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  const krxRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "krx" && !item.is_template,
    );
    return candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  // UN 은 데이터 조회에 Bearer 토큰이 필수라, 기관 관리에서 등록한 소스(api_key=토큰)를 사용한다.
  const undpRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "undp" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);

  const resolvedSelectedTarget = useMemo(() => {
    if (selectedProvider === "bok") {
      if (!bokTemplateTarget || !selectedBokStat) return null;
      const sourceForCall = bokRegisteredSource ?? bokTemplateTarget.source;
      return {
        key: `bok:${selectedBokStat.stat_code}`,
        provider: "bok",
        source: sourceForCall,
        group: bokTemplateTarget.group,
        title: selectedBokStat.stat_name,
        description: `통계표 코드 ${selectedBokStat.stat_code}`,
        typeLabel: "통계표",
        statusLabel: "사용 가능",
        codeHint: selectedBokStat.stat_code,
      };
    }
    if (selectedProvider === "kosis") {
      if (!kosisTemplateTarget || !selectedKosisStat) return null;
      const sourceForCall = kosisRegisteredSource ?? kosisTemplateTarget.source;
      return {
        key: `kosis:${selectedKosisStat.node_id}`,
        provider: "kosis",
        source: sourceForCall,
        group: kosisTemplateTarget.group,
        title: kosisDisplayLabel(selectedKosisStat),
        description: selectedKosisStat.full_path || `통계표 코드 ${selectedKosisStat.stat_code}`,
        typeLabel: "통계표",
        statusLabel: "사용 가능",
        codeHint: selectedKosisStat.stat_code,
      };
    }
    if (selectedProvider === "datagokr") {
      if (!datagokrTemplateTarget || !selectedDatagokrStat) return null;
      const sourceForCall = datagokrRegisteredSource ?? datagokrTemplateTarget.source;
      return {
        key: `datagokr:${selectedDatagokrStat.stat_code}`,
        provider: "datagokr",
        source: sourceForCall,
        group: datagokrTemplateTarget.group,
        title: selectedDatagokrStat.stat_name,
        description: selectedDatagokrStat.org_name || "공공데이터포털 API",
        typeLabel: "OpenAPI",
        statusLabel: "사용 가능",
        codeHint: selectedDatagokrStat.stat_code,
      };
    }
    if (selectedProvider === "fred") {
      if (!fredTemplateTarget || !selectedFredStat || !selectedFredStat.stat_code) return null;
      const sourceForCall = fredRegisteredSource ?? fredTemplateTarget.source;
      return {
        key: `fred:${selectedFredStat.node_id}`,
        provider: "fred",
        source: sourceForCall,
        group: fredTemplateTarget.group,
        title: selectedFredStat.node_name,
        description: `시리즈 코드 ${selectedFredStat.stat_code}`,
        typeLabel: "시계열",
        statusLabel: "사용 가능",
        codeHint: selectedFredStat.stat_code,
      };
    }
    if (selectedProvider === "krx") {
      if (!selectedKrxStat || !krxTemplateTarget) return null;
      const endpointUrl = buildKrxEndpointUrl(selectedKrxStat.api_path, selectedKrxStat.api_id);
      const normalizeKrxSource = (source: ApiSource) => ({
        ...source,
        base_url: endpointUrl,
      });
      const sourceForCall =
        (krxRegisteredSource ? normalizeKrxSource(krxRegisteredSource) : null) ??
        normalizeKrxSource(krxTemplateTarget.source);
      const groupForCall = krxTemplateTarget.group;
      return {
        key: `krx:${selectedKrxStat.api_id}`,
        provider: "krx",
        source: sourceForCall,
        group: groupForCall,
        title: selectedKrxStat.api_name,
        description: `${selectedKrxStat.category_name} / KRX ${selectedKrxStat.api_id}`,
        typeLabel: "시계열",
        statusLabel: "사용 가능",
        codeHint: selectedKrxStat.api_id,
      };
    }
    if (selectedProvider === "oecd") {
      if (!selectedOecdStat) return null;
      const oecdSource: ApiSource = {
        id: -1,
        name: "OECD",
        provider: "oecd",
        base_url: OECD_DATA_BASE_URL,
        api_key: OECD_PUBLIC_KEY,
        api_key_param_key: null,
        api_key_location: "query",
        api_key_order: 0,
        api_key_encode_mode: "encode",
        enabled: true,
        is_template: false,
        created_at: new Date().toISOString(),
        groups: [],
      };
      const makeParam = (
        key: string,
        value: string,
        location: "path" | "query",
        order: number,
        encodeMode: string,
      ): ApiParam => ({
        id: order,
        param_key: key,
        param_value: value,
        param_location: location,
        param_order: order,
        encode_mode: encodeMode,
        param_role: null,
      });
      const oecdGroup: ApiGroup = {
        id: -1,
        name: selectedOecdStat.indicator_name,
        is_template: false,
        created_at: new Date().toISOString(),
        params: [
          makeParam("flowRef", selectedOecdStat.flow_ref, "path", 1, "none"),
          makeParam("dataKey", selectedOecdStat.data_key, "path", 2, "none"),
          makeParam("dimensionAtObservation", "AllDimensions", "query", 3, "encode"),
          makeParam("format", "jsondata", "query", 4, "encode"),
          makeParam("startPeriod", "", "query", 5, "encode"),
          makeParam("endPeriod", "", "query", 6, "encode"),
        ],
      };
      return {
        key: `oecd:${selectedOecdStat.id}`,
        provider: "oecd",
        source: oecdSource,
        group: oecdGroup,
        title: selectedOecdStat.indicator_name,
        description: `${selectedOecdStat.flow_ref} / ${selectedOecdStat.data_key}`,
        typeLabel: "SDMX",
        statusLabel: "사용 가능",
        codeHint: selectedOecdStat.ref_area,
      };
    }
    if (selectedProvider === "yfinance") {
      if (!selectedYfinanceStat) return null;
      // OECD 와 동일하게 소스/그룹을 즉석 합성한다. (DB 템플릿 불필요)
      const yfinanceSource: ApiSource = {
        id: -1,
        name: "Yahoo Finance",
        provider: "yfinance",
        base_url: YFINANCE_BASE_URL,
        api_key: YFINANCE_PUBLIC_KEY,
        api_key_param_key: null,
        api_key_location: "query",
        api_key_order: 0,
        api_key_encode_mode: "encode",
        enabled: true,
        is_template: false,
        created_at: new Date().toISOString(),
        groups: [],
      };
      const makeParam = (
        key: string,
        value: string,
        location: "path" | "query",
        order: number,
        encodeMode: string,
      ): ApiParam => ({
        id: order,
        param_key: key,
        param_value: value,
        param_location: location,
        param_order: order,
        encode_mode: encodeMode,
        param_role: null,
      });
      // apiStart/apiEnd 의 param_role(start/end)은 submitParams 에서 부여한다.
      const yfinanceGroup: ApiGroup = {
        id: -1,
        name: selectedYfinanceStat.item_name,
        is_template: false,
        created_at: new Date().toISOString(),
        params: [
          makeParam("ticker", selectedYfinanceStat.ticker, "query", 1, "none"),
          makeParam("interval", "1d", "query", 2, "none"),
          // period(role=period_type)=D 를 둬야 apiEnd=__TODAY__ 등 상대일 토큰이
          // 일별(YYYYMMDD)로 해석된다. (없으면 월간 M 으로 잘못 해석됨)
          makeParam("period", "D", "query", 3, "none"),
          makeParam("apiStart", "", "query", 4, "encode"),
          makeParam("apiEnd", END_LATEST_TOKEN, "query", 5, "encode"),
        ],
      };
      return {
        key: `yfinance:${selectedYfinanceStat.ticker}`,
        provider: "yfinance",
        source: yfinanceSource,
        group: yfinanceGroup,
        title: selectedYfinanceStat.item_name,
        description: `${selectedYfinanceStat.category_name} / ${selectedYfinanceStat.ticker}`,
        typeLabel: "시세",
        statusLabel: "사용 가능",
        codeHint: selectedYfinanceStat.ticker,
      };
    }
    if (selectedProvider === "worldbank") {
      if (!selectedWorldbankStat) return null;
      // OECD/UNDP 처럼 소스/그룹을 즉석 합성한다. World Bank 는 키가 필요 없다.
      // 최종 URL: {base}/country/{국가}/indicator/{지표}?format=json&per_page=20000&date=시작연:종료연
      const worldbankSource: ApiSource = {
        id: -1,
        name: "World Bank",
        provider: "worldbank",
        base_url: WORLDBANK_BASE_URL,
        api_key: WORLDBANK_PUBLIC_KEY,
        api_key_param_key: null,
        api_key_location: "query",
        api_key_order: 0,
        api_key_encode_mode: "encode",
        enabled: true,
        is_template: false,
        created_at: new Date().toISOString(),
        groups: [],
      };
      const makeParam = (
        key: string,
        value: string,
        location: "path" | "query",
        order: number,
        encodeMode: string,
      ): ApiParam => ({
        id: order,
        param_key: key,
        param_value: value,
        param_location: location,
        param_order: order,
        encode_mode: encodeMode,
        param_role: null,
      });
      // country/{code}/indicator/{code} 는 리터럴 세그먼트+값을 path 파라미터로 이어붙인다(UNDP 방식).
      // date 값은 submitParams 에서 "시작연:종료연" 으로 채운다.
      const worldbankGroup: ApiGroup = {
        id: -1,
        name: `${selectedWorldbankStat.item_name} (${selectedWorldbankStat.indicator_code})`,
        is_template: false,
        created_at: new Date().toISOString(),
        params: [
          makeParam("segCountry", "country", "path", 1, "none"),
          makeParam("countryCode", selectedWorldbankStat.country_code, "path", 2, "none"),
          makeParam("segIndicator", "indicator", "path", 3, "none"),
          makeParam("indicatorCode", selectedWorldbankStat.indicator_code, "path", 4, "none"),
          makeParam("format", "json", "query", 5, "encode"),
          makeParam("per_page", "20000", "query", 6, "encode"),
          // date=시작연:종료연 — 콜론이 %3A 로 깨지지 않도록 인코딩하지 않는다.
          makeParam("date", "", "query", 7, "none"),
        ],
      };
      return {
        key: `worldbank:${selectedWorldbankStat.id}`,
        provider: "worldbank",
        source: worldbankSource,
        group: worldbankGroup,
        title: selectedWorldbankStat.item_name,
        description: `${selectedWorldbankStat.country_name} / ${selectedWorldbankStat.indicator_code}`,
        typeLabel: "개발지표",
        statusLabel: "사용 가능",
        codeHint: selectedWorldbankStat.country_code,
      };
    }
    if (selectedProvider === "undp") {
      // 기관 관리에서 등록한 UN 소스(토큰 보유)가 없으면 진행 불가.
      if (!selectedUndpIndicator || !selectedUndpLocation || !undpRegisteredSource) {
        return null;
      }
      const undpSource: ApiSource = {
        ...undpRegisteredSource,
        // 데이터 엔드포인트는 고정. 토큰은 Authorization: Bearer 헤더로만 전송되므로
        // api_key_param_key 를 비워 URL 에는 절대 포함되지 않게 한다.
        base_url: UNDP_DATA_BASE_URL,
        api_key_param_key: null,
      };
      const makeParam = (
        key: string,
        value: string,
        location: "path" | "query",
        order: number,
        encodeMode: string,
        role: string | null,
      ): ApiParam => ({
        id: order,
        param_key: key,
        param_value: value,
        param_location: location,
        param_order: order,
        encode_mode: encodeMode,
        param_role: role,
      });
      // 최종 URL: {base}/indicators/{지표ID}/locations/{지역ID}/start/{시작연}/end/{종료연}
      // 리터럴 세그먼트와 값 세그먼트를 모두 path 파라미터(encode none)로 순서대로 이어붙인다.
      const undpGroup: ApiGroup = {
        id: -1,
        name: `${selectedUndpIndicator.name} / ${selectedUndpLocation.name}`,
        is_template: false,
        created_at: new Date().toISOString(),
        params: [
          makeParam("segIndicators", "indicators", "path", 1, "none", null),
          makeParam("indicatorId", selectedUndpIndicator.id, "path", 2, "none", null),
          makeParam("segLocations", "locations", "path", 3, "none", null),
          makeParam("locationId", selectedUndpLocation.id, "path", 4, "none", null),
          makeParam("segStart", "start", "path", 5, "none", null),
          makeParam("startYear", "", "path", 6, "none", "start"),
          makeParam("segEnd", "end", "path", 7, "none", null),
          makeParam("endYear", "", "path", 8, "none", "end"),
        ],
      };
      return {
        key: `undp:${selectedUndpIndicator.id}:${selectedUndpLocation.id}`,
        provider: "undp",
        source: undpSource,
        group: undpGroup,
        title: selectedUndpIndicator.name,
        description: `${selectedUndpLocation.name} (${selectedUndpLocation.iso3})`,
        typeLabel: "인구통계",
        statusLabel: "사용 가능",
        codeHint: selectedUndpLocation.iso3,
      };
    }
    return selectedTarget;
  }, [
    selectedOecdStat,
    bokRegisteredSource,
    bokTemplateTarget,
    datagokrRegisteredSource,
    datagokrTemplateTarget,
    selectedDatagokrStat,
    fredRegisteredSource,
    fredTemplateTarget,
    krxRegisteredSource,
    krxTemplateTarget,
    kosisRegisteredSource,
    kosisTemplateTarget,
    selectedFredStat,
    selectedKosisStat,
    selectedKrxStat,
    selectedBokStat,
    selectedProvider,
    selectedTarget,
    selectedUndpIndicator,
    selectedUndpLocation,
    selectedYfinanceStat,
    selectedWorldbankStat,
    undpRegisteredSource,
  ]);

  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "bok") return;
    if (bokStats.length > 0 || bokLoading) return;
    const fetchBokStats = async () => {
      setBokLoading(true);
      setBokError("");
      try {
        const response = await fetch("/api/ingestion/bok-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: BokStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "한국은행 통계표 목록을 불러오지 못했습니다.");
        }
        const items = payload.items ?? [];
        setBokStats(items);
        setBokExpanded(new Set());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "한국은행 통계표 목록을 불러오지 못했습니다.";
        setBokError(message);
      } finally {
        setBokLoading(false);
      }
    };
    void fetchBokStats();
  }, [bokLoading, bokStats.length, open, selectedProvider, step]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "krx") return;
    if (krxStats.length > 0 || krxLoading) return;
    const fetchKrxStats = async () => {
      setKrxLoading(true);
      setKrxError("");
      try {
        const response = await fetch("/api/ingestion/krx-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: KrxApiItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "KRX API 목록을 불러오지 못했습니다.");
        }
        setKrxStats(payload.items ?? []);
        setKrxExpandedCategories(new Set());
      } catch (error) {
        const message = error instanceof Error ? error.message : "KRX API 목록을 불러오지 못했습니다.";
        setKrxError(message);
      } finally {
        setKrxLoading(false);
      }
    };
    void fetchKrxStats();
  }, [krxLoading, krxStats.length, open, selectedProvider, step]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "oecd") return;
    if (oecdStats.length > 0 || oecdLoading) return;
    const fetchOecdStats = async () => {
      setOecdLoading(true);
      setOecdError("");
      try {
        const response = await fetch("/api/ingestion/oecd-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: OecdApiItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "OECD 지표 목록을 불러오지 못했습니다.");
        }
        setOecdStats(payload.items ?? []);
        setOecdExpandedCategories(new Set());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "OECD 지표 목록을 불러오지 못했습니다.";
        setOecdError(message);
      } finally {
        setOecdLoading(false);
      }
    };
    void fetchOecdStats();
  }, [oecdLoading, oecdStats.length, open, selectedProvider, step]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "yfinance") return;
    if (yfinanceStats.length > 0 || yfinanceLoading) return;
    const fetchYfinanceStats = async () => {
      setYfinanceLoading(true);
      setYfinanceError("");
      try {
        const response = await fetch("/api/ingestion/yfinance-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: YfinanceApiItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "yfinance 티커 목록을 불러오지 못했습니다.");
        }
        setYfinanceStats(payload.items ?? []);
        setYfinanceExpandedCategories(new Set());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "yfinance 티커 목록을 불러오지 못했습니다.";
        setYfinanceError(message);
      } finally {
        setYfinanceLoading(false);
      }
    };
    void fetchYfinanceStats();
  }, [open, selectedProvider, step, yfinanceLoading, yfinanceStats.length]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "worldbank") return;
    if (worldbankStats.length > 0 || worldbankLoading) return;
    const fetchWorldbankStats = async () => {
      setWorldbankLoading(true);
      setWorldbankError("");
      try {
        const response = await fetch("/api/ingestion/worldbank-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: WorldBankApiItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "World Bank 지표 목록을 불러오지 못했습니다.");
        }
        setWorldbankStats(payload.items ?? []);
        setWorldbankExpandedCategories(new Set());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "World Bank 지표 목록을 불러오지 못했습니다.";
        setWorldbankError(message);
      } finally {
        setWorldbankLoading(false);
      }
    };
    void fetchWorldbankStats();
  }, [open, selectedProvider, step, worldbankLoading, worldbankStats.length]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "undp") return;
    if ((undpIndicators.length > 0 && undpLocations.length > 0) || undpLoading) return;
    const fetchUndpMeta = async () => {
      setUndpLoading(true);
      setUndpError("");
      try {
        const [indRes, locRes] = await Promise.all([
          fetch("/api/ingestion/undp-indicator-list"),
          fetch("/api/ingestion/undp-location-list"),
        ]);
        const indPayload = (await indRes.json()) as {
          ok?: boolean;
          items?: UndpIndicator[];
          error?: string;
        };
        const locPayload = (await locRes.json()) as {
          ok?: boolean;
          items?: UndpLocation[];
          error?: string;
        };
        if (!indRes.ok || !indPayload.ok) {
          throw new Error(indPayload.error || "UN 지표 목록을 불러오지 못했습니다.");
        }
        if (!locRes.ok || !locPayload.ok) {
          throw new Error(locPayload.error || "UN 지역 목록을 불러오지 못했습니다.");
        }
        setUndpIndicators(indPayload.items ?? []);
        setUndpLocations(locPayload.items ?? []);
        setUndpExpandedTopics(new Set());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "UN 목록을 불러오지 못했습니다.";
        setUndpError(message);
      } finally {
        setUndpLoading(false);
      }
    };
    void fetchUndpMeta();
  }, [open, selectedProvider, step, undpIndicators.length, undpLocations.length, undpLoading]);
  const loadKosisChildren = useCallback(
    async (parentCode: string, vwCd?: string) => {
      const cacheKey = kosisParentKey(parentCode, vwCd);
      if (kosisLoadedParentKeys.has(cacheKey)) return;
      setKosisLoadingParentKeys((prev) => new Set(prev).add(cacheKey));
      if (parentCode === "*") setKosisLoading(true);
      setKosisError("");
      try {
        const params = new URLSearchParams({ parent: parentCode });
        if (vwCd?.trim()) params.set("vw", vwCd.trim());
        const response = await fetch(`/api/ingestion/kosis-stat-list?${params.toString()}`);
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: KosisStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "통계청 통계표 목록을 불러오지 못했습니다.");
        }
        const items = payload.items ?? [];
        setKosisStats((prev) => {
          const next = [...prev];
          const known = new Set(prev.map((item) => item.node_id));
          items.forEach((item) => {
            if (!known.has(item.node_id)) {
              next.push(item);
              known.add(item.node_id);
            }
          });
          return next;
        });
        setKosisLoadedParentKeys((prev) => new Set(prev).add(cacheKey));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "통계청 통계표 목록을 불러오지 못했습니다.";
        setKosisError(message);
      } finally {
        setKosisLoadingParentKeys((prev) => {
          const next = new Set(prev);
          next.delete(cacheKey);
          return next;
        });
        if (parentCode === "*") setKosisLoading(false);
      }
    },
    [kosisLoadedParentKeys, kosisParentKey],
  );
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "kosis") return;
    const rootKey = kosisParentKey("*");
    if (kosisLoadedParentKeys.has(rootKey) || kosisLoading) return;
    void loadKosisChildren("*");
  }, [kosisLoadedParentKeys, kosisLoading, loadKosisChildren, open, selectedProvider, step, kosisParentKey]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "datagokr") return;
    if (datagokrStats.length > 0 || datagokrLoading) return;
    const fetchDatagokrStats = async () => {
      setDatagokrLoading(true);
      setDatagokrError("");
      try {
        const response = await fetch("/api/ingestion/datagokr-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: DatagokrStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "공공데이터포털 수집대상을 불러오지 못했습니다.");
        }
        setDatagokrStats(payload.items ?? []);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "공공데이터포털 수집대상을 불러오지 못했습니다.";
        setDatagokrError(message);
      } finally {
        setDatagokrLoading(false);
      }
    };
    void fetchDatagokrStats();
  }, [datagokrLoading, datagokrStats.length, open, selectedProvider, step]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "fred") return;
    if (fredRoots.length > 0 || fredLoadingRoots) return;
    const fetchFredRoots = async () => {
      setFredLoadingRoots(true);
      setFredError("");
      try {
        const response = await fetch("/api/ingestion/fred-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: FredStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "FRED 수집대상을 불러오지 못했습니다.");
        }
        const toTreeNode = (item: FredStatItem): FredTreeNode => ({
          ...item,
          children: [],
          selectable:
            (item.node_type ?? "").trim().toUpperCase() === "SERIES" ||
            (item.srch_yn ?? "").trim().toUpperCase() === "Y",
        });
        setFredRoots((payload.items ?? []).map(toTreeNode));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "FRED 수집대상을 불러오지 못했습니다.";
        setFredError(message);
      } finally {
        setFredLoadingRoots(false);
      }
    };
    void fetchFredRoots();
  }, [fredLoadingRoots, fredRoots.length, open, selectedProvider, step]);

  const periodType = useMemo(() => {
    if (selectedProvider === "bok" && selectedBokStat) {
      return normalizePeriodType(selectedBokStat.cycle);
    }
    if (selectedProvider === "kosis") {
      return normalizePeriodType(kosisCycle);
    }
    if (selectedProvider === "fred" && selectedFredStat) {
      return normalizePeriodType(selectedFredStat.cycle ?? "M");
    }
    if (selectedProvider === "oecd") {
      return normalizePeriodType(selectedOecdStat?.cycle ?? "M");
    }
    if (selectedProvider === "undp") {
      // UN Population Division 데이터는 연 단위(start/end 연도)로 조회한다.
      return "Y";
    }
    if (selectedProvider === "yfinance") {
      // yfinance 는 일별(1d) 시세로 고정한다.
      return "D";
    }
    if (selectedProvider === "worldbank") {
      // World Bank 개발지표(GDP 등)는 연간(A) 데이터.
      return "A";
    }
    if (!resolvedSelectedTarget) return "M";
    const params = resolvedSelectedTarget.group.params ?? [];
    const rolePeriod =
      params.find((item) => (item.param_role ?? "").trim() === "period_type")
        ?.param_value ?? "";
    const keyPeriod =
      params.find((item) =>
        ["period", "prdSe", "periodType"].includes(item.param_key),
      )?.param_value ?? "";
    const value = rolePeriod || keyPeriod || "M";
    return normalizePeriodType(value);
  }, [kosisCycle, selectedOecdStat, resolvedSelectedTarget, selectedBokStat, selectedFredStat, selectedProvider, selectedYfinanceStat, selectedWorldbankStat]);

  const canGoNextFromOrg = Boolean(selectedProvider);
  const canGoNextFromTarget =
    selectedProvider === "bok"
      ? Boolean(selectedBokStat && bokTemplateTarget)
      : selectedProvider === "krx"
        ? Boolean(selectedKrxStat && krxTemplateTarget)
      : selectedProvider === "kosis"
        ? Boolean(selectedKosisStat && kosisTemplateTarget)
      : selectedProvider === "datagokr"
        ? Boolean(selectedDatagokrStat && datagokrTemplateTarget)
      : selectedProvider === "fred"
        ? Boolean(selectedFredStat && selectedFredStat.stat_code && fredTemplateTarget)
      : selectedProvider === "oecd"
        ? Boolean(selectedOecdStat)
      : selectedProvider === "undp"
        ? Boolean(selectedUndpIndicator && selectedUndpLocation && undpRegisteredSource)
      : selectedProvider === "yfinance"
        ? Boolean(selectedYfinanceStat)
      : selectedProvider === "worldbank"
        ? Boolean(selectedWorldbankStat)
      : Boolean(selectedTarget);
  const kosisUserStatsError =
    selectedProvider === "kosis" && kosisUserStatsId.trim().length === 0
      ? "userStatsId를 입력해주세요."
      : "";
  const canGoNextFromKosisUserStats = kosisUserStatsError.length === 0;
  const datagokrSpecError =
    selectedProvider === "datagokr" &&
    (!datagokrApiServiceName.trim() || !datagokrFunctionName.trim())
      ? "API 서비스명과 상세 기능명을 모두 입력해주세요."
      : "";
  const canGoNextFromDatagokrSpec = datagokrSpecError.length === 0;
  const canGoNextFromKrxApiApply = selectedProvider !== "krx" || krxApiApplied;
  const periodError =
    !startDate || !endDate
      ? "시작일과 종료일을 입력해주세요."
      : startDate > endDate
        ? "종료일은 시작일보다 빠를 수 없습니다."
        : "";
  const canGoNextFromPeriod = periodError.length === 0;
  const apiGroupNameError =
    apiGroupName.trim().length === 0
      ? "API 명을 입력해주세요."
      : apiGroupName.trim().length > 120
        ? "API 명은 120자 이내로 입력해주세요."
        : "";
  const canGoNextFromName = apiGroupNameError.length === 0;

  const currentStepLabels =
    selectedProvider === "kosis"
      ? KOSIS_STEP_LABELS
      : selectedProvider === "datagokr"
        ? DATAGOKR_STEP_LABELS
      : selectedProvider === "krx"
        ? KRX_STEP_LABELS
      : DEFAULT_STEP_LABELS;
  const activeStepIndex = currentStepLabels.findIndex((item) => item.key === step);
  const submitParams = useMemo(() => {
    if (!resolvedSelectedTarget) return [] as Array<{
      key: string;
      value: string;
      location: "path" | "query";
      order: number;
      encodeMode?: string;
      role?: string | null;
    }>;
    const params = resolvedSelectedTarget.group.params.map((item) => ({
      key: item.param_key,
      value: item.param_value ?? "",
      location: (item.param_location as "path" | "query") ?? "query",
      order: Number.isFinite(item.param_order) ? item.param_order : 0,
      encodeMode: item.encode_mode ?? "encode",
      role: item.param_role ?? null,
    }));
    const paramMap = new Map(params.map((item) => [item.key, item]));
    const roleKey = new Map<string, string>();
    params.forEach((item) => {
      const role = item.role?.trim();
      if (!role || roleKey.has(role)) return;
      roleKey.set(role, item.key);
    });

    const startKey =
      roleKey.get("start") ??
      (["apiStart", "startPrdDe", "strtYymm"].find((key) => paramMap.has(key)) ?? null);
    const endKey =
      roleKey.get("end") ??
      (["apiEnd", "endPrdDe", "endYymm"].find((key) => paramMap.has(key)) ?? null);
    const fredStartDate = normalizeIsoDate(startDate);
    const fredEndDate = normalizeIsoDate(endDate);
    const usesIsoDate =
      selectedProvider === "fred" ||
      selectedProvider === "krx" ||
      selectedProvider === "yfinance";
    const startValue = usesIsoDate ? fredStartDate : formatForPeriod(startDate, periodType);
    const endValue = usesIsoDate ? fredEndDate : formatForPeriod(endDate, periodType);

    if (startKey && startValue) {
      const item = paramMap.get(startKey);
      if (item) paramMap.set(startKey, { ...item, value: startValue });
    }
    if (endKey && endValue) {
      const item = paramMap.get(endKey);
      if (item) paramMap.set(endKey, { ...item, value: endValue });
    }
    if (selectedProvider === "bok" && selectedBokStat) {
      const cycleRaw = (selectedBokStat.cycle ?? "").trim().toUpperCase();
      const cycleValue = normalizePeriodType(selectedBokStat.cycle);
      ["period", "prdSe", "periodType"].forEach((key) => {
        const current = paramMap.get(key);
        if (current) {
          paramMap.set(key, { ...current, value: cycleRaw || cycleValue });
        }
      });
      const statCodeParam = paramMap.get("statCode");
      if (statCodeParam) {
        paramMap.set("statCode", { ...statCodeParam, value: selectedBokStat.stat_code });
      } else {
        paramMap.set("statCode", {
          key: "statCode",
          value: selectedBokStat.stat_code,
          location: "path",
          order: 5,
          encodeMode: "encode",
          role: null,
        });
      }
    }
    if (selectedProvider === "kosis" && selectedKosisStat) {
      const setOrInsert = (
        keys: string[],
        value: string,
        defaultKey: string,
        location: "path" | "query",
        order: number,
      ) => {
        if (!value.trim()) return;
        let found = false;
        keys.forEach((key) => {
          const current = paramMap.get(key);
          if (current) {
            paramMap.set(key, { ...current, value });
            found = true;
          }
        });
        if (!found) {
          paramMap.set(defaultKey, {
            key: defaultKey,
            value,
            location,
            order,
            encodeMode: "encode",
            role: null,
          });
        }
      };
      setOrInsert(
        ["userStatsId", "tblId", "tbl_id", "statCode", "stat_code"],
        selectedKosisStat.stat_code,
        "tblId",
        "query",
        4,
      );
      setOrInsert(["userStatsId"], kosisUserStatsId.trim(), "userStatsId", "query", 4);
      setOrInsert(["prdSe", "period", "periodType"], kosisCycle, "prdSe", "query", 5);
    }
    if (selectedProvider === "datagokr" && selectedDatagokrStat) {
      const setOrInsert = (
        keys: string[],
        value: string,
        defaultKey: string,
        location: "path" | "query",
        order: number,
      ) => {
        if (!value.trim()) return;
        let found = false;
        keys.forEach((key) => {
          const current = paramMap.get(key);
          if (current) {
            paramMap.set(key, { ...current, value });
            found = true;
          }
        });
        if (!found) {
          paramMap.set(defaultKey, {
            key: defaultKey,
            value,
            location,
            order,
            encodeMode: "encode",
            role: null,
          });
        }
      };
      setOrInsert(
        ["orgCode", "org_cd"],
        selectedDatagokrStat.org_cd,
        "orgCode",
        "path",
        1,
      );
      setOrInsert(
        ["apiName", "api_name", "apiServiceName"],
        datagokrApiServiceName.trim(),
        "apiName",
        "path",
        2,
      );
      setOrInsert(
        ["functionName", "function_name", "apiDetailName"],
        datagokrFunctionName.trim(),
        "functionName",
        "path",
        3,
      );
      // 특일정보(SpcdeInfoService)는 solYear/solMonth 로 월 단위 조회하며 listId/periodType 를 쓰지 않는다.
      const isSpcde = /spcdeinfoservice/i.test(datagokrApiServiceName);
      if (!isSpcde) {
        setOrInsert(
          ["listId", "list_id", "statCode", "stat_code"],
          selectedDatagokrStat.stat_code,
          "listId",
          "query",
          6,
        );
      } else {
        // periodType/listId 는 특일정보 요청에 불필요하므로 저장 파라미터에서 제거.
        // strtYymm/endYymm 은 수집 기간(월별 반복용)으로 저장하되, 미리보기/요청 URL 에선 제외한다.
        Array.from(paramMap.keys()).forEach((key) => {
          const lower = key.trim().toLowerCase();
          if (lower === "periodtype" || lower === "listid" || lower === "list_id") {
            paramMap.delete(key);
          }
        });
        const solYear = startDate ? startDate.slice(0, 4) : "";
        const solMonth = startDate ? startDate.slice(5, 7) : "";
        if (solYear) setOrInsert(["solYear"], solYear, "solYear", "query", 7);
        if (solMonth) setOrInsert(["solMonth"], solMonth, "solMonth", "query", 8);
        setOrInsert(["numOfRows"], "100", "numOfRows", "query", 9);
      }
    }
    if (selectedProvider === "fred" && selectedFredStat?.stat_code) {
      const setOrInsert = (
        keys: string[],
        value: string,
        defaultKey: string,
        location: "path" | "query",
        order: number,
      ) => {
        if (!value.trim()) return;
        let found = false;
        keys.forEach((key) => {
          const current = paramMap.get(key);
          if (current) {
            paramMap.set(key, { ...current, value });
            found = true;
          }
        });
        if (!found) {
          paramMap.set(defaultKey, {
            key: defaultKey,
            value,
            location,
            order,
            encodeMode: "encode",
            role: null,
          });
        }
      };
      const cycleRaw = (selectedFredStat.cycle ?? "").trim();
      const frequency = cycleRaw ? cycleRaw.toLowerCase() : "m";
      setOrInsert(["series_id", "seriesId", "statCode", "stat_code"], selectedFredStat.stat_code, "series_id", "query", 5);
      setOrInsert(["frequency", "freq", "period", "periodType"], frequency, "frequency", "query", 6);
      setOrInsert(["observation_start", "apiStart", "start"], fredStartDate, "observation_start", "query", 7);
      setOrInsert(["observation_end", "apiEnd", "end"], fredEndDate, "observation_end", "query", 8);
      setOrInsert(["file_type", "fileType", "format"], "json", "file_type", "query", 1);
    }
    if (selectedProvider === "krx" && selectedKrxStat) {
      const setOrInsert = (
        keys: string[],
        value: string,
        defaultKey: string,
        location: "path" | "query",
        order: number,
      ) => {
        if (!value.trim()) return;
        let found = false;
        keys.forEach((key) => {
          const current = paramMap.get(key);
          if (current) {
            paramMap.set(key, { ...current, value });
            found = true;
          }
        });
        if (!found) {
          paramMap.set(defaultKey, {
            key: defaultKey,
            value,
            location,
            order,
            encodeMode: "encode",
            role: null,
          });
        }
      };
      const basDdValue = endDate ? formatForPeriod(endDate, "D") : "";
      const startValueD = startDate ? formatForPeriod(startDate, "D") : "";
      const endValueD = endDate ? formatForPeriod(endDate, "D") : "";
      setOrInsert(
        ["apiPath", "api_path", "krxApiPath"],
        selectedKrxStat.api_path,
        "apiPath",
        "path",
        1,
      );
      setOrInsert(
        ["apiId", "api_id", "krxApiId"],
        selectedKrxStat.api_id,
        "apiId",
        "path",
        2,
      );
      setOrInsert(["period", "prdSe", "periodType"], "D", "period", "query", 1);
      setOrInsert(["apiStart", "start", "startDt"], startValueD, "apiStart", "query", 2);
      setOrInsert(["apiEnd", "end", "endDt"], endValueD, "apiEnd", "query", 3);
      setOrInsert(["basDd", "BAS_DD"], basDdValue, "basDd", "query", 4);
    }
    if (selectedProvider === "oecd") {
      // 선택 기간을 OECD 표기(YYYY / YYYY-Qn / YYYY-MM / YYYY-MM-DD)로 채운다.
      const oecdStart = formatOecdPeriod(startDate, periodType);
      const oecdEnd = formatOecdPeriod(endDate, periodType);
      const startItem = paramMap.get("startPeriod");
      if (startItem) paramMap.set("startPeriod", { ...startItem, value: oecdStart });
      const endItem = paramMap.get("endPeriod");
      if (endItem) paramMap.set("endPeriod", { ...endItem, value: oecdEnd });
    }
    if (selectedProvider === "yfinance") {
      // 값은 위 일반 채움에서 ISO(YYYY-MM-DD)로 채워졌다. 여기서는 role(start/end/period_type)만
      // 부여해 등록 시 저장되고 load-runner 가 기간·주기를 인식하도록 한다.
      const startItem = paramMap.get("apiStart");
      if (startItem) paramMap.set("apiStart", { ...startItem, role: "start" });
      const endItem = paramMap.get("apiEnd");
      if (endItem) paramMap.set("apiEnd", { ...endItem, role: "end" });
      const periodItem = paramMap.get("period");
      if (periodItem) paramMap.set("period", { ...periodItem, role: "period_type" });
    }
    if (selectedProvider === "worldbank") {
      // World Bank 는 date=시작연:종료연(연도 범위) 한 파라미터로 기간을 지정한다.
      const startYear = formatForPeriod(startDate, "A");
      const endYear = formatForPeriod(endDate, "A");
      const dateValue = startYear && endYear ? `${startYear}:${endYear}` : "";
      const dateItem = paramMap.get("date");
      if (dateItem) paramMap.set("date", { ...dateItem, value: dateValue });
    }

    const maxOrder = params.reduce((acc, item) => Math.max(acc, item.order), 0);
    let orderCursor = maxOrder + 1;
    extraParams
      .filter((item) => item.key.trim() && item.value.trim())
      .forEach((item) => {
        const key = item.key.trim();
        const value = item.value.trim();
        const current = paramMap.get(key);
        if (current) {
          paramMap.set(key, { ...current, value });
        } else {
          paramMap.set(key, {
            key,
            value,
            location: "query",
            order: orderCursor,
            encodeMode: "encode",
            role: null,
          });
          orderCursor += 1;
        }
      });

    return Array.from(paramMap.values());
  }, [
    endDate,
    extraParams,
    periodType,
    resolvedSelectedTarget,
    selectedBokStat,
    kosisCycle,
    datagokrApiServiceName,
    datagokrFunctionName,
    selectedDatagokrStat,
    selectedFredStat,
    selectedKrxStat,
    fredTemplateTarget,
    kosisUserStatsId,
    selectedKosisStat,
    selectedProvider,
    startDate,
  ]);

  const previewUrl = useMemo(() => {
    if (!resolvedSelectedTarget) return "";
    const source = resolvedSelectedTarget.source;
    if (!source.base_url) return "";
    const provider = normalizeProvider(resolvedSelectedTarget.provider ?? selectedProvider ?? "");
    const isKrxProvider = provider === "krx";
    const url = new URL(source.base_url);
    const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    const apiKeyKey = source.api_key_param_key?.trim() || "";
    const apiKeyLocation = source.api_key_location || "query";
    const apiKeyOrder = Number.isFinite(source.api_key_order)
      ? Number(source.api_key_order)
      : 0;
    const apiKeyValue = source.api_key ?? "";

    const roleKeyMap = new Map<string, string>();
    submitParams.forEach((item) => {
      const role = item.role?.trim();
      if (!role || roleKeyMap.has(role)) return;
      roleKeyMap.set(role, item.key);
    });
    const paramValueByKey = new Map<string, string>(submitParams.map((item) => [item.key, item.value]));
    const paramValueByKeyLower = new Map<string, string>(
      submitParams.map((item) => [item.key.trim().toLowerCase(), item.value]),
    );
    const periodTypeKey =
      roleKeyMap.get("period_type") ??
      (["period", "prdse", "periodtype", "frequency", "freq"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const startKey =
      roleKeyMap.get("start") ??
      (["apistart", "startprdde", "strtyymm", "observation_start", "startperiod"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const endKey =
      roleKeyMap.get("end") ??
      (["apiend", "endprdde", "endyymm", "observation_end", "endperiod", "basdd"].find((key) =>
        paramValueByKeyLower.has(key),
      ) ?? null);
    const effectivePeriod = normalizePeriodType(
      periodTypeKey ? paramValueByKeyLower.get(periodTypeKey) : "M",
    );
    const resolvedParams = submitParams.map((item) => {
      const paramKey = item.key.trim().toLowerCase();
      const isStartParamByKey = [
        "apistart",
        "startprdde",
        "strtyymm",
        "observation_start",
        "startperiod",
      ].includes(paramKey);
      const isEndParamByKey = [
        "apiend",
        "endprdde",
        "endyymm",
        "observation_end",
        "endperiod",
        "basdd",
      ].includes(paramKey);
      const shouldResolveLatest =
        item.value === END_LATEST_TOKEN &&
        (paramKey === "basdd" || (endKey && paramKey === endKey) || (!endKey && isEndParamByKey));
      if (shouldResolveLatest) {
        return {
          ...item,
          value: formatParamDateValue(new Date(), effectivePeriod, item.key),
        };
      }
      const shouldResolveStartRelative =
        (startKey && paramKey === startKey) || (!startKey && isStartParamByKey);
      const shouldResolveEndRelative =
        (endKey && paramKey === endKey) || (!endKey && isEndParamByKey);
      if (shouldResolveStartRelative) {
        const startValue = resolveRelativeStartValue(item.value, effectivePeriod, item.key);
        if (startValue) return { ...item, value: startValue };
      }
      if (shouldResolveEndRelative) {
        const endValue = resolveRelativeStartValue(item.value, effectivePeriod, item.key);
        if (endValue) return { ...item, value: endValue };
      }
      return item;
    });

    const pathParams = resolvedParams
      .filter((item) => item.location === "path" && item.value.trim())
      .map((item) => ({ ...item, encodeMode: item.encodeMode ?? "encode" }));
    // 특일정보(SpcdeInfoService): 미리보기/요청 URL 에서는 기간·주기·목록 파라미터를 제외하고
    // solYear/solMonth 만 노출한다(strtYymm/endYymm 은 저장만 되고 월별 반복에 사용됨).
    const isSpcdePreview = resolvedParams.some(
      (item) => item.location === "path" && /spcdeinfoservice/i.test(item.value),
    );
    const spcdeExcludedKeys = ["strtyymm", "endyymm", "periodtype", "listid", "list_id"];
    const queryParams = resolvedParams
      .filter(
        (item) =>
          item.location === "query" &&
          item.key.trim() &&
          item.value.trim() &&
          (!isKrxProvider ||
            !["apistart", "apiend", "start", "end", "period", "prdse", "periodtype"].includes(
              item.key.trim().toLowerCase(),
            )) &&
          (!isSpcdePreview || !spcdeExcludedKeys.includes(item.key.trim().toLowerCase())) &&
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
          encodeMode: source.api_key_encode_mode ?? "encode",
        });
      } else {
        queryParams.push({
          key: apiKeyKey,
          value: apiKeyValue,
          location: "query",
          order: apiKeyOrder,
          encodeMode: source.api_key_encode_mode ?? "encode",
        });
      }
    }
    const pathSegment = pathParams
      .sort((a, b) => a.order - b.order)
      .map((item) => normalizePathValue(item.value, item.encodeMode))
      .join("/");
    const queryPairs = queryParams
      .sort((a, b) => a.order - b.order)
      .map((item) => `${encodeURIComponent(item.key)}=${normalizeValue(item.value, item.encodeMode)}`)
      .join("&");
    const existingQuery = url.search.replace(/^\?/, "");
    const mergedQuery = [existingQuery, queryPairs].filter(Boolean).join("&");
    const fullPath = (() => {
      if (!pathSegment) return base;
      if (!isKrxProvider) return `${base}/${pathSegment}`;
      const basePath = url.pathname.replace(/\/+$/, "");
      if (basePath.includes("/svc/apis/")) {
        return base;
      }
      return `${url.origin}/svc/apis/${pathSegment}`;
    })();
    return mergedQuery ? `${fullPath}?${mergedQuery}` : fullPath;
  }, [resolvedSelectedTarget, selectedProvider, submitParams]);

  const resetAll = () => {
    setStep("org");
    setOrgQuery("");
    setTargetQuery("");
    setBokAppliedQuery("");
    setSelectedProvider(null);
    setSelectedTargetKey(null);
    setBokExpanded(new Set());
    setBokSelectedStatCode(null);
    setBokError("");
    setKrxStats([]);
    setKrxLoading(false);
    setKrxError("");
    setKrxAppliedQuery("");
    setKrxExpandedCategories(new Set());
    setKrxSelectedApiId(null);
    setKrxApiApplied(false);
    setKosisExpanded(new Set());
    setKosisSelectedNodeId(null);
    setKosisStats([]);
    setKosisLoading(false);
    setKosisSearchResults([]);
    setKosisLoadingParentKeys(new Set());
    setKosisLoadedParentKeys(new Set());
    setKosisSearchLoading(false);
    setKosisUserStatsId("");
    setKosisCycle("M");
    setKosisAppliedQuery("");
    setKosisError("");
    setDatagokrStats([]);
    setDatagokrLoading(false);
    setDatagokrError("");
    setDatagokrAppliedQuery("");
    setDatagokrSearchResults([]);
    setDatagokrSelectedStatCode(null);
    setDatagokrExpanded(new Set());
    setDatagokrApiServiceName("");
    setDatagokrFunctionName("");
    setFredError("");
    setFredAppliedQuery("");
    setFredRoots([]);
    setFredLoadingRoots(false);
    setFredLoadingSearch(false);
    setFredSearchResults([]);
    setFredSelectedNodeId(null);
    setFredSelectedStat(null);
    setFredExpanded(new Set());
    setFredChildrenByParent({});
    setFredLoadedParentKeys(new Set());
    setFredLoadingParentKeys(new Set());
    setOecdStats([]);
    setOecdLoading(false);
    setOecdError("");
    setOecdAppliedQuery("");
    setOecdExpandedCategories(new Set());
    setOecdSelectedId(null);
    setYfinanceStats([]);
    setYfinanceLoading(false);
    setYfinanceError("");
    setYfinanceAppliedQuery("");
    setYfinanceExpandedCategories(new Set());
    setYfinanceSelectedTicker(null);
    setWorldbankStats([]);
    setWorldbankLoading(false);
    setWorldbankError("");
    setWorldbankAppliedQuery("");
    setWorldbankExpandedCategories(new Set());
    setWorldbankSelectedId(null);
    setUndpIndicators([]);
    setUndpLocations([]);
    setUndpLoading(false);
    setUndpError("");
    setUndpIndicatorQuery("");
    setUndpLocationQuery("");
    setUndpSelectedIndicatorId(null);
    setUndpSelectedLocationId(null);
    setUndpExpandedTopics(new Set());
    setStartDate("");
    setEndDate("");
    setExtraParams([{ key: "", value: "" }]);
    setApiGroupName("");
    setSubmitError("");
    setSubmitting(false);
    setDone(false);
    setPreviewLoading(false);
    setPreviewError("");
    setPreviewHeader([]);
    setPreviewRows([]);
    setUrlCopied(false);
  };

  const handleClose = () => {
    resetAll();
    onClose();
  };

  const goBack = () => {
    if (step === "target") setStep("org");
    else if (step === "kosisUserStats") setStep("target");
    else if (step === "datagokrSpec") setStep("target");
    else if (step === "krxApiApply") setStep("target");
    else if (step === "period")
      setStep(
        selectedProvider === "kosis"
          ? "kosisUserStats"
          : selectedProvider === "datagokr"
            ? "datagokrSpec"
          : selectedProvider === "krx"
            ? "krxApiApply"
          : "target",
      );
    else if (step === "extra") setStep("period");
    else if (step === "name") setStep("extra");
    else if (step === "confirm") setStep("name");
  };

  const quickRange = (months: number) => {
    const next = addMonthsRange(months);
    setStartDate(next.start);
    setEndDate(next.end);
  };

  const handleSubmit = async () => {
    if (!resolvedSelectedTarget || periodError || apiGroupNameError) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = {
        source: {
          name: resolvedSelectedTarget.source.name,
          provider: normalizeProvider(resolvedSelectedTarget.source.provider),
          baseUrl: resolvedSelectedTarget.source.base_url,
          apiKey: resolvedSelectedTarget.source.api_key ?? "",
          enabled: true,
          apiKeyParamKey: resolvedSelectedTarget.source.api_key_param_key ?? "",
          apiKeyLocation: resolvedSelectedTarget.source.api_key_location ?? "query",
          apiKeyOrder: resolvedSelectedTarget.source.api_key_order ?? 0,
          apiKeyEncodeMode: resolvedSelectedTarget.source.api_key_encode_mode ?? "encode",
        },
        groupName: apiGroupName.trim(),
        params: submitParams,
      };

      const response = await fetch("/api/ingestion/api-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "등록에 실패했습니다.");
      }
      setDone(true);
      onCompleted();
    } catch (error) {
      const message = error instanceof Error ? error.message : "등록에 실패했습니다.";
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleBokNode = (code: string) => {
    setBokExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const runBokSearch = () => {
    const query = targetQuery.trim();
    setBokAppliedQuery(query);
    if (!query) {
      setBokExpanded(new Set());
    }
  };

  const resetBokSearch = () => {
    setTargetQuery("");
    setBokAppliedQuery("");
    setBokExpanded(new Set());
  };
  const runKrxSearch = () => {
    const query = targetQuery.trim();
    setKrxAppliedQuery(query);
    if (!query) {
      setKrxExpandedCategories(new Set());
    }
  };
  const resetKrxSearch = () => {
    setTargetQuery("");
    setKrxAppliedQuery("");
    setKrxExpandedCategories(new Set());
    setKrxSelectedApiId(null);
  };
  const toggleKrxCategory = (category: string) => {
    setKrxExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const runOecdSearch = () => {
    const query = targetQuery.trim();
    setOecdAppliedQuery(query);
    if (!query) {
      setOecdExpandedCategories(new Set());
    }
  };
  const resetOecdSearch = () => {
    setTargetQuery("");
    setOecdAppliedQuery("");
    setOecdExpandedCategories(new Set());
    setOecdSelectedId(null);
  };
  const toggleOecdCategory = (category: string) => {
    setOecdExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const runYfinanceSearch = () => {
    const query = targetQuery.trim();
    setYfinanceAppliedQuery(query);
    if (!query) {
      setYfinanceExpandedCategories(new Set());
    }
  };
  const resetYfinanceSearch = () => {
    setTargetQuery("");
    setYfinanceAppliedQuery("");
    setYfinanceExpandedCategories(new Set());
    setYfinanceSelectedTicker(null);
  };
  const toggleYfinanceCategory = (category: string) => {
    setYfinanceExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const runWorldbankSearch = () => {
    const query = targetQuery.trim();
    setWorldbankAppliedQuery(query);
    if (!query) {
      setWorldbankExpandedCategories(new Set());
    }
  };
  const resetWorldbankSearch = () => {
    setTargetQuery("");
    setWorldbankAppliedQuery("");
    setWorldbankExpandedCategories(new Set());
    setWorldbankSelectedId(null);
  };
  const toggleWorldbankCategory = (category: string) => {
    setWorldbankExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const toggleUndpTopic = (topic: string) => {
    setUndpExpandedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  };
  const toggleFredNode = async (node: FredTreeNode) => {
    const nodeId = node.node_id;
    const shouldExpand = !fredExpanded.has(nodeId);

    setFredExpanded((prev) => {
      const next = new Set(prev);
      if (shouldExpand) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });

    // 접기면 자식 로드는 필요 없습니다.
    if (!shouldExpand) return;

    // 이미 로드했으면 재조회하지 않습니다.
    if (fredLoadedParentKeys.has(nodeId)) return;

    setFredLoadingParentKeys((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });

    try {
      const response = await fetch(
        `/api/ingestion/fred-stat-list?parent=${encodeURIComponent(nodeId)}`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        items?: FredStatItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "FRED 하위 항목 로드에 실패했습니다.");
      }

      const toTreeNode = (item: FredStatItem): FredTreeNode => ({
        ...item,
        children: [],
        selectable:
          (item.node_type ?? "").trim().toUpperCase() === "SERIES" ||
          (item.srch_yn ?? "").trim().toUpperCase() === "Y",
      });

      setFredChildrenByParent((prev) => ({
        ...prev,
        [nodeId]: (payload.items ?? []).map(toTreeNode),
      }));
      setFredLoadedParentKeys((prev) => {
        const next = new Set(prev);
        next.add(nodeId);
        return next;
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "FRED 하위 항목 로드에 실패했습니다.";
      setFredError(message);
    } finally {
      setFredLoadingParentKeys((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    }
  };
  const toggleDatagokrNode = (code: string) => {
    setDatagokrExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };
  const toggleKosisNode = async (node: KosisStatItem) => {
    const nodeId = node.node_id;
    const shouldExpand = !kosisExpanded.has(nodeId);
    setKosisExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    if (!shouldExpand || node.srch_yn.trim().toUpperCase() === "Y") return;
    await loadKosisChildren(node.stat_code, node.vw_cd);
  };
  const runKosisSearch = async () => {
    const query = targetQuery.trim();
    setKosisAppliedQuery(query);
    if (!query) {
      setKosisSearchResults([]);
      return;
    }
    setKosisSearchLoading(true);
    setKosisError("");
    try {
      const response = await fetch(
        `/api/ingestion/kosis-stat-search?q=${encodeURIComponent(query)}&limit=100`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        items?: KosisStatItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "통계청 검색 결과를 불러오지 못했습니다.");
      }
      setKosisSearchResults(payload.items ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "통계청 검색 결과를 불러오지 못했습니다.";
      setKosisError(message);
      setKosisSearchResults([]);
    } finally {
      setKosisSearchLoading(false);
    }
  };
  const resetKosisSearch = () => {
    setTargetQuery("");
    setKosisAppliedQuery("");
    setKosisSearchResults([]);
  };
  const runDatagokrSearch = () => {
    const query = targetQuery.trim();
    setDatagokrAppliedQuery(query);
    if (!query) {
      setDatagokrSearchResults([]);
      setDatagokrExpanded(new Set());
      return;
    }
    setDatagokrLoading(true);
    setDatagokrError("");
    void fetch(`/api/ingestion/datagokr-stat-list?q=${encodeURIComponent(query)}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: DatagokrStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "공공데이터포털 검색 결과를 불러오지 못했습니다.");
        }
        setDatagokrSearchResults(payload.items ?? []);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "공공데이터포털 검색 결과를 불러오지 못했습니다.";
        setDatagokrError(message);
        setDatagokrSearchResults([]);
      })
      .finally(() => {
        setDatagokrLoading(false);
      });
  };
  const resetDatagokrSearch = () => {
    setTargetQuery("");
    setDatagokrAppliedQuery("");
    setDatagokrSearchResults([]);
    setDatagokrSelectedStatCode(null);
    setDatagokrExpanded(new Set());
  };
  const runFredSearch = () => {
    const query = targetQuery.trim();
    setFredAppliedQuery(query);
    if (!query) {
      setFredSearchResults([]);
      setFredExpanded(new Set());
      return;
    }
    setFredLoadingSearch(true);
    setFredError("");
    void fetch(`/api/ingestion/fred-stat-search?q=${encodeURIComponent(query)}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: FredStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "FRED 검색 결과를 불러오지 못했습니다.");
        }
        setFredSearchResults(payload.items ?? []);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "FRED 검색 결과를 불러오지 못했습니다.";
        setFredError(message);
        setFredSearchResults([]);
      })
      .finally(() => {
        setFredLoadingSearch(false);
      });
  };
  const resetFredSearch = () => {
    setTargetQuery("");
    setFredAppliedQuery("");
    setFredSearchResults([]);
    setFredSelectedNodeId(null);
    setFredSelectedStat(null);
    setFredExpanded(new Set());
    setFredLoadingSearch(false);
  };

  const buildTabularFromJsonPreview = (raw: unknown) => {
    const tryExtractRows = (obj: Record<string, unknown>): Array<Record<string, unknown>> | null => {
      const extractObjectRows = (value: unknown): Array<Record<string, unknown>> | null => {
        if (Array.isArray(value)) {
          const rows = value.filter(
            (item): item is Record<string, unknown> =>
              item != null && typeof item === "object" && !Array.isArray(item),
          );
          return rows.length > 0 ? rows : null;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return [value as Record<string, unknown>];
        }
        if (typeof value === "string") {
          const trimmed = value.trim();
          if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
            try {
              return extractObjectRows(JSON.parse(trimmed) as unknown);
            } catch {
              return null;
            }
          }
        }
        return null;
      };
      const outBlockKeys = ["OutBlock_1", "OUTBLOCK_1", "outBlock_1", "outblock_1"];
      for (const key of outBlockKeys) {
        if (!(key in obj)) continue;
        const rows = extractObjectRows(obj[key]);
        if (rows && rows.length > 0) {
          return rows;
        }
      }
      if (Array.isArray(obj.row)) {
        return obj.row.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      if (Array.isArray(obj.rows)) {
        return obj.rows.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      if (Array.isArray(obj.items)) {
        return obj.items.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const nested = tryExtractRows(value as Record<string, unknown>);
          if (nested && nested.length > 0) return nested;
        }
      }
      return null;
    };

    const normalized = (() => {
      if (raw == null) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
          try {
            return JSON.parse(trimmed) as unknown;
          } catch {
            return [{ value: raw }];
          }
        }
        return [{ value: raw }];
      }
      if (typeof raw === "object") {
        const record = raw as Record<string, unknown>;
        const extractedRows = tryExtractRows(record);
        if (extractedRows && extractedRows.length > 0) return extractedRows;
        if (Array.isArray(record.data)) return record.data;
        if (Array.isArray(record.rows)) return record.rows;
        if (Array.isArray(record.items)) return record.items;
        return [record];
      }
      return [{ value: raw }];
    })();

    const asArray = Array.isArray(normalized) ? normalized : [normalized];
    const objectRows = asArray.filter(
      (item): item is Record<string, unknown> =>
        item != null && typeof item === "object" && !Array.isArray(item),
    );
    if (objectRows.length === 0) {
      return {
        header: ["value"],
        rows: asArray.slice(0, 10).map((item) => [String(item ?? "")]),
      };
    }
    const header = Array.from(new Set(objectRows.flatMap((row) => Object.keys(row))));
    const rows = objectRows.slice(0, 10).map((row) =>
      header.map((key) => row[key] ?? null),
    );
    return { header, rows };
  };

  const buildTabularFromDatagokrXml = (raw: unknown, contentType?: string) => {
    if (typeof raw !== "string") {
      throw new Error("공공데이터포털 XML 응답 파싱에 실패했습니다.");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("조회 결과가 없습니다.");
    }

    const contentTypeValue = (contentType ?? "").toLowerCase();
    const looksLikeXml = trimmed.startsWith("<");
    const isXmlContentType = contentTypeValue.includes("xml");
    if (!looksLikeXml && !isXmlContentType) {
      throw new Error("공공데이터포털 미리보기 응답이 XML 형식이 아닙니다.");
    }

    let document: Document;
    try {
      document = new DOMParser().parseFromString(trimmed, "application/xml");
    } catch {
      throw new Error("공공데이터포털 XML 응답 파싱에 실패했습니다.");
    }
    if (document.querySelector("parsererror")) {
      throw new Error("공공데이터포털 XML 응답 파싱에 실패했습니다.");
    }

    const elementChildren = (element: Element) =>
      Array.from(element.children).filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE);

    const readRow = (element: Element): Record<string, unknown> => {
      const children = elementChildren(element);
      if (children.length === 0) {
        return { value: (element.textContent ?? "").trim() };
      }
      return children.reduce<Record<string, unknown>>((acc, child) => {
        acc[child.tagName] = (child.textContent ?? "").trim();
        return acc;
      }, {});
    };

    const preferredRows = ["item", "row"].flatMap((tagName) =>
      Array.from(document.getElementsByTagName(tagName)).filter((node) => elementChildren(node).length > 0),
    );
    const rowsFromPreferred = preferredRows.map(readRow).filter((row) => Object.keys(row).length > 0);
    if (rowsFromPreferred.length > 0) {
      const header = Array.from(new Set(rowsFromPreferred.flatMap((row) => Object.keys(row))));
      const rows = rowsFromPreferred.slice(0, 10).map((row) => header.map((key) => row[key] ?? ""));
      return { header, rows };
    }

    const leafElements = Array.from(document.querySelectorAll("*")).filter(
      (element) => element.children.length === 0,
    );
    if (leafElements.length > 0) {
      const singleRow = leafElements.reduce<Record<string, unknown>>((acc, element) => {
        const key = element.tagName;
        if (key && !(key in acc)) {
          acc[key] = (element.textContent ?? "").trim();
        }
        return acc;
      }, {});
      const header = Object.keys(singleRow);
      if (header.length > 0) {
        return { header, rows: [header.map((key) => singleRow[key] ?? "")] };
      }
    }

    throw new Error("미리보기 응답 구조를 확인해주세요.");
  };
  // 특일정보 월별 미리보기용: XML 의 <item>/<row> 를 객체 배열로 추출(없으면 빈 배열, 예외 던지지 않음).
  const extractDatagokrItemRows = (raw: unknown): Array<Record<string, string>> => {
    if (typeof raw !== "string") return [];
    const trimmed = raw.trim();
    if (!trimmed || !trimmed.startsWith("<")) return [];
    let document: Document;
    try {
      document = new DOMParser().parseFromString(trimmed, "application/xml");
    } catch {
      return [];
    }
    if (document.querySelector("parsererror")) return [];
    const elementChildren = (element: Element) =>
      Array.from(element.children).filter(
        (child): child is Element => child.nodeType === Node.ELEMENT_NODE,
      );
    const nodes = ["item", "row"].flatMap((tagName) =>
      Array.from(document.getElementsByTagName(tagName)).filter(
        (node) => elementChildren(node).length > 0,
      ),
    );
    return nodes
      .map((element) =>
        elementChildren(element).reduce<Record<string, string>>((acc, child) => {
          acc[child.tagName] = (child.textContent ?? "").trim();
          return acc;
        }, {}),
      )
      .filter((row) => Object.keys(row).length > 0);
  };
  const buildTabularFromFredPreview = (raw: unknown) => {
    const parsed = (() => {
      if (raw == null) return null;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          throw new Error("FRED 응답에서 observations 데이터를 찾을 수 없습니다.");
        }
      }
      return raw;
    })();

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FRED 응답에서 observations 데이터를 찾을 수 없습니다.");
    }

    const observations = (parsed as Record<string, unknown>).observations;
    if (!Array.isArray(observations)) {
      throw new Error("FRED 응답에서 observations 데이터를 찾을 수 없습니다.");
    }

    const objectRows = observations.filter(
      (item): item is Record<string, unknown> =>
        item != null && typeof item === "object" && !Array.isArray(item),
    );
    if (objectRows.length === 0) {
      throw new Error("조회 결과가 없습니다.");
    }

    const keys = Array.from(new Set(objectRows.flatMap((row) => Object.keys(row))));
    const preferred = ["date", "value"].filter((key) => keys.includes(key));
    const rest = keys.filter((key) => !preferred.includes(key));
    const header = [...preferred, ...rest];
    const rows = objectRows.slice(0, 10).map((row) => header.map((key) => row[key] ?? null));
    return { header, rows };
  };
  const buildTabularFromOecdPreview = (raw: unknown) => {
    const parsed = (() => {
      if (raw == null) return null;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          throw new Error("OECD 응답(JSON) 파싱에 실패했습니다.");
        }
      }
      return raw;
    })();
    if (!parsed || typeof parsed !== "object") {
      throw new Error("OECD 응답에서 데이터를 찾을 수 없습니다.");
    }
    const data = (parsed as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    if (!data || typeof data !== "object") {
      throw new Error("OECD 응답에서 데이터를 찾을 수 없습니다.");
    }
    const structuresValue = data.structures;
    const structure = (
      Array.isArray(structuresValue) ? structuresValue[0] : data.structure
    ) as Record<string, unknown> | undefined;
    const dataSetsValue = data.dataSets;
    const dataSet = (
      Array.isArray(dataSetsValue) ? dataSetsValue[0] : undefined
    ) as Record<string, unknown> | undefined;
    if (!structure || !dataSet) {
      throw new Error("OECD 응답 구조를 확인해주세요.");
    }
    type SdmxEntry = { id?: string; values?: Array<{ id?: string; name?: string }> };
    const dimsRaw = (structure.dimensions as Record<string, unknown> | undefined)
      ?.observation;
    const attrsRaw = (structure.attributes as Record<string, unknown> | undefined)
      ?.observation;
    const dims: SdmxEntry[] = Array.isArray(dimsRaw) ? (dimsRaw as SdmxEntry[]) : [];
    const attrs: SdmxEntry[] = Array.isArray(attrsRaw) ? (attrsRaw as SdmxEntry[]) : [];
    const observations = dataSet.observations as
      | Record<string, unknown[]>
      | undefined;
    if (!dims.length || !observations || typeof observations !== "object") {
      throw new Error("OECD 조회 결과가 없습니다.");
    }
    const header = [
      ...dims.map((dim, index) => dim.id ?? `DIM_${index}`),
      "OBS_VALUE",
      ...attrs.map((attr, index) => attr.id ?? `ATTR_${index}`),
    ];
    const resolveCode = (entry: SdmxEntry | undefined, index: number) => {
      if (!entry || !Array.isArray(entry.values)) return null;
      if (!Number.isInteger(index) || index < 0) return null;
      const value = entry.values[index];
      if (!value) return null;
      return value.id ?? value.name ?? null;
    };
    const entries = Object.entries(observations).slice(0, 10);
    if (entries.length === 0) {
      throw new Error("OECD 조회 결과가 없습니다.");
    }
    const rows = entries.map(([key, rawArr]) => {
      const arr = Array.isArray(rawArr) ? rawArr : [];
      const idxs = key.split(":").map((part) => Number(part));
      const row: unknown[] = [];
      dims.forEach((dim, position) => {
        row.push(resolveCode(dim, idxs[position] ?? -1));
      });
      row.push(arr[0] ?? null);
      attrs.forEach((attr, position) => {
        const valueIndex = arr[position + 1];
        row.push(typeof valueIndex === "number" ? resolveCode(attr, valueIndex) : null);
      });
      return row;
    });
    return { header, rows };
  };
  const buildTabularFromKrxPreview = (raw: unknown) => {
    const toObjectRows = (value: unknown): Array<Record<string, unknown>> => {
      if (value == null) return [];
      if (Array.isArray(value)) {
        return value.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      if (typeof value === "object") {
        return [value as Record<string, unknown>];
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (
          (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) &&
          trimmed.length > 1
        ) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            return toObjectRows(parsed);
          } catch {
            return [];
          }
        }
      }
      return [];
    };
    const findOutBlockRows = (
      value: unknown,
    ): { found: boolean; rows: Array<Record<string, unknown>> } => {
      const rows = toObjectRows(value);
      if (!rows.length) return { found: false, rows: [] };
      for (const row of rows) {
        for (const [key, nested] of Object.entries(row)) {
          const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (normalizedKey === "outblock1") {
            const extracted = toObjectRows(nested);
            return { found: true, rows: extracted };
          }
        }
      }
      for (const row of rows) {
        for (const nested of Object.values(row)) {
          const extracted = findOutBlockRows(nested);
          if (extracted.found) return extracted;
        }
      }
      return { found: false, rows: [] };
    };

    const outBlock = findOutBlockRows(raw);
    if (!outBlock.found) {
      throw new Error("KRX 응답에서 OutBlock_1 데이터를 찾지 못했습니다.");
    }
    if (!outBlock.rows.length) {
      throw new Error("KRX 조회 결과가 없습니다. (휴장일/비영업일일 수 있습니다.)");
    }
    const objectRows = outBlock.rows;
    const header = Array.from(new Set(objectRows.flatMap((row) => Object.keys(row))));
    const rows = objectRows.slice(0, 10).map((row) => header.map((key) => row[key] ?? null));
    return { header, rows };
  };
  const extractKrxOutBlockRows = (raw: unknown): { found: boolean; rows: Array<Record<string, unknown>> } => {
    const toObjectRows = (value: unknown): Array<Record<string, unknown>> => {
      if (value == null) return [];
      if (Array.isArray(value)) {
        return value.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      if (typeof value === "object") {
        return [value as Record<string, unknown>];
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (
          (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) &&
          trimmed.length > 1
        ) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            return toObjectRows(parsed);
          } catch {
            return [];
          }
        }
      }
      return [];
    };
    const walk = (value: unknown): { found: boolean; rows: Array<Record<string, unknown>> } => {
      const rows = toObjectRows(value);
      if (!rows.length) return { found: false, rows: [] };
      for (const row of rows) {
        for (const [key, nested] of Object.entries(row)) {
          const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (normalizedKey === "outblock1") {
            return { found: true, rows: toObjectRows(nested) };
          }
        }
      }
      for (const row of rows) {
        for (const nested of Object.values(row)) {
          const extracted = walk(nested);
          if (extracted.found) return extracted;
        }
      }
      return { found: false, rows: [] };
    };
    return walk(raw);
  };

  const fetchPreviewData = async () => {
    if (!previewUrl) return;
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const provider = normalizeProvider(resolvedSelectedTarget?.provider ?? selectedProvider ?? "");
      if (provider === "yfinance") {
        // yfinance 는 HTTP 직접 호출이 아니라 Python(yfinance) 실행이므로 전용 프리뷰 라우트를 쓴다.
        // 미리보기는 종료일(없으면 오늘) 기준 최근 30일 구간만 조회해 최대 10건을 보여준다.
        const ticker =
          submitParams.find((item) => item.key.trim().toLowerCase() === "ticker")?.value?.trim() ?? "";
        const interval =
          submitParams.find((item) => item.key.trim().toLowerCase() === "interval")?.value?.trim() ||
          "1d";
        const endIso = normalizeIsoDate(endDate) || formatIsoDate(new Date());
        const startBase = new Date(`${endIso}T00:00:00`);
        startBase.setDate(startBase.getDate() - 30);
        const startIso = formatIsoDate(startBase);
        const res = await fetch("/api/ingestion/yfinance-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker, start: startIso, end: endIso, interval }),
        });
        const payload = (await res.json()) as {
          ok?: boolean;
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
          error?: string;
        };
        if (!res.ok || !payload.ok) {
          throw new Error(payload.error || "yfinance 미리보기 조회에 실패했습니다.");
        }
        const rows = payload.rows ?? [];
        if (!rows.length) {
          throw new Error("조회된 시세 데이터가 없습니다. (티커/기간/휴장일 확인)");
        }
        setPreviewHeader(["DATE", "OPEN", "HIGH", "LOW", "CLOSE", "ADJ_CLOSE", "VOLUME", "TICKER"]);
        setPreviewRows(
          rows
            .slice(-10)
            .map((r) => [
              r.date ?? "",
              r.open ?? null,
              r.high ?? null,
              r.low ?? null,
              r.close ?? null,
              r.adj_close ?? null,
              r.volume ?? null,
              r.ticker ?? ticker,
            ]),
        );
        return;
      }
      if (provider === "worldbank") {
        // World Bank 응답은 [메타, [행]] 이고 행이 중첩객체(country/indicator)라 전용 파싱한다.
        const res = await fetch(`/api/collect?url=${encodeURIComponent(previewUrl)}`);
        const payload = (await res.json()) as { ok?: boolean; data?: unknown; error?: string };
        if (!res.ok || !payload.ok) {
          throw new Error(payload.error || "World Bank 미리보기 조회에 실패했습니다.");
        }
        let root: unknown = payload.data;
        if (typeof root === "string") {
          try {
            root = JSON.parse(root);
          } catch {
            root = null;
          }
        }
        const dataArray = Array.isArray(root) && Array.isArray(root[1]) ? (root[1] as unknown[]) : [];
        if (!dataArray.length) {
          throw new Error("조회된 데이터가 없습니다. (국가/지표/연도 범위를 확인하세요)");
        }
        const getField = (row: unknown, key: string) =>
          row && typeof row === "object" ? (row as Record<string, unknown>)[key] : null;
        const getNested = (row: unknown, key: string, sub: string) => {
          const obj = getField(row, key);
          return obj && typeof obj === "object"
            ? ((obj as Record<string, unknown>)[sub] ?? null)
            : null;
        };
        setPreviewHeader(["DATE", "VALUE", "COUNTRY", "COUNTRY_ISO3", "INDICATOR"]);
        setPreviewRows(
          dataArray.slice(0, 10).map((row) => [
            getField(row, "date") ?? "",
            getField(row, "value") ?? null,
            getNested(row, "country", "value") ?? "",
            getField(row, "countryiso3code") ?? "",
            getNested(row, "indicator", "id") ?? "",
          ]),
        );
        return;
      }
      const isKrxProvider = provider === "krx";
      const toCompactYmd = (value: string) => value.replace(/\D/g, "").slice(0, 8);
      const fallbackBasDd = toCompactYmd(endDate || startDate || "");
      const requestedBasDd = toCompactYmd(
        submitParams.find((item) => item.key.trim().toLowerCase() === "basdd")?.value ?? "",
      );
      const initialBasDd = requestedBasDd || fallbackBasDd;
      const response = isKrxProvider
        ? await fetch("/api/collect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: previewUrl.split("?")[0] ?? previewUrl,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                AUTH_KEY: resolvedSelectedTarget?.source.api_key ?? "",
                "X-Auth-Token": resolvedSelectedTarget?.source.api_key ?? "",
              },
              body: {
                basDd: initialBasDd,
              },
            }),
          })
        : provider === "oecd"
          ? // OECD 는 Accept-Language 헤더가 없으면 서버가 500(languageTag) 을 반환하므로
            // 프록시가 헤더를 전달할 수 있도록 POST 로 호출한다.
            await fetch("/api/collect", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: previewUrl,
                method: "GET",
                headers: { "Accept-Language": "en" },
              }),
            })
        : provider === "undp"
          ? // UN /data 엔드포인트는 Authorization: Bearer 토큰이 필수라 프록시가 헤더를
            // 전달할 수 있도록 POST 로 호출한다.
            await fetch("/api/collect", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: previewUrl,
                method: "GET",
                headers: {
                  Accept: "application/json",
                  // 등록된 토큰에 "Bearer " 접두어가 있어도 중복되지 않게 제거한다.
                  Authorization: `Bearer ${(resolvedSelectedTarget?.source.api_key ?? "")
                    .trim()
                    .replace(/^Bearer\s+/i, "")}`,
                },
              }),
            })
        : await fetch(`/api/collect?url=${encodeURIComponent(previewUrl)}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: unknown;
        error?: string;
        contentType?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "데이터 미리보기에 실패했습니다.");
      }
      if (isKrxProvider) {
        const toYmd = (date: Date) =>
          `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
        const start = new Date(`${startDate || endDate}T00:00:00`);
        const end = new Date(`${endDate || startDate}T00:00:00`);
        const hasValidStart = !Number.isNaN(start.getTime());
        const hasValidEnd = !Number.isNaN(end.getTime());
        const startDateObj = hasValidStart ? start : new Date(end);
        const endDateObj = hasValidEnd ? end : new Date(start);
        const minDate = startDateObj <= endDateObj ? startDateObj : endDateObj;
        const maxDate = startDateObj <= endDateObj ? endDateObj : startDateObj;

        const rows: Array<Record<string, unknown>> = [];
        let foundOutBlock = false;
        const firstExtracted = extractKrxOutBlockRows(payload.data);
        foundOutBlock = foundOutBlock || firstExtracted.found;
        rows.push(...firstExtracted.rows);

        const cursor = new Date(maxDate);
        cursor.setDate(cursor.getDate() - 1);
        let guard = 0;
        while (cursor >= minDate && rows.length < 10 && guard < 370) {
          const daily = await fetch("/api/collect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: previewUrl.split("?")[0] ?? previewUrl,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                AUTH_KEY: resolvedSelectedTarget?.source.api_key ?? "",
                "X-Auth-Token": resolvedSelectedTarget?.source.api_key ?? "",
              },
              body: { basDd: toYmd(cursor) },
            }),
          });
          const dailyPayload = (await daily.json()) as {
            ok?: boolean;
            data?: unknown;
            error?: string;
          };
          if (!daily.ok || !dailyPayload.ok) {
            throw new Error(dailyPayload.error || "데이터 미리보기에 실패했습니다.");
          }
          const extracted = extractKrxOutBlockRows(dailyPayload.data);
          foundOutBlock = foundOutBlock || extracted.found;
          rows.push(...extracted.rows);
          cursor.setDate(cursor.getDate() - 1);
          guard += 1;
        }
        if (!foundOutBlock) {
          throw new Error("KRX 응답에서 OutBlock_1 데이터를 찾지 못했습니다.");
        }
        if (!rows.length) {
          throw new Error("KRX 조회 결과가 없습니다. (휴장일/비영업일일 수 있습니다.)");
        }
        const header = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
        const previewRows = rows.slice(0, 10).map((row) => header.map((key) => row[key] ?? null));
        setPreviewHeader(header);
        setPreviewRows(previewRows);
        return;
      }
      const isSpcdePreview =
        provider === "datagokr" &&
        submitParams.some(
          (item) => item.location === "path" && /spcdeinfoservice/i.test(item.value),
        );
      if (isSpcdePreview) {
        // 특일정보: 시작월 응답(이미 받은 payload)부터 시작해, 약 10건이 모일 때까지 다음 달로 넘어가며 누적.
        const startD = new Date(`${startDate || endDate}T00:00:00`);
        const endD = new Date(`${endDate || startDate}T00:00:00`);
        const a = Number.isNaN(startD.getTime()) ? endD : startD;
        const b = Number.isNaN(endD.getTime()) ? startD : endD;
        const minD = a <= b ? a : b;
        const maxD = a <= b ? b : a;
        const lastMonth = new Date(maxD.getFullYear(), maxD.getMonth(), 1);
        const cursor = new Date(minD.getFullYear(), minD.getMonth(), 1);
        const collected: Array<Record<string, string>> = [];
        collected.push(...extractDatagokrItemRows(payload.data));
        cursor.setMonth(cursor.getMonth() + 1);
        let guard = 0;
        while (cursor <= lastMonth && collected.length < 10 && guard < 600) {
          const solYear = String(cursor.getFullYear());
          const solMonth = pad(cursor.getMonth() + 1);
          const monthUrl = previewUrl
            .replace(/([?&]solYear=)[^&]*/i, `$1${solYear}`)
            .replace(/([?&]solMonth=)[^&]*/i, `$1${solMonth}`);
          const monthResponse = await fetch(`/api/collect?url=${encodeURIComponent(monthUrl)}`);
          const monthPayload = (await monthResponse.json()) as {
            ok?: boolean;
            data?: unknown;
            error?: string;
          };
          if (!monthResponse.ok || !monthPayload.ok) {
            throw new Error(monthPayload.error || "데이터 미리보기에 실패했습니다.");
          }
          collected.push(...extractDatagokrItemRows(monthPayload.data));
          cursor.setMonth(cursor.getMonth() + 1);
          guard += 1;
        }
        if (!collected.length) {
          throw new Error("조회 기간 내 특일정보가 없습니다.");
        }
        const header = Array.from(new Set(collected.flatMap((row) => Object.keys(row))));
        const rows = collected.slice(0, 10).map((row) => header.map((key) => row[key] ?? ""));
        setPreviewHeader(header);
        setPreviewRows(rows);
        return;
      }
      const tabular =
        provider === "krx"
          ? buildTabularFromKrxPreview(payload.data)
          : provider === "datagokr"
          ? buildTabularFromDatagokrXml(payload.data, payload.contentType)
          : provider === "fred"
            ? buildTabularFromFredPreview(payload.data)
          : provider === "oecd"
            ? buildTabularFromOecdPreview(payload.data)
          : buildTabularFromJsonPreview(payload.data);
      setPreviewHeader(tabular.header);
      setPreviewRows(tabular.rows);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "데이터 미리보기에 실패했습니다.";
      setPreviewError(message);
      setPreviewHeader([]);
      setPreviewRows([]);
    } finally {
      setPreviewLoading(false);
    }
  };
  const copyPreviewUrl = async () => {
    if (!previewUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(previewUrl);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = previewUrl;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copied) {
          throw new Error("복사 실패");
        }
      }
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1500);
    } catch {
      setUrlCopied(false);
    }
  };

  const renderBokTreeNodes = (nodes: BokTreeNode[], depth = 0) => {
    return nodes.flatMap((node) => {
      const expanded = bokExpanded.has(node.stat_code);
      const hasChildren = node.children.length > 0;
      const isSelected = bokSelectedStatCode === node.stat_code;
      const clickableClass = "cursor-pointer hover:border-slate-300";
      const row = (
        <div
          key={node.stat_code}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (hasChildren && !node.selectable) {
                toggleBokNode(node.stat_code);
                return;
              }
              if (node.selectable) setBokSelectedStatCode(node.stat_code);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {hasChildren ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                node.selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{node.stat_name}</p>
              <p className="text-[11px] opacity-80">
                코드 {node.stat_code}
                {node.cycle ? ` / 주기 ${node.cycle}` : ""}
                {node.selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {hasChildren && expanded ? (
            <div className={`space-y-2 border-t px-2 pb-2 pt-2 ${isSelected ? "border-white/20" : "border-slate-100"}`}>
              <div className="space-y-2 pl-3">
                {renderBokTreeNodes(node.children, depth + 1)}
              </div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };
  const renderKosisTreeNodes = (nodes: KosisStatItem[]) => {
    return nodes.flatMap((node) => {
      const expanded = kosisExpanded.has(node.node_id);
      const selectable = node.srch_yn.trim().toUpperCase() === "Y";
      const canExpand = !selectable;
      const isSelected = kosisSelectedNodeId === node.node_id;
      const childKey = kosisParentKey(node.stat_code, node.vw_cd);
      const childNodes = kosisChildrenByParent.get(childKey) ?? [];
      const loadingChildren = kosisLoadingParentKeys.has(childKey);
      const clickableClass = "cursor-pointer hover:border-slate-300";
      const row = (
        <div
          key={node.node_id}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (canExpand) {
                void toggleKosisNode(node);
                return;
              }
              setKosisSelectedNodeId(node.node_id);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {canExpand ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{kosisDisplayLabel(node)}</p>
              <p className="text-[11px] opacity-80">
                코드 {node.stat_code}
                {node.vw_cd ? ` / 뷰 ${node.vw_cd}` : ""}
                {selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {canExpand && expanded ? (
            <div
              className={`space-y-2 border-t px-2 pb-2 pt-2 ${
                isSelected ? "border-white/20" : "border-slate-100"
              }`}
            >
              <div className="space-y-2 pl-3">
                {loadingChildren ? (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목을 불러오는 중입니다...</p>
                ) : childNodes.length > 0 ? (
                  renderKosisTreeNodes(childNodes)
                ) : (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목이 없습니다.</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };
  const renderDatagokrTreeNodes = (nodes: DatagokrTreeNode[]) => {
    return nodes.flatMap((node) => {
      const expanded = datagokrExpanded.has(node.stat_code);
      const hasChildren = node.children.length > 0;
      const isSelected = datagokrSelectedStatCode === node.stat_code;
      const clickableClass = "cursor-pointer hover:border-slate-300";
      const row = (
        <div
          key={node.stat_code}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (hasChildren && !node.selectable) {
                toggleDatagokrNode(node.stat_code);
                return;
              }
              if (node.selectable) setDatagokrSelectedStatCode(node.stat_code);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {hasChildren ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                node.selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{node.stat_name}</p>
              <p className="text-[11px] opacity-80">
                코드 {node.stat_code}
                {node.org_name ? ` / 기관 ${node.org_name}` : ""}
                {node.selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {hasChildren && expanded ? (
            <div
              className={`space-y-2 border-t px-2 pb-2 pt-2 ${
                isSelected ? "border-white/20" : "border-slate-100"
              }`}
            >
              <div className="space-y-2 pl-3">{renderDatagokrTreeNodes(node.children)}</div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };
  const renderFredTreeNodes = (nodes: FredTreeNode[]) => {
    return nodes.flatMap((node) => {
      const nodeId = node.node_id;
      const expanded = fredExpanded.has(nodeId);
      const isSelected = fredSelectedNodeId === nodeId;
      const clickableClass = "cursor-pointer hover:border-slate-300";
      // FRED의 category leaf_yn='Y'는 "하위 카테고리 없음" 의미일 수 있고,
      // 실제 SERIES 자식은 존재할 수 있으므로 확장 가능 여부는 selectable 여부로만 판단합니다.
      const canExpand = !node.selectable;
      const loadingChildren = fredLoadingParentKeys.has(nodeId);
      const children = fredChildrenByParent[nodeId] ?? [];
      const row = (
        <div
          key={nodeId}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (node.selectable) {
                setFredSelectedNodeId(nodeId);
                setFredSelectedStat(node);
                return;
              }
              if (canExpand) void toggleFredNode(node);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {canExpand ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                node.selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{node.node_name}</p>
              <p className="text-[11px] opacity-80">
                {node.stat_code ? `코드 ${node.stat_code}` : "카테고리"}
                {node.cycle ? ` / 주기 ${node.cycle}` : ""}
                {node.selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {canExpand && expanded ? (
            <div
              className={`space-y-2 border-t px-2 pb-2 pt-2 ${
                isSelected ? "border-white/20" : "border-slate-100"
              }`}
            >
              <div className="space-y-2 pl-3">
                {loadingChildren ? (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목을 불러오는 중입니다...</p>
                ) : children.length > 0 ? (
                  renderFredTreeNodes(children)
                ) : (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목이 없습니다.</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/45 p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-2">
            {step !== "org" && !done ? (
              <button
                onClick={goBack}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                ← 뒤로
              </button>
            ) : null}
            <h3 className="text-base font-semibold text-slate-900">API 등록</h3>
          </div>
          <button
            onClick={handleClose}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            닫기
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {currentStepLabels.map((item, index) => {
              const active = index === activeStepIndex && !done;
              const doneStep = index < activeStepIndex || done;
              return (
                <div
                  key={item.key}
                  className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                    active
                      ? "bg-slate-900 text-white"
                      : doneStep
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {item.label}
                </div>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {done ? (
            <div className="space-y-6 py-8">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">등록이 완료되었습니다</h4>
                <p className="mt-2 text-sm text-slate-600">
                  선택한 조건으로 API 수집 설정이 저장되었습니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p>
                  API 명: <span className="font-semibold">{apiGroupName || "-"}</span>
                </p>
                <p>
                  기관:{" "}
                  {ORG_CATALOG.find((item) => item.provider === selectedProvider)?.name ??
                    "-"}
                </p>
                <p>수집대상: {resolvedSelectedTarget?.title ?? "-"}</p>
                {selectedKosisStat ? (
                  <>
                    <p>통계표 코드: {selectedKosisStat.stat_code}</p>
                    <p>경로: {selectedKosisStat.full_path || "-"}</p>
                  </>
                ) : null}
                {selectedDatagokrStat ? (
                  <>
                    <p>API 코드: {selectedDatagokrStat.stat_code}</p>
                    <p>API 서비스명: {datagokrApiServiceName || "-"}</p>
                    <p>상세 기능명: {datagokrFunctionName || "-"}</p>
                    <p>안내 페이지: {selectedDatagokrStat.list_url || "-"}</p>
                  </>
                ) : null}
                {selectedFredStat ? (
                  <>
                    <p>시리즈 코드(series_id): {selectedFredStat.stat_code || "-"}</p>
                    <p>주기(frequency): {(selectedFredStat.cycle ?? "").toLowerCase() || "-"}</p>
                  </>
                ) : null}
                {selectedKrxStat ? (
                  <>
                    <p>
                      <span className="font-semibold">API ID:</span> {selectedKrxStat.api_id}
                    </p>
                    <p>
                      <span className="font-semibold">카테고리:</span> {selectedKrxStat.category_name}
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> {selectedKrxStat.cycle || "-"}
                    </p>
                  </>
                ) : null}
                <p>
                  기간: {startDate || "-"} ~ {endDate || "-"}
                </p>
                <div className="mt-2">
                  {selectedProvider === "yfinance" ? (
                    <>
                      <p className="font-semibold">수집 방식:</p>
                      <p className="mt-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                        Python(yfinance)으로 티커·기간을 조회해 수집합니다. 별도의 호출 URL이 없습니다.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold">생성 URL:</p>
                      <p className="mt-1 break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                        {previewUrl || "URL을 생성할 수 없습니다."}
                      </p>
                    </>
                  )}
                </div>
              </div>
              <div className="flex justify-end">
                {selectedProvider === "yfinance" ? null : (
                  <button
                    type="button"
                    onClick={() => void copyPreviewUrl()}
                    disabled={!previewUrl}
                    className="mr-2 rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {urlCopied ? "복사됨" : "URL 복사"}
                  </button>
                )}
                <button
                  onClick={handleClose}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  닫기
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "org" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">기관을 선택해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  가져오려는 데이터가 속한 기관을 선택하면 다음 단계로 이동합니다.
                </p>
              </div>
              <input
                value={orgQuery}
                onChange={(event) => setOrgQuery(event.target.value)}
                placeholder="기관명으로 검색"
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                {visibleOrgs.map((org) => {
                  const count = providerGroups.get(org.provider) ?? 0;
                  // OECD/yfinance/World Bank 는 카탈로그 템플릿 없이 소스를 즉석 합성하므로 항상 선택 가능.
                  // UN 은 기관 관리에서 토큰을 등록한 소스가 있어야 선택 가능하다.
                  const disabled =
                    org.provider === "oecd" ||
                    org.provider === "yfinance" ||
                    org.provider === "worldbank"
                      ? false
                      : org.provider === "undp"
                        ? !undpRegisteredSource
                        : count === 0;
                  const selected = selectedProvider === org.provider;
                  return (
                    <button
                      key={org.provider}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setSelectedProvider(org.provider);
                        setSelectedTargetKey(null);
                        setBokSelectedStatCode(null);
                        setKosisSelectedNodeId(null);
                        setTargetQuery("");
                        setBokAppliedQuery("");
                        setBokExpanded(new Set());
                        setKrxAppliedQuery("");
                        setKrxExpandedCategories(new Set());
                        setKrxSelectedApiId(null);
                        setKrxApiApplied(false);
                        setKosisAppliedQuery("");
                        setKosisExpanded(new Set());
                        setKosisSearchResults([]);
                        setDatagokrAppliedQuery("");
                        setDatagokrSearchResults([]);
                        setDatagokrSelectedStatCode(null);
                        setDatagokrExpanded(new Set());
                        setDatagokrApiServiceName("");
                        setDatagokrFunctionName("");
                        setFredAppliedQuery("");
                        setFredSearchResults([]);
                        setFredSelectedNodeId(null);
                        setFredSelectedStat(null);
                        setFredExpanded(new Set());
                        setFredRoots([]);
                        setFredChildrenByParent({});
                        setFredLoadedParentKeys(new Set());
                        setFredLoadingParentKeys(new Set());
                        setFredLoadingRoots(false);
                        setFredLoadingSearch(false);
                        setOecdStats([]);
                        setOecdLoading(false);
                        setOecdError("");
                        setOecdAppliedQuery("");
                        setOecdExpandedCategories(new Set());
                        setOecdSelectedId(null);
                        setYfinanceAppliedQuery("");
                        setYfinanceExpandedCategories(new Set());
                        setYfinanceSelectedTicker(null);
                        setWorldbankAppliedQuery("");
                        setWorldbankExpandedCategories(new Set());
                        setWorldbankSelectedId(null);
                        setUndpIndicatorQuery("");
                        setUndpLocationQuery("");
                        setUndpSelectedIndicatorId(null);
                        setUndpSelectedLocationId(null);
                        setUndpExpandedTopics(new Set());
                      }}
                      className={`rounded-2xl border p-4 text-left transition ${
                        selected
                          ? "border-slate-900 bg-slate-900 text-white"
                          : disabled
                            ? "border-slate-200 bg-slate-50 text-slate-400"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                      }`}
                    >
                      <p className="text-base font-semibold">{org.name}</p>
                      <p className="mt-1 text-xs opacity-80">{org.description}</p>
                      <p className="mt-3 text-[11px] opacity-80">
                        {org.provider === "oecd"
                          ? "핵심 경제지표 목록"
                          : org.provider === "undp"
                            ? undpRegisteredSource
                              ? "세계 인구 통계 목록"
                              : "기관 관리에서 토큰 등록이 필요합니다."
                          : disabled
                            ? "등록 가능한 수집대상이 없습니다."
                            : `${count}개 수집대상`}
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("target")}
                  disabled={!canGoNextFromOrg}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "target" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">가져올 데이터를 선택해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  이름 중심으로 수집대상을 찾고 선택할 수 있습니다.
                </p>
              </div>
              {selectedProvider === "bok" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runBokSearch();
                        }
                      }}
                      placeholder="통계표명 또는 통계표 코드로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runBokSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetBokSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {bokAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{bokAppliedQuery}&quot; — 선택 가능한 통계표만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 눌러 펼쳐보세요.
                    </p>
                  )}
                  {bokLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      한국은행 통계표 목록을 불러오는 중입니다...
                    </p>
                  ) : bokError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {bokError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {bokAppliedQuery ? (
                        bokSearchResults.length > 0 ? (
                          bokSearchResults.map((item) => {
                            const selected = bokSelectedStatCode === item.stat_code;
                            return (
                              <button
                                key={item.stat_code}
                                type="button"
                                onClick={() => setBokSelectedStatCode(item.stat_code)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.stat_name}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code}
                                  {item.cycle ? ` / 주기 ${item.cycle}` : ""}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : bokTreeRoots.length > 0 ? (
                        renderBokTreeNodes(bokTreeRoots)
                      ) : (
                        <p className="px-2 py-4 text-sm text-slate-500">
                          통계표 목록이 없습니다.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 통계표:{" "}
                    {selectedBokStat
                      ? `${selectedBokStat.stat_name} (${selectedBokStat.stat_code})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "kosis" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runKosisSearch();
                        }
                      }}
                      placeholder="표시명(번호·이름) 또는 통계표 코드로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runKosisSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetKosisSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {kosisAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{kosisAppliedQuery}&quot; 결과를 최대 100건까지 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 누르면 해당 하위 노드만 지연 로딩됩니다.
                    </p>
                  )}
                  {kosisLoading || kosisSearchLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      {kosisSearchLoading
                        ? "통계청 검색 결과를 불러오는 중입니다..."
                        : "통계청 루트 목록을 불러오는 중입니다..."}
                    </p>
                  ) : kosisError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {kosisError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {kosisAppliedQuery ? (
                        kosisSearchResults.length > 0 ? (
                          kosisSearchResults.map((item) => {
                            const selectable = item.srch_yn.trim().toUpperCase() === "Y";
                            const selected = kosisSelectedNodeId === item.node_id;
                            return (
                              <button
                                key={item.node_id}
                                type="button"
                                onClick={() => {
                                  if (selectable) setKosisSelectedNodeId(item.node_id);
                                }}
                                className={`w-full rounded-xl border px-3 py-2 text-left ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                } ${selectable ? "hover:border-slate-300" : "cursor-not-allowed opacity-70"}`}
                              >
                                <p className="text-sm font-semibold">{kosisDisplayLabel(item)}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code}
                                  {item.vw_cd ? ` / 뷰 ${item.vw_cd}` : ""}
                                  {selectable ? " / 선택 가능" : " / 분류"}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : kosisRootNodes.length > 0 ? (
                        renderKosisTreeNodes(kosisRootNodes)
                      ) : (
                        <p className="px-2 py-4 text-sm text-slate-500">
                          통계청 수집대상 목록이 없습니다.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedKosisStat
                      ? `${kosisDisplayLabel(selectedKosisStat)} (${selectedKosisStat.stat_code})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "datagokr" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void runDatagokrSearch();
                        }
                      }}
                      placeholder="API명 또는 코드, 기관명으로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => void runDatagokrSearch()}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={() => void resetDatagokrSearch()}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {datagokrAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{datagokrAppliedQuery}&quot; 결과를 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 눌러 펼쳐보세요.
                    </p>
                  )}
                  {datagokrLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      공공데이터포털 수집대상을 불러오는 중입니다...
                    </p>
                  ) : datagokrError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {datagokrError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {datagokrAppliedQuery ? (
                        datagokrSearchResults.length > 0 ? (
                          datagokrSearchResults.map((item) => {
                            const selected = datagokrSelectedStatCode === item.stat_code;
                            return (
                              <button
                                key={item.stat_code}
                                type="button"
                                onClick={() => setDatagokrSelectedStatCode(item.stat_code)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.stat_name}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code}
                                  {item.org_name ? ` / 기관 ${item.org_name}` : ""}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : datagokrTreeRoots.length > 0 ? (
                        renderDatagokrTreeNodes(datagokrTreeRoots)
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedDatagokrStat
                      ? `${selectedDatagokrStat.stat_name} (${selectedDatagokrStat.stat_code})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "fred" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runFredSearch();
                        }
                      }}
                      placeholder="시리즈명 또는 시리즈 코드로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runFredSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetFredSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {fredAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{fredAppliedQuery}&quot; — 선택 가능한 시리즈만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 카테고리 카드를 눌러 펼쳐보세요.
                    </p>
                  )}
                  {fredLoadingRoots || fredLoadingSearch ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      FRED 수집대상을 불러오는 중입니다...
                    </p>
                  ) : fredError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {fredError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {fredAppliedQuery ? (
                        fredSearchResults.length > 0 ? (
                          fredSearchResults.map((item) => {
                            const selected = fredSelectedNodeId === item.node_id;
                            return (
                              <button
                                key={item.node_id}
                                type="button"
                                onClick={() => {
                                  setFredSelectedNodeId(item.node_id);
                                  setFredSelectedStat(item);
                                }}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.node_name}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code || "-"}
                                  {item.cycle ? ` / 주기 ${item.cycle}` : ""}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : fredTreeRoots.length > 0 ? (
                        renderFredTreeNodes(fredTreeRoots)
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 시리즈:{" "}
                    {selectedFredStat
                      ? `${selectedFredStat.node_name} (${selectedFredStat.stat_code || "-"}) / 주기 ${
                          selectedFredStat.cycle || "-"
                        }`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "krx" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runKrxSearch();
                        }
                      }}
                      placeholder="카테고리/API명/API ID 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runKrxSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetKrxSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {krxAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{krxAppliedQuery}&quot; — 선택 가능한 API만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 카테고리 카드를 눌러 펼쳐보세요.
                    </p>
                  )}
                  {krxLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      KRX API 목록을 불러오는 중입니다...
                    </p>
                  ) : krxError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {krxError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {krxAppliedQuery ? (
                        krxSearchResults.length > 0 ? (
                          krxSearchResults.map((item) => {
                            const selected = krxSelectedApiId === item.api_id;
                            return (
                              <button
                                key={item.api_id}
                                type="button"
                                onClick={() => setKrxSelectedApiId(item.api_id)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">
                                  {formatKrxOrderLabel(item)}. {item.api_name}
                                </p>
                                <p className="text-[11px] opacity-80">
                                  {item.category_name} / API ID {item.api_id}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : krxCategoryGroups.length > 0 ? (
                        krxCategoryGroups.map(([category, items]) => {
                          const expanded = krxExpandedCategories.has(category);
                          const categoryLabel = formatKrxCategoryLabel(items[0]);
                          return (
                            <div key={category} className="rounded-xl border border-slate-200 bg-white">
                              <button
                                type="button"
                                onClick={() => toggleKrxCategory(category)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:border-slate-300"
                              >
                                <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                  {expanded ? "접기" : "펼치기"}
                                </span>
                                <span className="flex-1 text-slate-800">
                                  <p className="text-sm font-semibold">{categoryLabel || category}</p>
                                  <p className="text-[11px] opacity-80">분류 / {items.length}개 API</p>
                                </span>
                              </button>
                              {expanded ? (
                                <div className="space-y-2 border-t border-slate-100 px-2 pb-2 pt-2">
                                  <div className="space-y-2 pl-3">
                                    {items.map((item) => {
                                      const selected = krxSelectedApiId === item.api_id;
                                      return (
                                        <button
                                          key={item.api_id}
                                          type="button"
                                          onClick={() => setKrxSelectedApiId(item.api_id)}
                                          className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                            selected
                                              ? "border-slate-900 bg-slate-900 text-white"
                                              : "border-slate-200 bg-white text-slate-700"
                                          }`}
                                        >
                                          <p className="text-sm font-semibold">
                                            {formatKrxOrderLabel(item)}. {item.api_name}
                                          </p>
                                          <p className="text-[11px] opacity-80">API ID {item.api_id}</p>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedKrxStat
                      ? `${selectedKrxStat.api_name} (${selectedKrxStat.api_id})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "oecd" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runOecdSearch();
                        }
                      }}
                      placeholder="지표명/지역/데이터플로우 검색 (예: 경기선행, G20, CLI)"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runOecdSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetOecdSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {oecdAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{oecdAppliedQuery}&quot; — 선택 가능한 지표만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 눌러 지표를 펼쳐보세요.
                    </p>
                  )}
                  {oecdLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      OECD 지표 목록을 불러오는 중입니다...
                    </p>
                  ) : oecdError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {oecdError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {oecdAppliedQuery ? (
                        oecdSearchResults.length > 0 ? (
                          oecdSearchResults.map((item) => {
                            const selected = oecdSelectedId === item.id;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => setOecdSelectedId(item.id)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.indicator_name}</p>
                                <p className="text-[11px] opacity-80">
                                  {item.category_name} / {item.ref_area} / {item.data_key}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : oecdCategoryGroups.length > 0 ? (
                        oecdCategoryGroups.map(([category, items]) => {
                          const expanded = oecdExpandedCategories.has(category);
                          return (
                            <div key={category} className="rounded-xl border border-slate-200 bg-white">
                              <button
                                type="button"
                                onClick={() => toggleOecdCategory(category)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:border-slate-300"
                              >
                                <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                  {expanded ? "접기" : "펼치기"}
                                </span>
                                <span className="flex-1 text-slate-800">
                                  <p className="text-sm font-semibold">{category}</p>
                                  <p className="text-[11px] opacity-80">분류 / {items.length}개 지표</p>
                                </span>
                              </button>
                              {expanded ? (
                                <div className="space-y-2 border-t border-slate-100 px-2 pb-2 pt-2">
                                  <div className="space-y-2 pl-3">
                                    {items.map((item) => {
                                      const selected = oecdSelectedId === item.id;
                                      return (
                                        <button
                                          key={item.id}
                                          type="button"
                                          onClick={() => setOecdSelectedId(item.id)}
                                          className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                            selected
                                              ? "border-slate-900 bg-slate-900 text-white"
                                              : "border-slate-200 bg-white text-slate-700"
                                          }`}
                                        >
                                          <p className="text-sm font-semibold">{item.indicator_name}</p>
                                          <p className="text-[11px] opacity-80">
                                            {item.ref_area} / {item.data_key}
                                          </p>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedOecdStat
                      ? `${selectedOecdStat.indicator_name} (${selectedOecdStat.data_key})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "yfinance" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runYfinanceSearch();
                        }
                      }}
                      placeholder="티커/종목명/분류 검색 (예: S&P, DX-Y, 금)"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runYfinanceSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetYfinanceSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {yfinanceAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{yfinanceAppliedQuery}&quot; — 일치하는 티커만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 눌러 티커를 펼쳐보세요.
                    </p>
                  )}
                  {yfinanceLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      yfinance 티커 목록을 불러오는 중입니다...
                    </p>
                  ) : yfinanceError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {yfinanceError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {yfinanceAppliedQuery ? (
                        yfinanceSearchResults.length > 0 ? (
                          yfinanceSearchResults.map((item) => {
                            const selected = yfinanceSelectedTicker === item.ticker;
                            return (
                              <button
                                key={item.ticker}
                                type="button"
                                onClick={() => setYfinanceSelectedTicker(item.ticker)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.item_name}</p>
                                <p className="text-[11px] opacity-80">
                                  {item.category_name} / {item.ticker}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : yfinanceCategoryGroups.length > 0 ? (
                        yfinanceCategoryGroups.map(([category, items]) => {
                          const expanded = yfinanceExpandedCategories.has(category);
                          return (
                            <div key={category} className="rounded-xl border border-slate-200 bg-white">
                              <button
                                type="button"
                                onClick={() => toggleYfinanceCategory(category)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:border-slate-300"
                              >
                                <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                  {expanded ? "접기" : "펼치기"}
                                </span>
                                <span className="flex-1 text-slate-800">
                                  <p className="text-sm font-semibold">{category}</p>
                                  <p className="text-[11px] opacity-80">분류 / {items.length}개 티커</p>
                                </span>
                              </button>
                              {expanded ? (
                                <div className="space-y-2 border-t border-slate-100 px-2 pb-2 pt-2">
                                  <div className="space-y-2 pl-3">
                                    {items.map((item) => {
                                      const selected = yfinanceSelectedTicker === item.ticker;
                                      return (
                                        <button
                                          key={item.ticker}
                                          type="button"
                                          onClick={() => setYfinanceSelectedTicker(item.ticker)}
                                          className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                            selected
                                              ? "border-slate-900 bg-slate-900 text-white"
                                              : "border-slate-200 bg-white text-slate-700"
                                          }`}
                                        >
                                          <p className="text-sm font-semibold">{item.item_name}</p>
                                          <p className="text-[11px] opacity-80">{item.ticker}</p>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedYfinanceStat
                      ? `${selectedYfinanceStat.item_name} (${selectedYfinanceStat.ticker})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "worldbank" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runWorldbankSearch();
                        }
                      }}
                      placeholder="지표/국가 검색 (예: GDP, 미국, 세계)"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runWorldbankSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetWorldbankSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {worldbankAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{worldbankAppliedQuery}&quot; — 일치하는 항목만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 눌러 지표를 펼쳐보세요.
                    </p>
                  )}
                  {worldbankLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      World Bank 지표 목록을 불러오는 중입니다...
                    </p>
                  ) : worldbankError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {worldbankError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {worldbankAppliedQuery ? (
                        worldbankSearchResults.length > 0 ? (
                          worldbankSearchResults.map((item) => {
                            const selected = worldbankSelectedId === item.id;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => setWorldbankSelectedId(item.id)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.item_name}</p>
                                <p className="text-[11px] opacity-80">
                                  {item.country_name} / {item.indicator_code}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : worldbankCategoryGroups.length > 0 ? (
                        worldbankCategoryGroups.map(([category, items]) => {
                          const expanded = worldbankExpandedCategories.has(category);
                          return (
                            <div key={category} className="rounded-xl border border-slate-200 bg-white">
                              <button
                                type="button"
                                onClick={() => toggleWorldbankCategory(category)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:border-slate-300"
                              >
                                <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                  {expanded ? "접기" : "펼치기"}
                                </span>
                                <span className="flex-1 text-slate-800">
                                  <p className="text-sm font-semibold">{category}</p>
                                  <p className="text-[11px] opacity-80">분류 / {items.length}개 지표</p>
                                </span>
                              </button>
                              {expanded ? (
                                <div className="space-y-2 border-t border-slate-100 px-2 pb-2 pt-2">
                                  <div className="space-y-2 pl-3">
                                    {items.map((item) => {
                                      const selected = worldbankSelectedId === item.id;
                                      return (
                                        <button
                                          key={item.id}
                                          type="button"
                                          onClick={() => setWorldbankSelectedId(item.id)}
                                          className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                            selected
                                              ? "border-slate-900 bg-slate-900 text-white"
                                              : "border-slate-200 bg-white text-slate-700"
                                          }`}
                                        >
                                          <p className="text-sm font-semibold">{item.item_name}</p>
                                          <p className="text-[11px] opacity-80">
                                            {item.country_name} ({item.country_code}) / {item.indicator_code}
                                          </p>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedWorldbankStat
                      ? `${selectedWorldbankStat.item_name} (${selectedWorldbankStat.country_code} / ${selectedWorldbankStat.indicator_code})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "undp" ? (
                <div className="space-y-4">
                  {!undpRegisteredSource ? (
                    <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                      먼저 기관 관리에서 UN Population Division 기관(기관식별자 undp)을 발급받은
                      토큰과 함께 등록해주세요.
                    </p>
                  ) : null}
                  {undpLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      UN 지표/지역 목록을 불러오는 중입니다...
                    </p>
                  ) : undpError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {undpError}
                    </p>
                  ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="space-y-2">
                        <p className="text-sm font-semibold text-slate-800">1) 지표 선택</p>
                        <input
                          value={undpIndicatorQuery}
                          onChange={(event) => setUndpIndicatorQuery(event.target.value)}
                          placeholder="지표명 검색 (예: population, births)"
                          className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                        />
                        <div className="max-h-[38vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                          {undpIndicatorQuery.trim() ? (
                            undpIndicatorSearchResults.length > 0 ? (
                              undpIndicatorSearchResults.map((item) => {
                                const selected = undpSelectedIndicatorId === item.id;
                                return (
                                  <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => setUndpSelectedIndicatorId(item.id)}
                                    className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                      selected
                                        ? "border-slate-900 bg-slate-900 text-white"
                                        : "border-slate-200 bg-white text-slate-700"
                                    }`}
                                  >
                                    <p className="text-sm font-semibold">{item.name}</p>
                                    <p className="text-[11px] opacity-80">{item.topic_name}</p>
                                  </button>
                                );
                              })
                            ) : (
                              <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                            )
                          ) : undpIndicatorTopics.length > 0 ? (
                            undpIndicatorTopics.map(([topic, items]) => {
                              const expanded = undpExpandedTopics.has(topic);
                              return (
                                <div key={topic} className="rounded-xl border border-slate-200 bg-white">
                                  <button
                                    type="button"
                                    onClick={() => toggleUndpTopic(topic)}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:border-slate-300"
                                  >
                                    <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                      {expanded ? "접기" : "펼치기"}
                                    </span>
                                    <span className="flex-1 text-slate-800">
                                      <span className="block text-sm font-semibold">{topic}</span>
                                      <span className="block text-[11px] opacity-80">
                                        {items.length}개 지표
                                      </span>
                                    </span>
                                  </button>
                                  {expanded ? (
                                    <div className="space-y-2 border-t border-slate-100 px-2 pb-2 pt-2">
                                      {items.map((item) => {
                                        const selected = undpSelectedIndicatorId === item.id;
                                        return (
                                          <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => setUndpSelectedIndicatorId(item.id)}
                                            className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                              selected
                                                ? "border-slate-900 bg-slate-900 text-white"
                                                : "border-slate-200 bg-white text-slate-700"
                                            }`}
                                          >
                                            <p className="text-sm font-semibold">{item.name}</p>
                                          </button>
                                        );
                                      })}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })
                          ) : (
                            <p className="px-2 py-2 text-sm text-slate-500">지표 목록이 없습니다.</p>
                          )}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <p className="text-sm font-semibold text-slate-800">2) 지역 선택</p>
                        <input
                          value={undpLocationQuery}
                          onChange={(event) => setUndpLocationQuery(event.target.value)}
                          placeholder="국가/지역 검색 (예: Korea, KOR, World)"
                          className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                        />
                        <div className="max-h-[38vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                          {undpLocationResults.length > 0 ? (
                            undpLocationResults.map((item) => {
                              const selected = undpSelectedLocationId === item.id;
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  onClick={() => setUndpSelectedLocationId(item.id)}
                                  className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                    selected
                                      ? "border-slate-900 bg-slate-900 text-white"
                                      : "border-slate-200 bg-white text-slate-700"
                                  }`}
                                >
                                  <p className="text-sm font-semibold">{item.name}</p>
                                  <p className="text-[11px] opacity-80">
                                    {item.iso3 || "-"} · ID {item.id}
                                  </p>
                                </button>
                              );
                            })
                          ) : (
                            <p className="px-2 py-2 text-sm text-slate-500">지역 검색 결과가 없습니다.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedUndpIndicator && selectedUndpLocation
                      ? `${selectedUndpIndicator.name} / ${selectedUndpLocation.name}`
                      : "지표와 지역을 모두 선택해주세요."}
                  </div>
                </div>
              ) : (
                <>
                  <input
                    value={targetQuery}
                    onChange={(event) => setTargetQuery(event.target.value)}
                    placeholder="수집대상명으로 검색"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                  />
                  <div className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
                    {targetItems.map((item) => {
                      const selected = selectedTargetKey === item.key;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => setSelectedTargetKey(item.key)}
                          className={`w-full rounded-2xl border p-4 text-left transition ${
                            selected
                              ? "border-slate-900 bg-slate-900 text-white"
                              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                          }`}
                        >
                          <p className="text-base font-semibold">{item.title}</p>
                          <p className="mt-1 text-xs opacity-80">{item.description}</p>
                          <div className="mt-3 flex flex-wrap gap-2 text-[11px] opacity-80">
                            <span className="rounded-full border px-2 py-0.5">{item.typeLabel}</span>
                            <span className="rounded-full border px-2 py-0.5">{item.statusLabel}</span>
                            <span className="rounded-full border px-2 py-0.5">{item.codeHint}</span>
                          </div>
                        </button>
                      );
                    })}
                    {targetItems.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                        선택 가능한 수집대상이 없습니다.
                      </p>
                    ) : null}
                  </div>
                </>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() =>
                    setStep(
                      selectedProvider === "kosis"
                        ? "kosisUserStats"
                        : selectedProvider === "datagokr"
                          ? "datagokrSpec"
                        : selectedProvider === "krx"
                          ? "krxApiApply"
                        : selectedProvider === "fred"
                          ? "period"
                        : "period",
                    )
                  }
                  disabled={!canGoNextFromTarget}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "kosisUserStats" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">userStatsId를 입력해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  통계청(KOSIS)에서 활용신청한 사용자 등록 통계표 ID가 필요합니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                <p>선택한 통계표에 대해 아직 활용신청을 하지 않았다면 먼저 신청이 필요합니다.</p>
                <p className="mt-2">
                  KOSIS 공유서비스 &gt; 개발 가이드 &gt; 통계자료 &gt; URL 생성 &gt; 자료등록
                  &gt; 통계표명 또는 통계표ID 작성
                </p>
                <a
                  href="https://kosis.kr/openapi/"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  KOSIS OpenAPI 바로가기
                </a>
              </div>
              <label className="space-y-2 text-sm text-slate-700">
                userStatsId
                <input
                  value={kosisUserStatsId}
                  onChange={(event) => setKosisUserStatsId(event.target.value)}
                  placeholder="예: openapi/101/DT_1B040A3/2/1/20240101000000"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                />
              </label>
              {kosisUserStatsError ? (
                <p className="text-xs text-rose-600">{kosisUserStatsError}</p>
              ) : null}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("period")}
                  disabled={!canGoNextFromKosisUserStats}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}
          {!done && step === "datagokrSpec" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">
                  API 서비스명과 상세 기능명을 입력해주세요
                </h4>
                <p className="mt-2 text-sm text-slate-600">
                  데이터공공포털에서 활용신청한 API 서비스명과 상세 기능명이 필요합니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                <p>선택한 통계표에 대해 아직 활용신청을 하지 않았다면 먼저 신청이 필요합니다.</p>
                <p className="mt-2">
                  데이터공공포털 &gt; 활용신청 &gt; API서비스명 &amp; 상세 기능명 작성
                </p>
                {selectedDatagokrStat?.list_url ? (
                  <a
                    href={selectedDatagokrStat.list_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    선택한 API 안내 페이지 바로가기
                  </a>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-2 text-sm text-slate-700">
                  API 서비스명
                  <input
                    value={datagokrApiServiceName}
                    onChange={(event) => setDatagokrApiServiceName(event.target.value)}
                    placeholder="예: nationtrade"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
                <label className="space-y-2 text-sm text-slate-700">
                  상세 기능명
                  <input
                    value={datagokrFunctionName}
                    onChange={(event) => setDatagokrFunctionName(event.target.value)}
                    placeholder="예: getNationtradeList"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
              </div>
              {datagokrSpecError ? (
                <p className="text-xs text-rose-600">{datagokrSpecError}</p>
              ) : null}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("period")}
                  disabled={!canGoNextFromDatagokrSpec}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}
          {!done && step === "krxApiApply" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">KRX API 신청을 확인해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  KRX는 별도의 사용자 ID 입력 없이, 최초 1회 사이트에서 로그인 후 API 이용신청을
                  하면 데이터를 수집할 수 있습니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                <p>아직 신청하지 않았다면 아래 순서로 먼저 신청이 필요합니다.</p>
                <p className="mt-2">
                  KRX Data Marketplace OPEN API &gt; 회원가입/로그인 &gt; 인증키 신청 &gt;
                  컨텐츠별 API 이용신청(관리자 승인 후 사용)
                </p>
                <a
                  href={selectedKrxStat?.guide_url?.trim() || KRX_OPENAPI_PORTAL_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  {selectedKrxStat?.guide_url?.trim()
                    ? `${selectedKrxStat.api_name} 안내 페이지 바로가기`
                    : "KRX OpenAPI 바로가기"}
                </a>
              </div>
              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 p-4 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={krxApiApplied}
                  onChange={(event) => setKrxApiApplied(event.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  선택한 API에 대해 KRX 사이트에서 로그인 및 API 이용신청을 완료했습니다.
                </span>
              </label>
              {!canGoNextFromKrxApiApply ? (
                <p className="text-xs text-rose-600">
                  API 신청 완료 여부를 확인(체크)해야 다음으로 진행할 수 있습니다.
                </p>
              ) : null}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("period")}
                  disabled={!canGoNextFromKrxApiApply}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}
          {!done && step === "period" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">
                  {selectedProvider === "kosis" ||
                  selectedProvider === "fred" ||
                  selectedProvider === "oecd"
                    ? "주기와 기간을 입력해주세요"
                    : "수집할 기간을 입력해주세요"}
                </h4>
                <p className="mt-2 text-sm text-slate-600">
                  시작일과 종료일을 선택하면 해당 기간으로 데이터를 등록합니다.
                </p>
              </div>
              {selectedProvider === "kosis" ? (
                <label className="space-y-2 text-sm text-slate-700">
                  주기
                  <select
                    value={kosisCycle}
                    onChange={(event) => setKosisCycle(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  >
                    <option value="Y">연간</option>
                    <option value="Q">분기</option>
                    <option value="M">월간</option>
                    <option value="D">일간</option>
                  </select>
                </label>
              ) : selectedProvider === "fred" ? (
                <label className="space-y-2 text-sm text-slate-700">
                  주기 (선택 시리즈 기준 고정)
                  <select
                    value={(selectedFredStat?.cycle ?? "M").toUpperCase()}
                    disabled
                    className="w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-slate-600"
                  >
                    <option value="A">연간 (A)</option>
                    <option value="Q">분기 (Q)</option>
                    <option value="M">월간 (M)</option>
                    <option value="W">주간 (W)</option>
                    <option value="D">일간 (D)</option>
                  </select>
                </label>
              ) : selectedProvider === "oecd" ? (
                <label className="space-y-2 text-sm text-slate-700">
                  주기 (선택 지표 기준 고정)
                  <select
                    value={(selectedOecdStat?.cycle ?? "M").toUpperCase()}
                    disabled
                    className="w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-slate-600"
                  >
                    <option value="A">연간 (2020)</option>
                    <option value="Q">분기 (2020-Q1)</option>
                    <option value="M">월간 (2020-01)</option>
                    <option value="D">일간 (2020-01-01)</option>
                  </select>
                </label>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-2 text-sm text-slate-700">
                  시작일
                  <input
                    type="date"
                    value={startDate}
                    min="1000-01-01"
                    max="9999-12-31"
                    onChange={(event) => setStartDate(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
                <label className="space-y-2 text-sm text-slate-700">
                  종료일
                  <input
                    type="date"
                    value={endDate}
                    min="1000-01-01"
                    max="9999-12-31"
                    onChange={(event) => setEndDate(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => quickRange(1)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 1개월
                </button>
                <button
                  type="button"
                  onClick={() => quickRange(3)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 3개월
                </button>
                <button
                  type="button"
                  onClick={() => quickRange(6)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 6개월
                </button>
                <button
                  type="button"
                  onClick={() => quickRange(12)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 1년
                </button>
              </div>
              {periodError ? <p className="text-xs text-rose-600">{periodError}</p> : null}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("extra")}
                  disabled={!canGoNextFromPeriod}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "extra" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">추가 조건이 있나요?</h4>
                <p className="mt-2 text-sm text-slate-600">
                  필요한 경우만 입력하세요. 입력하지 않아도 다음으로 진행할 수 있습니다.
                </p>
              </div>
              <div className="space-y-2">
                {extraParams.map((item, index) => (
                  <div
                    key={`extra-${index}`}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  >
                    <input
                      value={item.key}
                      onChange={(event) =>
                        setExtraParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, key: event.target.value } : row,
                          ),
                        )
                      }
                      placeholder="파라미터명"
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <input
                      value={item.value}
                      onChange={(event) =>
                        setExtraParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, value: event.target.value } : row,
                          ),
                        )
                      }
                      placeholder="파라미터값"
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setExtraParams((prev) =>
                          prev.length === 1 ? [{ key: "", value: "" }] : prev.filter((_, idx) => idx !== index),
                        )
                      }
                      className="rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600"
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setExtraParams((prev) => [...prev, { key: "", value: "" }])}
                className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                + 파라미터 추가
              </button>
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("name")}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "name" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">API 명을 입력해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  입력한 API 명은 등록 후 그룹명으로 저장됩니다.
                </p>
              </div>
              <label className="space-y-2 text-sm text-slate-700">
                API 명
                <input
                  value={apiGroupName}
                  onChange={(event) => setApiGroupName(event.target.value)}
                  maxLength={120}
                  placeholder="예: 한국은행_본원통화_월별수집"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                />
              </label>
              {apiGroupNameError ? (
                <p className="text-xs text-rose-600">{apiGroupNameError}</p>
              ) : (
                <p className="text-xs text-slate-500">최대 120자</p>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("confirm")}
                  disabled={!canGoNextFromName}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "confirm" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">등록 내용을 확인해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  아래 내용을 확인한 뒤 등록하기를 눌러주세요.
                </p>
              </div>
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p>
                  <span className="font-semibold">API 명:</span> {apiGroupName || "-"}
                </p>
                <p>
                  <span className="font-semibold">기관:</span>{" "}
                  {ORG_CATALOG.find((item) => item.provider === selectedProvider)?.name ?? "-"}
                </p>
                <p>
                  <span className="font-semibold">수집대상:</span> {resolvedSelectedTarget?.title ?? "-"}
                </p>
                {selectedBokStat ? (
                  <>
                    <p>
                      <span className="font-semibold">통계표 코드:</span> {selectedBokStat.stat_code}
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> {selectedBokStat.cycle || "-"}
                    </p>
                  </>
                ) : null}
                {selectedKosisStat ? (
                  <>
                    <p>
                      <span className="font-semibold">통계표 코드:</span> {selectedKosisStat.stat_code}
                    </p>
                    <p>
                      <span className="font-semibold">표시명:</span> {kosisDisplayLabel(selectedKosisStat)}
                    </p>
                    <p>
                      <span className="font-semibold">userStatsId:</span> {kosisUserStatsId || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> {kosisCycle}
                    </p>
                    <p>
                      <span className="font-semibold">경로:</span> {selectedKosisStat.full_path || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">vw_cd:</span> {selectedKosisStat.vw_cd || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">stat_id:</span> {selectedKosisStat.stat_id || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">send_de:</span> {selectedKosisStat.send_de || "-"}
                    </p>
                  </>
                ) : null}
                {selectedDatagokrStat ? (
                  <>
                    <p>
                      <span className="font-semibold">API 코드:</span> {selectedDatagokrStat.stat_code}
                    </p>
                    <p>
                      <span className="font-semibold">API 서비스명:</span> {datagokrApiServiceName || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">상세 기능명:</span> {datagokrFunctionName || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">안내 페이지:</span> {selectedDatagokrStat.list_url || "-"}
                    </p>
                  </>
                ) : null}
                {selectedFredStat ? (
                  <>
                    <p>
                      <span className="font-semibold">시리즈 코드(series_id):</span>{" "}
                      {selectedFredStat.stat_code || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">주기(frequency):</span>{" "}
                      {(selectedFredStat.cycle ?? "").toLowerCase() || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">시리즈명:</span> {selectedFredStat.node_name}
                    </p>
                  </>
                ) : null}
                {selectedProvider === "oecd" && selectedOecdStat ? (
                  <>
                    <p>
                      <span className="font-semibold">지표:</span> {selectedOecdStat.indicator_name}
                    </p>
                    <p>
                      <span className="font-semibold">데이터플로우(ref):</span>{" "}
                      {selectedOecdStat.flow_ref}
                    </p>
                    <p>
                      <span className="font-semibold">필터키:</span> {selectedOecdStat.data_key}
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> {selectedOecdStat.cycle}
                    </p>
                  </>
                ) : null}
                {selectedProvider === "yfinance" && selectedYfinanceStat ? (
                  <>
                    <p>
                      <span className="font-semibold">종목:</span> {selectedYfinanceStat.item_name}
                    </p>
                    <p>
                      <span className="font-semibold">티커:</span> {selectedYfinanceStat.ticker}
                    </p>
                    <p>
                      <span className="font-semibold">분류:</span> {selectedYfinanceStat.category_name}
                    </p>
                    <p>
                      <span className="font-semibold">수집 항목:</span> 시가·고가·저가·종가·수정종가·거래량(OHLCV) / 일별
                    </p>
                  </>
                ) : null}
                {selectedProvider === "worldbank" && selectedWorldbankStat ? (
                  <>
                    <p>
                      <span className="font-semibold">지표:</span>{" "}
                      {selectedWorldbankStat.indicator_name} ({selectedWorldbankStat.indicator_code})
                    </p>
                    <p>
                      <span className="font-semibold">국가:</span> {selectedWorldbankStat.country_name} (
                      {selectedWorldbankStat.country_code})
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> 연간
                    </p>
                  </>
                ) : null}
                {selectedProvider === "undp" && selectedUndpIndicator && selectedUndpLocation ? (
                  <>
                    <p>
                      <span className="font-semibold">지표:</span> {selectedUndpIndicator.name} (ID{" "}
                      {selectedUndpIndicator.id})
                    </p>
                    <p>
                      <span className="font-semibold">지역:</span> {selectedUndpLocation.name} (
                      {selectedUndpLocation.iso3 || selectedUndpLocation.id})
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> 연간
                    </p>
                  </>
                ) : null}
                <p>
                  <span className="font-semibold">시작일:</span> {startDate || "-"}
                </p>
                <p>
                  <span className="font-semibold">종료일:</span> {endDate || "-"}
                </p>
                <div>
                  <p className="font-semibold">추가 파라미터:</p>
                  {extraParams.some((item) => item.key.trim() && item.value.trim()) ? (
                    <ul className="mt-1 space-y-1 text-xs">
                      {extraParams
                        .filter((item) => item.key.trim() && item.value.trim())
                        .map((item, index) => (
                          <li key={`summary-${index}`}>
                            {item.key} = {item.value}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-slate-500">없음</p>
                  )}
                </div>
                {selectedProvider === "yfinance" ? (
                  <div>
                    <p className="font-semibold">수집 방식:</p>
                    <p className="mt-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                      URL 호출이 아니라 Python(yfinance)으로 수집합니다. 티커·기간으로 시세를
                      직접 조회하므로 별도의 API URL/키가 없습니다.
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="font-semibold">생성 URL:</p>
                    <p className="mt-1 break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                      {previewUrl || "URL을 생성할 수 없습니다."}
                    </p>
                    {!((resolvedSelectedTarget?.source.api_key ?? "").trim()) ? (
                      <p className="mt-1 text-[11px] text-amber-700">
                        기관 관리에 등록된 API Key가 없어 호출이 실패할 수 있습니다.
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">데이터 미리보기</p>
                  <button
                    type="button"
                    onClick={() => void fetchPreviewData()}
                    disabled={!previewUrl || previewLoading}
                    className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {previewLoading ? "조회 중..." : "미리보기 조회"}
                  </button>
                </div>
                {previewError ? (
                  <p className="text-xs text-rose-600">{previewError}</p>
                ) : previewHeader.length > 0 ? (
                  <>
                    <div className="max-h-52 overflow-auto rounded-xl border border-slate-200">
                      <table className="min-w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            {previewHeader.map((col) => (
                              <th key={col} className="whitespace-nowrap border-b border-slate-200 px-2 py-1.5">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((row, rowIndex) => (
                            <tr key={`preview-row-${rowIndex}`} className="text-slate-700">
                              {previewHeader.map((_, colIndex) => (
                                <td key={`preview-cell-${rowIndex}-${colIndex}`} className="whitespace-nowrap border-b border-slate-100 px-2 py-1.5">
                                  {String(row[colIndex] ?? "")}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">
                      미리보기는 최대 10건까지 표시됩니다.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">
                    조회 버튼을 눌러 상위 10건 샘플을 확인하세요.
                  </p>
                )}
              </div>
              {submitError ? <p className="text-xs text-rose-600">{submitError}</p> : null}
              <div className="flex justify-end">
                {selectedProvider === "yfinance" ? null : (
                  <button
                    type="button"
                    onClick={() => void copyPreviewUrl()}
                    disabled={!previewUrl}
                    className="mr-2 rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {urlCopied ? "복사됨" : "URL 복사"}
                  </button>
                )}
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {submitting ? "등록 중..." : "등록하기"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
