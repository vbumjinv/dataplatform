 "use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import UserApiRegistrationModal from "./components/UserApiRegistrationModal";
import DataMappingManagerModal from "./components/DataMappingManagerModal";
import PdfTableIngestPanel from "./components/PdfTableIngestPanel";
import PdfItemTradePanel from "./components/PdfItemTradePanel";

const pipelineSteps = [
  {
    step: "1. 수집",
    detail: "API/DB/파일에서 데이터 적재",
  },
  {
    step: "2. 특성값 계산",
    detail: "기준값 범위, 분포, 요약 통계 자동 산출",
  },
  {
    step: "3. 품질 점검",
    detail: "표준 단어/용어, 널값, 이상치 규칙 검증",
  },
];

const decodeURIComponentSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeProvider = (provider?: string | null) => {
  const value = (provider ?? "").trim();
  if (!value) return "custom";
  const lowered = value.toLowerCase();
  if (lowered === "data-go-kr" || lowered === "data_go_kr") return "datagokr";
  return lowered;
};
const END_LATEST_TOKEN = "__TODAY__";
const START_RELATIVE_TOKEN_REGEX = /^__TODAY_MINUS_(\d+)(D|M|Q|A|Y)__$/i;
const START_RELATIVE_KO_REGEX = /^(\d+)\s*(일|개월|분기|년)\s*전$/;
const INGESTION_DB_SETTING_STORAGE_KEY = "ingestion-selected-db-setting-id";
type DbSettingOption = {
  id: number;
  settingName: string;
};
type IngestionTabKey = "apiStatus" | "mappingStatus" | "apiSettings" | "mappingSettings";
type IngestionStatusSummary = {
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  successRate: number;
  insertedTotal: number;
  lastRunAt: string | null;
};
type IngestionStatusDaily = {
  runDate: string;
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  insertedTotal: number;
};
type IngestionStatusFailure = {
  loadLogId: number;
  startedAt: string;
  sourceName: string;
  groupName: string | null;
  status: "running" | "success" | "error";
  insertedCount: number;
  errorStage: string | null;
  errorMessage: string | null;
};
type IngestionStatusDailyDetail = {
  runDate: string;
  loadLogId: number;
  startedAt: string;
  sourceName: string;
  groupName: string | null;
  triggerType: "manual" | "schedule";
  status: "success" | "error";
  insertedCount: number;
  errorMessage: string | null;
};
type MappingStatusSummary = {
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  successRate: number;
  affectedTotal: number;
  lastRunAt: string | null;
};
type MappingStatusDaily = {
  runDate: string;
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  affectedTotal: number;
};
type MappingStatusDailyDetail = {
  runDate: string;
  runLogId: number;
  startedAt: string;
  seriesName: string;
  mapId: number;
  triggerType: "manual" | "schedule";
  runMode: "generate" | "regenerate";
  status: "success" | "error";
  affectedCount: number;
  errorMessage: string | null;
};
type MappingStatusFailure = {
  runLogId: number;
  startedAt: string;
  seriesName: string;
  mapId: number;
  triggerType: "manual" | "schedule";
  runMode: "generate" | "regenerate";
  status: "running" | "success" | "error";
  affectedCount: number;
  errorMessage: string | null;
};
type IngestionChannelFilter = "전체" | "API" | "엑셀" | "기타";
type IngestionSettingsTab = "API 설정" | "엑셀 설정" | "기타 설정" | "PDF 설정";
const ingestionTabs: Array<{ key: IngestionTabKey; label: string }> = [
  { key: "apiStatus", label: "수집 현황" },
  { key: "mappingStatus", label: "매핑 현황" },
  { key: "apiSettings", label: "수집 설정" },
  { key: "mappingSettings", label: "매핑 설정" },
];
const ingestionChannelFilters: IngestionChannelFilter[] = ["전체", "API", "엑셀", "기타"];
const ingestionSettingsTabs: IngestionSettingsTab[] = ["API 설정", "엑셀 설정", "기타 설정", "PDF 설정"];
const formatNumber = (value: number) => new Intl.NumberFormat("ko-KR").format(value);
const PARAM_ROLE_LABELS: Record<string, string> = {
  period: "기간 단위",
  start: "조회 시작일",
  end: "조회 종료일",
  apiKey: "인증 키",
};
const PARAM_ROLE_DESCRIPTIONS: Record<string, string> = {
  period: "일/월/분기/년 같은 조회 주기를 지정합니다. API 포맷에 맞는 값으로 설정하세요.",
  start:
    "데이터 조회 시작일입니다. 예: 20240101, 202401, 3개월 전, __TODAY_MINUS_3M__",
  end: "데이터 조회 종료일입니다. __TODAY__를 입력하면 실행 시점의 오늘 날짜로 변환됩니다.",
  apiKey: "API 인증에 사용하는 키 값입니다. 헤더/쿼리 위치와 키 이름이 맞아야 정상 호출됩니다.",
};
const DATE_PARAM_VALUE_GUIDE = [
  "__TODAY__ (종료일): 실행 시점의 오늘 날짜",
  "__TODAY_MINUS_{n}D__ (시작일): n일 전",
  "__TODAY_MINUS_{n}M__ (시작일): n개월 전",
  "__TODAY_MINUS_{n}Q__ (시작일): n분기 전(3개월 단위)",
  "__TODAY_MINUS_{n}Y__ 또는 __TODAY_MINUS_{n}A__ (시작일): n년 전",
  "한글 입력도 가능: 3일 전, 3개월 전, 2분기 전, 1년 전",
];
const getParamDescription = (paramKey: string, role?: string | null) => {
  const normalizedRole = (role ?? "").trim();
  if (normalizedRole && PARAM_ROLE_DESCRIPTIONS[normalizedRole]) {
    return {
      label: PARAM_ROLE_LABELS[normalizedRole] ?? normalizedRole,
      description: PARAM_ROLE_DESCRIPTIONS[normalizedRole],
    };
  }
  const key = paramKey.trim().toLowerCase();
  if (!key) return null;
  if (key.includes("start") || key.includes("strt")) {
    return {
      label: "조회 시작일",
      description:
        "조회 시작일 파라미터입니다. 상대일(예: 3개월 전, __TODAY_MINUS_3M__)도 사용할 수 있습니다.",
    };
  }
  if (key.includes("end")) {
    return {
      label: "조회 종료일",
      description: "조회 종료일 파라미터입니다. __TODAY__를 사용하면 오늘 날짜로 자동 치환됩니다.",
    };
  }
  if (key.includes("period")) {
    return {
      label: "기간 단위",
      description: "조회 단위(일/월/분기/년 등)를 지정하는 파라미터입니다.",
    };
  }
  if (key.includes("key") || key.includes("servicekey") || key.includes("apikey")) {
    return {
      label: "인증 키",
      description: "API 인증/인가에 사용되는 키 값입니다.",
    };
  }
  return null;
};

export default function IngestionPage() {
  const [activeTab, setActiveTab] = useState<IngestionTabKey>("apiStatus");
  const [activeSettingsTab, setActiveSettingsTab] = useState<IngestionSettingsTab>("API 설정");
  const [channelFilter, setChannelFilter] = useState<IngestionChannelFilter>("전체");
  const [ingestionLoading, setIngestionLoading] = useState(false);
  const [ingestionError, setIngestionError] = useState("");
  const [ingestionStatusLoaded, setIngestionStatusLoaded] = useState(false);
  const [ingestionSummary, setIngestionSummary] = useState<IngestionStatusSummary | null>(null);
  const [ingestionDailyRows, setIngestionDailyRows] = useState<IngestionStatusDaily[]>([]);
  const [ingestionDailyDetailRows, setIngestionDailyDetailRows] = useState<IngestionStatusDailyDetail[]>([]);
  const [selectedDailyDate, setSelectedDailyDate] = useState<string | null>(null);
  const [ingestionFailureRows, setIngestionFailureRows] = useState<IngestionStatusFailure[]>([]);
  const [mappingStatusLoaded, setMappingStatusLoaded] = useState(false);
  const [mappingStatusLoading, setMappingStatusLoading] = useState(false);
  const [mappingStatusError, setMappingStatusError] = useState("");
  const [mappingSummary, setMappingSummary] = useState<MappingStatusSummary | null>(null);
  const [mappingDailyRows, setMappingDailyRows] = useState<MappingStatusDaily[]>([]);
  const [mappingDailyDetailRows, setMappingDailyDetailRows] = useState<MappingStatusDailyDetail[]>([]);
  const [selectedMappingDailyDate, setSelectedMappingDailyDate] = useState<string | null>(null);
  const [mappingFailureRows, setMappingFailureRows] = useState<MappingStatusFailure[]>([]);
  const [showApiModal, setShowApiModal] = useState(false);
  const [showUserApiRegisterModal, setShowUserApiRegisterModal] = useState(false);
  const [mappingCreateRequestKey, setMappingCreateRequestKey] = useState(0);
  const [mappingBulkGenerateRequestKey, setMappingBulkGenerateRequestKey] = useState(0);
  // 수집 그룹별 "데이터 매핑" 팝업(해당 원천 테이블로 스코프)
  const [dataMapScopeTarget, setDataMapScopeTarget] = useState<{
    sourceOrg: string;
    sourceTable: string;
    apiName: string;
  } | null>(null);
  const [scopedMapCreateKey, setScopedMapCreateKey] = useState(0);
  const [scopedMapBulkKey, setScopedMapBulkKey] = useState(0);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [apiView, setApiView] = useState<"register" | "list">("list");
  const [periodOffset, setPeriodOffset] = useState("3");
  const [periodInputMode, setPeriodInputMode] = useState<"range" | "manual">("range");
  const [showSourceCreate, setShowSourceCreate] = useState(false);
  const [sourceCreate, setSourceCreate] = useState({
    name: "",
    provider: "",
    baseUrl: "",
    apiKey: "",
  });
  const [selectedSourceIds, setSelectedSourceIds] = useState<number[]>([]);
  const [showDeleteSelectAlert, setShowDeleteSelectAlert] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<number | null>(null);
  const [editSource, setEditSource] = useState({
    name: "",
    provider: "",
    baseUrl: "",
    apiKey: "",
    apiKeyParamKey: "",
    apiKeyLocation: "query",
    apiKeyOrder: 0,
    apiKeyEncodeMode: "encode",
  });
  const [apiList, setApiList] = useState<Array<{
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
    groups: Array<{
      id: number;
      name: string | null;
      is_template?: boolean;
      created_at: string;
      schedule_enabled?: boolean | null;
      schedule_type?: "interval" | "cron" | null;
      schedule_interval_minutes?: number | null;
      schedule_cron_expr?: string | null;
      target_schema?: string | null;
      target_table?: string | null;
      target_truncate?: boolean | null;
      target_merge_sql?: string | null;
      params: Array<{
        id: number;
        param_key: string;
        param_value: string;
        param_location: string;
        param_order: number;
        encode_mode?: string | null;
        param_role?: string | null;
      }>;
    }>;
  }>>([]);
  const [apiTemplates, setApiTemplates] = useState<typeof apiList>([]);
  const [apiListStatus, setApiListStatus] = useState<{
    type: "idle" | "loading" | "error";
    message: string;
  }>({ type: "idle", message: "" });
  const [apiLoadStatus, setApiLoadStatus] = useState<{
    type: "idle" | "loading" | "success" | "error" | "cancelled";
    message: string;
  }>({ type: "idle", message: "" });
  const [runningLoadTaskId, setRunningLoadTaskId] = useState<string | null>(null);
  const [apiLoadCancelBusy, setApiLoadCancelBusy] = useState(false);
  const [sourceEditTarget, setSourceEditTarget] = useState<{
    id: number;
  } | null>(null);
  const [groupEditTarget, setGroupEditTarget] = useState<{
    sourceId: number;
    groupId: number;
  } | null>(null);
  const [sourceEdit, setSourceEdit] = useState({
    name: "",
    provider: "custom",
    baseUrl: "",
    apiKey: "",
    enabled: true,
  });
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditProvider, setGroupEditProvider] = useState("custom");
  const [groupEditParams, setGroupEditParams] = useState<
    Array<{
      key: string;
      value: string;
      location: "path" | "query";
      order: number;
      role?: string | null;
    }>
  >([]);
  const [showGroupParamGuide, setShowGroupParamGuide] = useState(false);
  const padNumber = (value: number, length = 2) =>
    String(value).padStart(length, "0");
  const formatPeriodValue = (date: Date, period: string) => {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    if (period === "D") {
      return `${year}${padNumber(month)}${padNumber(date.getDate())}`;
    }
    if (period === "M") {
      return `${year}${padNumber(month)}`;
    }
    if (period === "Q") {
      const quarter = Math.floor((month - 1) / 3) + 1;
      return `${year}Q${quarter}`;
    }
    if (period === "A" || period === "Y") {
      return `${year}`;
    }
    return "";
  };
  const formatIsoDateValue = (date: Date) =>
    `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
  const shouldUseIsoDateParamFormat = (paramKey: string) => {
    const normalized = paramKey.trim().toLowerCase();
    return normalized === "observation_start" || normalized === "observation_end";
  };
  const shouldUseDailyCompactParamFormat = (paramKey: string) =>
    paramKey.trim().toLowerCase() === "basdd";
  const formatParamDateValue = (date: Date, period: string, paramKey: string) => {
    if (shouldUseIsoDateParamFormat(paramKey)) {
      return formatIsoDateValue(date);
    }
    if (shouldUseDailyCompactParamFormat(paramKey)) {
      return formatPeriodValue(date, "D");
    }
    return formatPeriodValue(date, period);
  };
  const applyPeriodRange = (
    period: string,
    offsetText: string,
    startKey: string,
    endKey: string,
    location: "path" | "query",
    startOrder: number,
    endOrder: number,
  ) => {
    if (!offsetText) return;
    const offset = Number(offsetText);
    if (!Number.isFinite(offset)) return;
    const today = new Date();
    const startDate = new Date(today);
    if (period === "D") {
      startDate.setDate(startDate.getDate() - offset);
    } else if (period === "M") {
      startDate.setMonth(startDate.getMonth() - offset);
    } else if (period === "Q") {
      startDate.setMonth(startDate.getMonth() - offset * 3);
    } else if (period === "A" || period === "Y") {
      startDate.setFullYear(startDate.getFullYear() - offset);
    }
    const startValue = formatPeriodValue(startDate, period);
    const endValue = formatPeriodValue(today, period);
    if (startValue) {
      setParamValue(startKey, startValue, location, startOrder);
    }
    if (endValue) {
      setParamValue(endKey, endValue, location, endOrder);
    }
  };
  const getPeriodOffsetLabel = (period: string) => {
    if (period === "D") return "일 전";
    if (period === "M") return "개월 전";
    if (period === "Q") return "분기 전";
    return "년 전";
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
      role?: string | null;
    }>,
  ) => {
    const roleKeyMap = new Map<string, string>();
    rawParams.forEach((item) => {
      const role = item.role?.trim();
      if (!role || roleKeyMap.has(role)) return;
      roleKeyMap.set(role, item.key);
    });
    const paramValueByKey = new Map<string, string>(rawParams.map((item) => [item.key, item.value]));
    const paramValueByKeyLower = new Map<string, string>(
      rawParams.map((item) => [item.key.trim().toLowerCase(), item.value]),
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
    const resolvedParams = rawParams.map((item) => {
      const paramKey = item.key.trim().toLowerCase();
      const isEndParamByKey = [
        "apiEnd",
        "endPrdDe",
        "endYymm",
        "observation_end",
        "basDd",
        "BAS_DD",
      ]
        .map((key) => key.toLowerCase())
        .includes(paramKey);
      const isStartParamByKey = ["apiStart", "startPrdDe", "strtYymm", "observation_start"]
        .map((key) => key.toLowerCase())
        .includes(paramKey);
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

    const url = new URL(sourceItem.baseUrl);
    const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    const apiKeyKey = sourceItem.apiKeyParamKey?.trim() || "";
    const apiKeyLocation = sourceItem.apiKeyLocation || "query";
    const apiKeyOrder = Number.isFinite(sourceItem.apiKeyOrder)
      ? Number(sourceItem.apiKeyOrder)
      : 0;
    const apiKeyValue = sourceItem.apiKey ?? "";

    const pathParams = resolvedParams
      .filter((item) => item.location === "path" && item.value.trim())
      .map((item) => ({ ...item, encodeMode: item.encodeMode ?? "encode" }));
    const queryParams = resolvedParams
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
  const resolveSourceForRequestUrl = useCallback(
    (sourceItem: (typeof apiList)[number]) => {
      return {
        baseUrl: sourceItem.base_url,
        apiKey: sourceItem.api_key ?? "",
        apiKeyParamKey: sourceItem.api_key_param_key ?? "",
        apiKeyLocation: sourceItem.api_key_location ?? "query",
        apiKeyOrder: sourceItem.api_key_order ?? 0,
        apiKeyEncodeMode: sourceItem.api_key_encode_mode ?? "encode",
      };
    },
    [],
  );
  const [sourceEditStatus, setSourceEditStatus] = useState<{
    type: "idle" | "success" | "error";
    message: string;
  }>({ type: "idle", message: "" });
  const [groupEditStatus, setGroupEditStatus] = useState<{
    type: "idle" | "success" | "error";
    message: string;
  }>({ type: "idle", message: "" });
  const [groupDeleteTarget, setGroupDeleteTarget] = useState<{
    sourceId: number;
    groupId: number;
    name: string;
  } | null>(null);
  const [groupTestStatus, setGroupTestStatus] = useState<{
    groupId: number;
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [source, setSource] = useState({
    name: "",
    provider: "custom",
    baseUrl: "",
    apiKey: "",
    enabled: true,
    apiKeyParamKey: "",
    apiKeyLocation: "query",
    apiKeyOrder: 0,
    apiKeyEncodeMode: "encode",
  });
  const [params, setParams] = useState<
    Array<{
      key: string;
      value: string;
      location: "path" | "query";
      order: number;
      encodeMode?: string;
      role?: string | null;
    }>
  >([
    { key: "", value: "", location: "query", order: 1, encodeMode: "encode" },
  ]);
  const [submitStatus, setSubmitStatus] = useState<{
    type: "idle" | "success" | "error";
    message: string;
  }>({ type: "idle", message: "" });
  const [testStatus, setTestStatus] = useState<{
    type: "idle" | "success" | "error";
    message: string;
  }>({ type: "idle", message: "" });
  const [groupName, setGroupName] = useState("");
  const [groupScheduleTarget, setGroupScheduleTarget] = useState<{
    sourceId: number;
    groupId: number;
    name: string;
  } | null>(null);
  const [groupScheduleForm, setGroupScheduleForm] = useState({
    enabled: false,
    type: "interval" as "interval" | "cron",
    intervalMinutes: 60,
    cronExpr: "",
  });
  const [groupTableMapTarget, setGroupTableMapTarget] = useState<{
    sourceId: number;
    groupId: number;
    name: string;
  } | null>(null);
  const [groupTableMapForm, setGroupTableMapForm] = useState({
    schema: "public",
    table: "",
    truncate: false,
    mergeSql: "",
    schemas: [] as string[],
    tables: [] as string[],
    loadingSchemas: false,
    loadingTables: false,
  });
  const [selectedSourceId, setSelectedSourceId] = useState("custom");
  const [dbSettings, setDbSettings] = useState<DbSettingOption[]>([]);
  const [selectedDbSettingId, setSelectedDbSettingId] = useState("");
  const [dbSettingsError, setDbSettingsError] = useState("");
  const normalizedProvider = normalizeProvider(source.provider);
  const withDbSettingQuery = useCallback(
    (path: string) => {
      if (!selectedDbSettingId) return path;
      const separator = path.includes("?") ? "&" : "?";
      return `${path}${separator}dbSettingId=${encodeURIComponent(selectedDbSettingId)}`;
    },
    [selectedDbSettingId],
  );
  const withDbSettingBody = useCallback(
    <T extends Record<string, unknown>>(body: T) => {
      if (!selectedDbSettingId) return body;
      const numericId = Number(selectedDbSettingId);
      if (!Number.isFinite(numericId) || numericId <= 0) return body;
      return {
        ...body,
        dbSettingId: numericId,
      };
    },
    [selectedDbSettingId],
  );
  const selectableSources = useMemo(
    () => [...apiTemplates, ...apiList],
    [apiList, apiTemplates],
  );
  const apiGroupRows = useMemo(
    () =>
      apiList.flatMap((sourceItem) =>
        sourceItem.groups.map((group) => ({
          ...group,
          sourceId: sourceItem.id,
          sourceName: sourceItem.name,
          provider: sourceItem.provider,
        })),
      ),
    [apiList],
  );
  const apiParamRows = useMemo(
    () =>
      apiList.flatMap((sourceItem) =>
        sourceItem.groups.flatMap((group) =>
          group.params.map((param) => ({
            ...param,
            groupId: group.id,
            sourceId: sourceItem.id,
          })),
        ),
      ),
    [apiList],
  );
  const groupedApiGroups = useMemo(() => {
    const sorted = apiGroupRows
      .slice()
      .sort((a, b) => {
        if (a.sourceId !== b.sourceId) return a.sourceId - b.sourceId;
        const nameCompare = a.sourceName.localeCompare(b.sourceName);
        if (nameCompare !== 0) return nameCompare;
        const groupA = a.name ?? "";
        const groupB = b.name ?? "";
        if (groupA === "" && groupB !== "") return 1;
        if (groupA !== "" && groupB === "") return -1;
        const groupCompare = groupA.localeCompare(groupB);
        if (groupCompare !== 0) return groupCompare;
        return a.id - b.id;
      });
    const grouped: Array<{
      sourceId: number;
      sourceName: string;
      groups: Array<{
        id: number;
        name: string | null;
        created_at: string;
        endUrl: string;
        sourceId: number;
        scheduleEnabled: boolean;
        scheduleType: "interval" | "cron";
        scheduleIntervalMinutes: number | null;
        scheduleCronExpr: string | null;
        targetSchema: string | null;
        targetTable: string | null;
        targetTruncate: boolean;
        targetMergeSql: string | null;
      }>;
    }> = [];
    sorted.forEach((group) => {
      const sourceItem = apiList.find((item) => item.id === group.sourceId);
      const endUrl =
        sourceItem && Array.isArray(group.params)
          ? buildUrlFromSourceParams(
              resolveSourceForRequestUrl(sourceItem),
              group.params.map((param) => ({
                key: param.param_key,
                value: param.param_value,
                location: param.param_location as "path" | "query",
                order: param.param_order,
                encodeMode: param.encode_mode ?? "encode",
                role: param.param_role ?? null,
              })),
            )
          : "";
      const last = grouped[grouped.length - 1];
      if (last && last.sourceId === group.sourceId && last.sourceName === group.sourceName) {
        last.groups.push({
          id: group.id,
          name: group.name ?? null,
          created_at: group.created_at,
          endUrl,
          sourceId: group.sourceId,
          scheduleEnabled: Boolean(group.schedule_enabled),
          scheduleType: group.schedule_type === "cron" ? "cron" : "interval",
          scheduleIntervalMinutes: Number.isFinite(group.schedule_interval_minutes)
            ? Number(group.schedule_interval_minutes)
            : null,
          scheduleCronExpr: group.schedule_cron_expr ?? null,
          targetSchema: group.target_schema ?? null,
          targetTable: group.target_table ?? null,
          targetTruncate: Boolean(group.target_truncate),
          targetMergeSql: group.target_merge_sql ?? null,
        });
      } else {
        grouped.push({
          sourceId: group.sourceId,
          sourceName: group.sourceName,
          groups: [
            {
              id: group.id,
              name: group.name ?? null,
              created_at: group.created_at,
              endUrl,
              sourceId: group.sourceId,
              scheduleEnabled: Boolean(group.schedule_enabled),
              scheduleType: group.schedule_type === "cron" ? "cron" : "interval",
              scheduleIntervalMinutes: Number.isFinite(group.schedule_interval_minutes)
                ? Number(group.schedule_interval_minutes)
                : null,
              scheduleCronExpr: group.schedule_cron_expr ?? null,
              targetSchema: group.target_schema ?? null,
              targetTable: group.target_table ?? null,
              targetTruncate: Boolean(group.target_truncate),
              targetMergeSql: group.target_merge_sql ?? null,
            },
          ],
        });
      }
    });
    return grouped;
  }, [
    apiGroupRows,
    apiList,
    buildUrlFromSourceParams,
    resolveSourceForRequestUrl,
  ]);
  const ingestionDailyMaxRuns = useMemo(() => {
    const targetRows =
      channelFilter === "전체" || channelFilter === "API" ? ingestionDailyRows : [];
    if (!targetRows.length) return 1;
    return Math.max(...targetRows.map((row) => row.totalRuns), 1);
  }, [channelFilter, ingestionDailyRows]);
  const shouldShowApiData = channelFilter === "전체" || channelFilter === "API";
  const filteredIngestionSummary = shouldShowApiData ? ingestionSummary : null;
  const filteredIngestionDailyRows = shouldShowApiData ? ingestionDailyRows : [];
  const displayedIngestionDailyRows = useMemo(
    () => filteredIngestionDailyRows.slice(-7).reverse(),
    [filteredIngestionDailyRows],
  );
  const filteredIngestionDailyDetailRows = shouldShowApiData ? ingestionDailyDetailRows : [];
  const filteredIngestionFailureRows = shouldShowApiData ? ingestionFailureRows : [];
  const selectedDateDetailRows = useMemo(
    () =>
      selectedDailyDate
        ? filteredIngestionDailyDetailRows.filter((row) => row.runDate === selectedDailyDate)
        : [],
    [filteredIngestionDailyDetailRows, selectedDailyDate],
  );
  const selectedDateSuccessRows = useMemo(
    () => selectedDateDetailRows.filter((row) => row.status === "success"),
    [selectedDateDetailRows],
  );
  const selectedDateErrorRows = useMemo(
    () => selectedDateDetailRows.filter((row) => row.status === "error"),
    [selectedDateDetailRows],
  );
  const kpiBaseDateLabel = useMemo(
    () =>
      new Date().toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    [],
  );
  const displayedIngestionDailyMaxRuns = useMemo(() => {
    if (!displayedIngestionDailyRows.length) return 1;
    return Math.max(...displayedIngestionDailyRows.map((row) => row.totalRuns), 1);
  }, [displayedIngestionDailyRows]);
  const displayedMappingDailyRows = useMemo(
    () => mappingDailyRows.slice(-7).reverse(),
    [mappingDailyRows],
  );
  const displayedMappingDailyMaxRuns = useMemo(() => {
    if (!displayedMappingDailyRows.length) return 1;
    return Math.max(...displayedMappingDailyRows.map((row) => row.totalRuns), 1);
  }, [displayedMappingDailyRows]);
  const selectedMappingDateDetailRows = useMemo(
    () =>
      selectedMappingDailyDate
        ? mappingDailyDetailRows.filter((row) => row.runDate === selectedMappingDailyDate)
        : [],
    [mappingDailyDetailRows, selectedMappingDailyDate],
  );
  const selectedMappingDateSuccessRows = useMemo(
    () => selectedMappingDateDetailRows.filter((row) => row.status === "success"),
    [selectedMappingDateDetailRows],
  );
  const selectedMappingDateErrorRows = useMemo(
    () => selectedMappingDateDetailRows.filter((row) => row.status === "error"),
    [selectedMappingDateDetailRows],
  );

  const resetApiForm = useCallback(() => {
    setSource({
      name: "",
      provider: "custom",
      baseUrl: "",
      apiKey: "",
      enabled: true,
      apiKeyParamKey: "",
      apiKeyLocation: "query",
      apiKeyOrder: 0,
      apiKeyEncodeMode: "encode",
    });
    setParams([
      { key: "", value: "", location: "query", order: 1, encodeMode: "encode" },
    ]);
    setSubmitStatus({ type: "idle", message: "" });
    setTestStatus({ type: "idle", message: "" });
    setGroupName("");
    setPeriodOffset("3");
    setPeriodInputMode("range");
    setSelectedSourceId("custom");
  }, []);

  const getParamValue = useCallback(
    (key: string, fallback = "") =>
      params.find((item) => item.key === key)?.value ?? fallback,
    [params],
  );
  const isEndLatest = useCallback(
    (endKey: string) => getParamValue(endKey) === END_LATEST_TOKEN,
    [getParamValue],
  );

  const setParamValue = useCallback(
    (key: string, value: string, location: "path" | "query", order: number) => {
      setParams((prev) => {
        const index = prev.findIndex((item) => item.key === key);
        if (index < 0) {
          return [
            ...prev,
            { key, value, location, order, encodeMode: "encode" },
          ];
        }
        return prev.map((item, idx) =>
          idx === index ? { ...item, value, location, order } : item,
        );
      });
    },
    [],
  );

  useEffect(() => {
    if (source.provider !== "bok") return;
    const periodValue = params.find((item) => item.key === "period")?.value;
    if (!periodValue || !["D", "M", "Q", "A"].includes(periodValue)) {
      setParamValue("period", "M", "path", 6);
    }
  }, [params, setParamValue, source.provider]);

  const canSubmit = useMemo(
    () => {
      if (!source.name.trim() || !source.baseUrl.trim() || !source.apiKey.trim()) {
        return false;
      }
      const requiredParams = params.filter((item) => item.key.trim());
      if (requiredParams.length === 0) return false;
      return requiredParams.every((item) => item.value.trim().length > 0);
    },
    [params, source.apiKey, source.baseUrl, source.name],
  );

  const handleAddParam = () => {
    setParams((prev) => [
      ...prev,
      {
        key: "",
        value: "",
        location: "query",
        order: prev.length + 1,
        encodeMode: "encode",
      },
    ]);
  };

  const handleRemoveParam = (index: number) => {
    setParams((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleAddGroupEditParam = () => {
    setGroupEditParams((prev) => [
      ...prev,
      { key: "", value: "", location: "query", order: prev.length + 1, role: null },
    ]);
  };

  const handleRemoveGroupEditParam = (index: number) => {
    setGroupEditParams((prev) => prev.filter((_, idx) => idx !== index));
  };

  const fetchDbSettings = useCallback(async () => {
    setDbSettingsError("");
    try {
      const response = await fetch("/api/db/settings", { cache: "no-store" });
      const payload = (await response.json()) as {
        ok?: boolean;
        settings?: Array<{ id: number; settingName: string }>;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "DB 설정 목록을 불러오지 못했습니다.");
      }
      const options = (payload.settings ?? [])
        .filter(
          (item) =>
            Number.isFinite(item.id) &&
            item.id > 0 &&
            typeof item.settingName === "string",
        )
        .map((item) => ({
          id: Number(item.id),
          settingName: item.settingName,
        }));
      setDbSettings(options);
      if (options.length === 0) {
        setSelectedDbSettingId("");
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(INGESTION_DB_SETTING_STORAGE_KEY);
        }
        setDbSettingsError("DB 설정이 없습니다. 먼저 DB 설정에서 등록하세요.");
        return;
      }
      setSelectedDbSettingId((prev) => {
        const saved =
          typeof window !== "undefined"
            ? window.localStorage.getItem(INGESTION_DB_SETTING_STORAGE_KEY)
            : null;
        if (saved) {
          const savedExists = options.some((item) => String(item.id) === saved);
          if (savedExists) return saved;
        }
        if (prev) {
          const exists = options.some((item) => String(item.id) === prev);
          if (exists) return prev;
        }
        return String(options[0].id);
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "DB 설정 목록을 불러오지 못했습니다.";
      setDbSettings([]);
      setSelectedDbSettingId("");
      setDbSettingsError(message);
    }
  }, []);

  const fetchApiList = useCallback(async () => {
    setApiListStatus({ type: "loading", message: "" });
    try {
      const response = await fetch(withDbSettingQuery("/api/ingestion/api-config"));
      const payload = (await response.json()) as {
        ok?: boolean;
        sources?: Array<{
          id: number;
          name: string;
          provider: string;
          base_url: string;
          api_key: string | null;
          enabled: boolean;
          is_template?: boolean;
          created_at: string;
          groups: Array<{
            id: number;
            name: string | null;
            is_template?: boolean;
            created_at: string;
            schedule_enabled?: boolean | null;
            schedule_type?: "interval" | "cron" | null;
            schedule_interval_minutes?: number | null;
            schedule_cron_expr?: string | null;
            target_schema?: string | null;
            target_table?: string | null;
            target_truncate?: boolean | null;
            target_merge_sql?: string | null;
            params: Array<{
              id: number;
              param_key: string;
              param_value: string;
              param_location: string;
              param_order: number;
            }>;
          }>;
        }>;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "목록을 불러오지 못했습니다.");
      }
      setApiList(
        (payload.sources ?? [])
          .filter((sourceItem) => !sourceItem.is_template)
          .map((sourceItem) => ({
            ...sourceItem,
            groups: (sourceItem.groups ?? []).filter((group) => !group.is_template),
          })),
      );
      setApiListStatus({ type: "idle", message: "" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "목록을 불러오지 못했습니다.";
      setApiListStatus({ type: "error", message });
    }
  }, [withDbSettingQuery]);

  const fetchApiTemplates = useCallback(async () => {
    try {
      const response = await fetch(
        withDbSettingQuery("/api/ingestion/api-config?template=true"),
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        sources?: Array<typeof apiList[number]>;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "템플릿을 불러오지 못했습니다.");
      }
      setApiTemplates(payload.sources ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "템플릿을 불러오지 못했습니다.";
      setApiListStatus({ type: "error", message });
    }
  }, [withDbSettingQuery]);

  const fetchIngestionStatus = useCallback(async () => {
    setIngestionLoading(true);
    setIngestionError("");
    try {
      const response = await fetch("/api/visualization/ingestion-status");
      const payload = (await response.json()) as {
        ok?: boolean;
        summary?: IngestionStatusSummary;
        daily?: IngestionStatusDaily[];
        dailyDetails?: IngestionStatusDailyDetail[];
        recentFailures?: IngestionStatusFailure[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "수집 현황을 불러오지 못했습니다.");
      }
      setIngestionSummary(payload.summary ?? null);
      const nextDailyRows = payload.daily ?? [];
      setIngestionDailyRows(nextDailyRows);
      setIngestionDailyDetailRows(payload.dailyDetails ?? []);
      setSelectedDailyDate((prev) => {
        if (prev && nextDailyRows.some((row) => row.runDate === prev)) return prev;
        return nextDailyRows[nextDailyRows.length - 1]?.runDate ?? null;
      });
      setIngestionFailureRows(payload.recentFailures ?? []);
      setIngestionStatusLoaded(true);
    } catch (error) {
      setIngestionError(error instanceof Error ? error.message : "수집 현황을 불러오지 못했습니다.");
    } finally {
      setIngestionLoading(false);
    }
  }, []);
  const fetchMappingStatus = useCallback(async () => {
    setMappingStatusLoading(true);
    setMappingStatusError("");
    try {
      const response = await fetch(withDbSettingQuery("/api/visualization/map-status"));
      const payload = (await response.json()) as {
        ok?: boolean;
        summary?: MappingStatusSummary;
        daily?: MappingStatusDaily[];
        dailyDetails?: MappingStatusDailyDetail[];
        recentFailures?: MappingStatusFailure[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "매핑 현황을 불러오지 못했습니다.");
      }
      setMappingSummary(payload.summary ?? null);
      const nextDailyRows = payload.daily ?? [];
      setMappingDailyRows(nextDailyRows);
      setMappingDailyDetailRows(payload.dailyDetails ?? []);
      setSelectedMappingDailyDate((prev) => {
        if (prev && nextDailyRows.some((row) => row.runDate === prev)) return prev;
        return nextDailyRows[nextDailyRows.length - 1]?.runDate ?? null;
      });
      setMappingFailureRows(payload.recentFailures ?? []);
      setMappingStatusLoaded(true);
    } catch (error) {
      setMappingStatusError(error instanceof Error ? error.message : "매핑 현황을 불러오지 못했습니다.");
    } finally {
      setMappingStatusLoading(false);
    }
  }, [withDbSettingQuery]);

  useEffect(() => {
    void fetchDbSettings();
  }, [fetchDbSettings]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!selectedDbSettingId) return;
    window.localStorage.setItem(
      INGESTION_DB_SETTING_STORAGE_KEY,
      selectedDbSettingId,
    );
  }, [selectedDbSettingId]);

  useEffect(() => {
    if (!selectedDbSettingId) return;
    void fetchApiList();
    void fetchApiTemplates();
    setMappingStatusLoaded(false);
    setMappingSummary(null);
    setMappingDailyRows([]);
    setMappingDailyDetailRows([]);
    setSelectedMappingDailyDate(null);
    setMappingFailureRows([]);
    setMappingStatusError("");
  }, [fetchApiList, fetchApiTemplates, selectedDbSettingId]);

  useEffect(() => {
    if (activeTab !== "apiStatus") return;
    if (ingestionStatusLoaded) return;
    void fetchIngestionStatus();
  }, [activeTab, fetchIngestionStatus, ingestionStatusLoaded]);
  useEffect(() => {
    if (activeTab !== "mappingStatus") return;
    if (mappingStatusLoaded) return;
    void fetchMappingStatus();
  }, [activeTab, fetchMappingStatus, mappingStatusLoaded]);

  const handleCreateSource = useCallback(async () => {
    if (
      !sourceCreate.name.trim() ||
      !sourceCreate.provider.trim() ||
      !sourceCreate.baseUrl.trim() ||
      !sourceCreate.apiKey.trim()
    ) {
      setApiListStatus({ type: "error", message: "모든 값을 입력하세요." });
      return;
    }
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            source: {
              name: sourceCreate.name.trim(),
              provider: sourceCreate.provider.trim(),
              baseUrl: sourceCreate.baseUrl.trim(),
              apiKey: sourceCreate.apiKey.trim(),
              enabled: true,
            },
          }),
        ),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "등록에 실패했습니다.");
      }
      setSourceCreate({ name: "", provider: "", baseUrl: "", apiKey: "" });
      setShowSourceCreate(false);
      setApiListStatus({ type: "idle", message: "" });
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "등록에 실패했습니다.";
      setApiListStatus({ type: "error", message });
    }
  }, [fetchApiList, sourceCreate, withDbSettingBody]);

  const handleToggleSourceSelect = useCallback((id: number, checked: boolean) => {
    setSelectedSourceIds((prev) => {
      if (checked) return Array.from(new Set([...prev, id]));
      return prev.filter((item) => item !== id);
    });
  }, []);

  const handleToggleAllSources = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedSourceIds(apiList.map((item) => item.id));
      } else {
        setSelectedSourceIds([]);
      }
    },
    [apiList],
  );

  const handleDeleteSelectedSources = useCallback(async () => {
    if (selectedSourceIds.length === 0) {
      setShowDeleteSelectAlert(true);
      return;
    }
    try {
      for (const sourceId of selectedSourceIds) {
        const response = await fetch("/api/ingestion/api-config", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withDbSettingBody({ sourceId })),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "삭제에 실패했습니다.");
        }
      }
      setSelectedSourceIds([]);
      setApiListStatus({ type: "idle", message: "" });
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "삭제에 실패했습니다.";
      setApiListStatus({ type: "error", message });
    }
  }, [fetchApiList, selectedSourceIds, withDbSettingBody]);

  const handleStartEditSource = useCallback(
    (sourceItem: (typeof apiList)[number]) => {
      setEditingSourceId(sourceItem.id);
      setEditSource({
        name: sourceItem.name,
        provider: sourceItem.provider,
        baseUrl: sourceItem.base_url,
        apiKey: sourceItem.api_key ?? "",
        apiKeyParamKey: sourceItem.api_key_param_key ?? "",
        apiKeyLocation: sourceItem.api_key_location ?? "query",
        apiKeyOrder: sourceItem.api_key_order ?? 0,
        apiKeyEncodeMode: sourceItem.api_key_encode_mode ?? "encode",
      });
    },
    [],
  );

  const handleCancelEditSource = useCallback(() => {
    setEditingSourceId(null);
    setEditSource({
      name: "",
      provider: "",
      baseUrl: "",
      apiKey: "",
      apiKeyParamKey: "",
      apiKeyLocation: "query",
      apiKeyOrder: 0,
      apiKeyEncodeMode: "encode",
    });
  }, []);

  const handleSaveEditSource = useCallback(async () => {
    if (
      !editSource.name.trim() ||
      !editSource.provider.trim() ||
      !editSource.baseUrl.trim() ||
      !editSource.apiKey.trim()
    ) {
      setApiListStatus({ type: "error", message: "모든 값을 입력하세요." });
      return;
    }
    if (!editingSourceId) return;
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            updateTarget: "source",
            sourceId: editingSourceId,
            source: {
              name: editSource.name.trim(),
              provider: editSource.provider.trim(),
              baseUrl: editSource.baseUrl.trim(),
              apiKey: editSource.apiKey.trim(),
              enabled: true,
              apiKeyParamKey: editSource.apiKeyParamKey.trim(),
              apiKeyLocation: editSource.apiKeyLocation,
              apiKeyOrder: editSource.apiKeyOrder,
              apiKeyEncodeMode: editSource.apiKeyEncodeMode,
            },
          }),
        ),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "수정에 실패했습니다.");
      }
      setApiListStatus({ type: "idle", message: "" });
      handleCancelEditSource();
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "수정에 실패했습니다.";
      setApiListStatus({ type: "error", message });
    }
  }, [editSource, editingSourceId, fetchApiList, handleCancelEditSource, withDbSettingBody]);

  const buildTestUrl = useCallback(
    () =>
      buildUrlFromSourceParams(
        {
          baseUrl: source.baseUrl,
          apiKey: source.apiKey,
          apiKeyParamKey: source.apiKeyParamKey,
          apiKeyLocation: source.apiKeyLocation,
          apiKeyOrder: source.apiKeyOrder,
          apiKeyEncodeMode: source.apiKeyEncodeMode,
        },
        params,
      ),
    [
      buildUrlFromSourceParams,
      params,
      source.apiKey,
      source.apiKeyEncodeMode,
      source.apiKeyLocation,
      source.apiKeyOrder,
      source.apiKeyParamKey,
      source.baseUrl,
    ],
  );
  const requestPreviewUrl = useMemo(() => {
    if (!source.baseUrl.trim()) return "";
    try {
      return buildTestUrl();
    } catch {
      return "";
    }
  }, [buildTestUrl, source.baseUrl]);

  const handleTest = async () => {
    setTestStatus({ type: "idle", message: "" });
    setSubmitStatus({ type: "idle", message: "" });
    if (!canSubmit) {
      setTestStatus({ type: "error", message: "모든 값을 입력하세요." });
      return;
    }
    try {
      const url = buildTestUrl();
      const response = await fetch(`/api/collect?url=${encodeURIComponent(url)}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "API 호출에 실패했습니다.");
      }
      setTestStatus({ type: "success", message: "API 호출 성공" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "API 호출에 실패했습니다.";
      setTestStatus({ type: "error", message });
    }
  };

  const buildTestUrlForSource = useCallback(
    (
      sourceItem: (typeof apiList)[number],
      group: (typeof apiList)[number]["groups"][number] | null,
    ) => {
      if (!group) return null;
      return buildUrlFromSourceParams(
        resolveSourceForRequestUrl(sourceItem),
        group.params.map((item) => ({
          key: item.param_key,
          value: item.param_value,
          location: item.param_location as "path" | "query",
          order: item.param_order,
          encodeMode: item.encode_mode ?? "encode",
          role: item.param_role ?? null,
        })),
      );
    },
    [buildUrlFromSourceParams, resolveSourceForRequestUrl],
  );

  const handleListTest = useCallback(
    async (
      sourceItem: (typeof apiList)[number],
      group: (typeof apiList)[number]["groups"][number],
    ) => {
      const url = buildTestUrlForSource(sourceItem, group);
      if (!url) {
        setApiListStatus({ type: "error", message: "테스트할 파라미터가 없습니다." });
        return;
      }
      try {
        const response = await fetch(`/api/collect?url=${encodeURIComponent(url)}`);
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "API 호출에 실패했습니다.");
        }
        setGroupTestStatus({
          groupId: group.id,
          type: "success",
          message: "테스트 성공",
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "API 호출에 실패했습니다.";
        setGroupTestStatus({
          groupId: group.id,
          type: "error",
          message,
        });
      }
    },
    [buildTestUrlForSource],
  );

  const openGroupScheduleEdit = useCallback(
    (sourceItem: (typeof apiList)[number], group: (typeof apiList)[number]["groups"][number]) => {
      setGroupScheduleTarget({
        sourceId: sourceItem.id,
        groupId: group.id,
        name: group.name ?? "API",
      });
      setGroupScheduleForm({
        enabled: Boolean(group.schedule_enabled),
        type: group.schedule_type === "cron" ? "cron" : "interval",
        intervalMinutes: Number.isFinite(group.schedule_interval_minutes)
          ? Number(group.schedule_interval_minutes)
          : 60,
        cronExpr: group.schedule_cron_expr ?? "",
      });
    },
    [],
  );

  const handleSaveGroupSchedule = useCallback(async () => {
    if (!groupScheduleTarget) return;
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            updateTarget: "groupSchedule",
            sourceId: groupScheduleTarget.sourceId,
            groupId: groupScheduleTarget.groupId,
            schedule: {
              enabled: groupScheduleForm.enabled,
              type: groupScheduleForm.type,
              intervalMinutes:
                groupScheduleForm.type === "interval"
                  ? groupScheduleForm.intervalMinutes
                  : null,
              cronExpr:
                groupScheduleForm.type === "cron"
                  ? groupScheduleForm.cronExpr.trim()
                  : null,
            },
          }),
        ),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "스케줄 저장에 실패했습니다.");
      }
      setGroupScheduleTarget(null);
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "스케줄 저장에 실패했습니다.";
      setApiListStatus({ type: "error", message });
    }
  }, [fetchApiList, groupScheduleForm, groupScheduleTarget, withDbSettingBody]);

  const fetchMetaTables = useCallback(async (schema: string) => {
    const response = await fetch("/api/ingestion/db-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withDbSettingBody({ action: "tables", schema })),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      tables?: string[];
      error?: string;
    };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "테이블 목록을 불러오지 못했습니다.");
    }
    return payload.tables ?? [];
  }, [withDbSettingBody]);

  const openGroupTableMap = useCallback(
    async (
      sourceItem: (typeof apiList)[number],
      group: (typeof apiList)[number]["groups"][number],
    ) => {
      const initialSchema = group.target_schema ?? "public";
      const initialTable = group.target_table ?? "";
      const initialMergeSql = group.target_merge_sql ?? "";
      setGroupTableMapTarget({
        sourceId: sourceItem.id,
        groupId: group.id,
        name: group.name ?? "API",
      });
      setGroupTableMapForm({
        schema: initialSchema,
        table: initialTable,
        truncate: Boolean(group.target_truncate),
        mergeSql: initialMergeSql,
        schemas: [],
        tables: [],
        loadingSchemas: true,
        loadingTables: true,
      });
      try {
        const schemaResponse = await fetch("/api/ingestion/db-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withDbSettingBody({ action: "schemas" })),
        });
        const schemaPayload = (await schemaResponse.json()) as {
          ok?: boolean;
          schemas?: string[];
          error?: string;
        };
        if (!schemaResponse.ok || !schemaPayload.ok) {
          throw new Error(schemaPayload.error || "스키마 목록을 불러오지 못했습니다.");
        }
        const tables = await fetchMetaTables(initialSchema);
        setGroupTableMapForm((prev) => ({
          ...prev,
          schemas: schemaPayload.schemas ?? [],
          tables,
          loadingSchemas: false,
          loadingTables: false,
        }));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "매핑 정보를 불러오지 못했습니다.";
        setGroupTableMapForm((prev) => ({
          ...prev,
          loadingSchemas: false,
          loadingTables: false,
        }));
        setApiListStatus({ type: "error", message });
      }
    },
    [fetchMetaTables, withDbSettingBody],
  );

  const handleSaveGroupTableMap = useCallback(async () => {
    if (!groupTableMapTarget) return;
    try {
      if (!groupTableMapForm.table.toLowerCase().endsWith("_lrd")) {
        throw new Error("임시 적재 테이블명은 _LRD 로 끝나야 합니다.");
      }
      const response = await fetch("/api/ingestion/api-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            updateTarget: "groupTargetTable",
            sourceId: groupTableMapTarget.sourceId,
            groupId: groupTableMapTarget.groupId,
            target: {
              schema: groupTableMapForm.schema,
              table: groupTableMapForm.table,
              truncate: groupTableMapForm.truncate,
              mergeSql: groupTableMapForm.mergeSql,
            },
          }),
        ),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "테이블 매핑 저장에 실패했습니다.");
      }
      setGroupTableMapTarget(null);
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "테이블 매핑 저장에 실패했습니다.";
      setApiListStatus({ type: "error", message });
    }
  }, [fetchApiList, groupTableMapForm, groupTableMapTarget, withDbSettingBody]);

  const handleRunGroupLoad = useCallback(
    async (sourceId: number, groupId: number, truncate: boolean) => {
      const loadTaskId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setRunningLoadTaskId(loadTaskId);
      setApiLoadCancelBusy(false);
      setApiLoadStatus({ type: "loading", message: "적재 실행 중..." });
      try {
        const response = await fetch("/api/ingestion/api-load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            withDbSettingBody({
              sourceId,
              groupId,
              truncate,
              loadTaskId,
            }),
          ),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          inserted?: number;
          cancelled?: boolean;
          error?: string;
          loadTaskId?: string;
        };
        if (!response.ok || !payload.ok) {
          if (payload.cancelled) {
            setApiLoadStatus({
              type: "cancelled",
              message: payload.error || "적재가 취소되었습니다.",
            });
            return;
          }
          throw new Error(payload.error || "적재에 실패했습니다.");
        }
        setApiLoadStatus({
          type: "success",
          message: `적재 완료 (${payload.inserted ?? 0}건)`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "적재에 실패했습니다.";
        setApiLoadStatus({ type: "error", message });
      } finally {
        setRunningLoadTaskId(null);
        setApiLoadCancelBusy(false);
      }
    },
    [withDbSettingBody],
  );
  const handleCancelApiLoad = useCallback(async () => {
    if (!runningLoadTaskId) return;
    setApiLoadCancelBusy(true);
    try {
      const response = await fetch("/api/ingestion/api-load/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            loadTaskId: runningLoadTaskId,
          }),
        ),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "적재 중단에 실패했습니다.");
      }
      setApiLoadStatus({ type: "cancelled", message: "적재 중단 요청이 완료되었습니다." });
      setRunningLoadTaskId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "적재 중단에 실패했습니다.";
      setApiLoadStatus({ type: "error", message });
    } finally {
      setApiLoadCancelBusy(false);
    }
  }, [runningLoadTaskId, withDbSettingBody]);

  const handleSubmit = async () => {
    setSubmitStatus({ type: "idle", message: "" });
    setTestStatus({ type: "idle", message: "" });
    if (!canSubmit) {
      setSubmitStatus({ type: "error", message: "모든 값을 입력하세요." });
      return;
    }
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            source: {
              name: source.name.trim(),
              provider: source.provider,
              baseUrl: source.baseUrl.trim(),
              apiKey: source.apiKey.trim(),
              enabled: source.enabled,
              apiKeyParamKey: source.apiKeyParamKey?.trim() || null,
              apiKeyLocation: source.apiKeyLocation,
              apiKeyOrder: source.apiKeyOrder,
              apiKeyEncodeMode: source.apiKeyEncodeMode,
            },
            groupName: groupName.trim(),
            params: params
              .map((item) => ({
                key: item.key.trim(),
                value: item.value.trim(),
                location: item.location,
                order: Number.isFinite(item.order) ? item.order : 0,
                encodeMode: item.encodeMode ?? "encode",
                role: item.role ?? null,
              }))
              .filter((item) => item.key && item.value),
          }),
        ),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "저장에 실패했습니다.");
      }
      setSubmitStatus({
        type: "success",
        message: "저장되었습니다.",
      });
      setShowApiModal(false);
      setShowSuccessModal(true);
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "저장에 실패했습니다.";
      setSubmitStatus({ type: "error", message });
    }
  };

  const openSourceEdit = useCallback((sourceItem: (typeof apiList)[number]) => {
    setSourceEdit({
      name: sourceItem.name,
      provider: sourceItem.provider,
      baseUrl: sourceItem.base_url,
      apiKey: sourceItem.api_key ?? "",
      enabled: sourceItem.enabled,
    });
    setSourceEditStatus({ type: "idle", message: "" });
    setGroupEditTarget(null);
    setSourceEditTarget({ id: sourceItem.id });
  }, []);

  const openGroupEdit = useCallback(
    (sourceItem: (typeof apiList)[number], group: (typeof apiList)[number]["groups"][number]) => {
      setGroupEditName(group.name ?? "");
      setGroupEditProvider(sourceItem.provider);
      setShowGroupParamGuide(false);
      if (group.params.length > 0) {
        setGroupEditParams(
          group.params.map((param) => ({
            key: param.param_key,
            value: param.param_value,
            location: (param.param_location as "path" | "query") ?? "query",
            order: Number.isFinite(param.param_order) ? param.param_order : 0,
            role: param.param_role ?? null,
          })),
        );
      } else {
        setGroupEditParams([{ key: "", value: "", location: "query", order: 1, role: null }]);
      }
      setGroupEditStatus({ type: "idle", message: "" });
      setGroupEditTarget({ sourceId: sourceItem.id, groupId: group.id });
      setSourceEditTarget(null);
    },
    [],
  );

  const handleSourceEditSave = useCallback(async () => {
    if (!sourceEditTarget) return;
    setSourceEditStatus({ type: "idle", message: "" });
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            updateTarget: "source",
            sourceId: sourceEditTarget.id,
            source: {
              name: sourceEdit.name.trim(),
              provider: sourceEdit.provider,
              baseUrl: sourceEdit.baseUrl.trim(),
              apiKey: sourceEdit.apiKey.trim(),
              enabled: sourceEdit.enabled,
            },
          }),
        ),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "수정에 실패했습니다.");
      }
      setSourceEditStatus({ type: "success", message: "수정되었습니다." });
      setSourceEditTarget(null);
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "수정에 실패했습니다.";
      setSourceEditStatus({ type: "error", message });
    }
  }, [fetchApiList, sourceEdit, sourceEditTarget, withDbSettingBody]);

  const handleGroupEditSave = useCallback(async () => {
    if (!groupEditTarget) return;
    setGroupEditStatus({ type: "idle", message: "" });
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            updateTarget: "group",
            sourceId: groupEditTarget.sourceId,
            groupId: groupEditTarget.groupId,
            groupName: groupEditName.trim(),
            source: {
              provider: groupEditProvider,
            },
            params: groupEditParams
              .map((item) => ({
                key: item.key.trim(),
                value: item.value.trim(),
                location: item.location,
                order: Number.isFinite(item.order) ? item.order : 0,
              }))
              .filter((item) => item.key && item.value),
          }),
        ),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "수정에 실패했습니다.");
      }
      setGroupEditStatus({ type: "success", message: "수정되었습니다." });
      setShowGroupParamGuide(false);
      setGroupEditTarget(null);
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "수정에 실패했습니다.";
      setGroupEditStatus({ type: "error", message });
    }
  }, [
    fetchApiList,
    groupEditName,
    groupEditParams,
    groupEditProvider,
    groupEditTarget,
    withDbSettingBody,
  ]);

  const handleDeleteSource = useCallback((sourceItem: (typeof apiList)[number]) => {
    setDeleteTarget({ id: sourceItem.id, name: sourceItem.name });
  }, []);

  const confirmDeleteSource = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDbSettingBody({ sourceId: deleteTarget.id })),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "삭제에 실패했습니다.");
      }
      setDeleteTarget(null);
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "삭제에 실패했습니다.";
      setApiListStatus({ type: "error", message });
      setDeleteTarget(null);
    }
  }, [deleteTarget, fetchApiList, withDbSettingBody]);

  const handleDeleteGroup = useCallback(
    (sourceItem: (typeof apiList)[number], group: (typeof apiList)[number]["groups"][number]) => {
      setGroupDeleteTarget({
        sourceId: sourceItem.id,
        groupId: group.id,
        name: group.name || "그룹",
      });
    },
    [],
  );

  const confirmDeleteGroup = useCallback(async () => {
    if (!groupDeleteTarget) return;
    try {
      const response = await fetch("/api/ingestion/api-config", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbSettingBody({
            sourceId: groupDeleteTarget.sourceId,
            groupId: groupDeleteTarget.groupId,
          }),
        ),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "삭제에 실패했습니다.");
      }
      setGroupDeleteTarget(null);
      void fetchApiList();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "삭제에 실패했습니다.";
      setApiListStatus({ type: "error", message });
      setGroupDeleteTarget(null);
    }
  }, [fetchApiList, groupDeleteTarget, withDbSettingBody]);

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
        <h2 className="text-xl font-semibold text-slate-900">데이터 수집</h2>
        <p className="mt-2 text-sm text-slate-600">
          수집 현황과 수집 설정을 분리해 운영하며, API 중심으로 엑셀/기타
          수집 방식까지 확장할 수 있습니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2">
              <span className="text-xs font-semibold text-slate-600">DB 연결</span>
              <select
                value={selectedDbSettingId}
                onChange={(event) => setSelectedDbSettingId(event.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none"
                disabled={dbSettings.length === 0}
              >
                {dbSettings.length === 0 ? (
                  <option value="">설정 없음</option>
                ) : null}
                {dbSettings.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.settingName}
                  </option>
                ))}
              </select>
            </div>
          <a
            href="/workflow"
            className="inline-flex items-center rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
          >
            워크플로우 열기 →
          </a>
        </div>
      </div>
      {dbSettingsError ? (
        <p className="mt-3 text-xs text-rose-600">{dbSettingsError}</p>
      ) : null}
      </header>

      <div className="rounded-3xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-4 border-b border-slate-200">
          {ingestionTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`border-b-2 pb-2 text-sm font-semibold transition ${
                activeTab === tab.key
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "apiStatus" ? (
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold leading-6 text-slate-900">수집 현황</h3>
                <span className="text-xs text-slate-500">(기준 날짜: {kpiBaseDateLabel})</span>
              </div>
              <button
                onClick={() => void fetchIngestionStatus()}
                className="inline-flex h-7 items-center rounded-full border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                새로고침
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4 border-b border-slate-100">
              {ingestionChannelFilters.map((filter) => (
                <button
                  key={filter}
                  onClick={() => setChannelFilter(filter)}
                  className={`border-b-2 pb-1 text-xs font-semibold transition ${
                    channelFilter === filter
                      ? "border-slate-900 text-slate-900"
                      : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>
            {ingestionLoading && !ingestionSummary ? <p className="mt-3 text-sm text-slate-500">불러오는 중...</p> : null}
            {ingestionError ? <p className="mt-3 text-sm text-rose-600">{ingestionError}</p> : null}
            {!ingestionError && filteredIngestionSummary ? (
              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[11px] text-slate-500">전체</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{formatNumber(filteredIngestionSummary.totalRuns)}</p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-[11px] text-emerald-700">성공</p>
                  <p className="mt-1 text-lg font-semibold text-emerald-700">{formatNumber(filteredIngestionSummary.successRuns)}</p>
                </div>
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3">
                  <p className="text-[11px] text-rose-700">실패</p>
                  <p className="mt-1 text-lg font-semibold text-rose-700">{formatNumber(filteredIngestionSummary.errorRuns)}</p>
                </div>
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-3">
                  <p className="text-[11px] text-indigo-700">성공률</p>
                  <p className="mt-1 text-lg font-semibold text-indigo-700">{filteredIngestionSummary.successRate.toFixed(1)}%</p>
                </div>
              </div>
            ) : null}
            {!ingestionError && !filteredIngestionSummary && !ingestionLoading ? (
              <p className="mt-4 text-xs text-slate-500">
                {channelFilter} 수집 데이터는 아직 연결되지 않았습니다.
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <h4 className="text-sm font-semibold text-slate-900">일별 실행 추이 (최근 7일)</h4>
              <div className="mt-3 space-y-2">
                {displayedIngestionDailyRows.length === 0 ? (
                  <p className="text-xs text-slate-500">실행 로그가 없습니다.</p>
                ) : (
                  displayedIngestionDailyRows.map((row) => {
                    const total = Math.max(row.totalRuns, 1);
                    const successPercent = Math.round((row.successRuns / total) * 100);
                    const errorPercent = Math.max(0, 100 - successPercent);
                    const totalWidth = Math.max(4, Math.round((row.totalRuns / displayedIngestionDailyMaxRuns) * 100));
                    const isSelected = row.runDate === selectedDailyDate;
                    return (
                      <button
                        key={`daily-${row.runDate}`}
                        type="button"
                        onClick={() => setSelectedDailyDate(row.runDate)}
                        className={`grid w-full grid-cols-[88px_1fr_118px] items-center gap-2 rounded-lg px-1 py-1 text-left transition ${
                          isSelected ? "bg-slate-50" : "hover:bg-slate-50"
                        }`}
                      >
                        <span className="text-[11px] text-slate-600">{row.runDate.slice(5).replace("-", ".")}</span>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="flex h-2 rounded-full overflow-hidden" style={{ width: `${totalWidth}%` }}>
                            <div className="h-2 bg-emerald-500" style={{ width: `${successPercent}%` }} />
                            <div className="h-2 bg-rose-400" style={{ width: `${errorPercent}%` }} />
                          </div>
                        </div>
                        <span className="flex items-center justify-end gap-1">
                          <span className="inline-flex w-8 justify-center rounded-full border border-emerald-200 bg-emerald-50 py-0.5 text-[10px] font-semibold text-emerald-700">
                            {row.successRuns}
                          </span>
                          <span className="inline-flex w-8 justify-center rounded-full border border-rose-200 bg-rose-50 py-0.5 text-[10px] font-semibold text-rose-700">
                            {row.errorRuns}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  성공
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-rose-400" />
                  실패
                </span>
                <span>클릭하면 해당 일자 상세를 볼 수 있습니다.</span>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <h4 className="text-sm font-semibold text-slate-900">
                {selectedDailyDate
                  ? `${selectedDailyDate.replaceAll("-", ".")} 수행 상세`
                  : "선택 일자 수행 상세"}
              </h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3">
                  <p className="text-xs font-semibold text-emerald-700">성공 ({selectedDateSuccessRows.length}건)</p>
                  <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                    {selectedDateSuccessRows.length === 0 ? (
                      <p className="text-xs text-emerald-700/80">성공 데이터가 없습니다.</p>
                    ) : (
                      selectedDateSuccessRows.map((row) => (
                        <div key={`day-success-${row.loadLogId}`} className="rounded-lg border border-emerald-200 bg-white px-2 py-1.5 text-[11px] text-slate-700">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-slate-800">{row.sourceName}</p>
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
                              {row.triggerType === "schedule" ? "스케줄" : "수동"}
                            </span>
                          </div>
                          <p className="text-slate-500">{row.groupName || "-"}</p>
                          <p className="text-slate-500">
                            {new Date(row.startedAt).toLocaleTimeString()} / {formatNumber(row.insertedCount)}건
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-3">
                  <p className="text-xs font-semibold text-rose-700">실패 ({selectedDateErrorRows.length}건)</p>
                  <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                    {selectedDateErrorRows.length === 0 ? (
                      <p className="text-xs text-rose-700/80">실패 데이터가 없습니다.</p>
                    ) : (
                      selectedDateErrorRows.map((row) => (
                        <div key={`day-error-${row.loadLogId}`} className="rounded-lg border border-rose-200 bg-white px-2 py-1.5 text-[11px] text-slate-700">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-slate-800">{row.sourceName}</p>
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
                              {row.triggerType === "schedule" ? "스케줄" : "수동"}
                            </span>
                          </div>
                          <p className="text-slate-500">{row.groupName || "-"}</p>
                          <p className="text-slate-500">{new Date(row.startedAt).toLocaleTimeString()}</p>
                          <p className="mt-1 text-rose-700">{row.errorMessage || "에러 메시지 없음"}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
              {!selectedDailyDate ? (
                <p className="mt-3 text-xs text-slate-500">좌측 일별 실행 추이에서 날짜를 선택하세요.</p>
              ) : null}
              {selectedDailyDate && selectedDateDetailRows.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">
                  선택한 일자의 성공/실패 상세 데이터가 없습니다.
                </p>
              ) : null}
              {!shouldShowApiData ? (
                <p className="mt-3 text-xs text-slate-500">
                  {channelFilter} 유형은 수집 상세 데이터가 아직 없습니다.
                </p>
              ) : null}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <h4 className="text-sm font-semibold text-slate-900">실행 로그</h4>
            <div className="mt-3 space-y-2">
              {filteredIngestionFailureRows.length === 0 ? (
                <p className="text-xs text-slate-500">실행 로그가 없습니다.</p>
              ) : (
                filteredIngestionFailureRows.map((row) => (
                  <div
                    key={`fail-${row.loadLogId}`}
                    className={`rounded-xl border p-3 ${
                      row.status === "success"
                        ? "border-emerald-200 bg-emerald-50"
                        : row.status === "running"
                          ? "border-amber-200 bg-amber-50"
                          : "border-rose-200 bg-rose-50"
                    }`}
                  >
                    <div
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] ${
                        row.status === "success"
                          ? "text-emerald-700"
                          : row.status === "running"
                            ? "text-amber-700"
                            : "text-rose-700"
                      }`}
                    >
                      <span className="font-semibold">{new Date(row.startedAt).toLocaleString()}</span>
                      <span>{row.sourceName}</span>
                      <span>{row.groupName || "-"}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 ${
                          row.status === "success"
                            ? "border border-emerald-300"
                            : row.status === "running"
                              ? "border border-amber-300"
                              : "border border-rose-300"
                        }`}
                      >
                        {row.status === "success"
                          ? "성공"
                          : row.status === "running"
                            ? "실행중"
                            : `실패${row.errorStage ? ` (${row.errorStage})` : ""}`}
                      </span>
                    </div>
                    {row.status === "error" ? (
                      <p className="mt-1 text-xs text-rose-700">{row.errorMessage || "에러 메시지 없음"}</p>
                    ) : (
                      <p className="mt-1 text-xs text-slate-700">적재건수: {formatNumber(row.insertedCount)}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : activeTab === "mappingStatus" ? (
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold leading-6 text-slate-900">매핑 현황</h3>
                <span className="text-xs text-slate-500">(기준 날짜: {kpiBaseDateLabel})</span>
              </div>
              <button
                onClick={() => void fetchMappingStatus()}
                className="inline-flex h-7 items-center rounded-full border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                새로고침
              </button>
            </div>
            {mappingStatusLoading && !mappingSummary ? <p className="mt-3 text-sm text-slate-500">불러오는 중...</p> : null}
            {mappingStatusError ? <p className="mt-3 text-sm text-rose-600">{mappingStatusError}</p> : null}
            {!mappingStatusError && mappingSummary ? (
              <div className="mt-4 grid gap-3 md:grid-cols-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[11px] text-slate-500">전체</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{formatNumber(mappingSummary.totalRuns)}</p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-[11px] text-emerald-700">성공</p>
                  <p className="mt-1 text-lg font-semibold text-emerald-700">{formatNumber(mappingSummary.successRuns)}</p>
                </div>
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3">
                  <p className="text-[11px] text-rose-700">실패</p>
                  <p className="mt-1 text-lg font-semibold text-rose-700">{formatNumber(mappingSummary.errorRuns)}</p>
                </div>
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-3">
                  <p className="text-[11px] text-indigo-700">성공률</p>
                  <p className="mt-1 text-lg font-semibold text-indigo-700">{mappingSummary.successRate.toFixed(1)}%</p>
                </div>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-[11px] text-amber-700">반영건수</p>
                  <p className="mt-1 text-lg font-semibold text-amber-700">{formatNumber(mappingSummary.affectedTotal)}</p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <h4 className="text-sm font-semibold text-slate-900">일별 실행 추이 (최근 7일)</h4>
              <div className="mt-3 space-y-2">
                {displayedMappingDailyRows.length === 0 ? (
                  <p className="text-xs text-slate-500">실행 로그가 없습니다.</p>
                ) : (
                  displayedMappingDailyRows.map((row) => {
                    const total = Math.max(row.totalRuns, 1);
                    const successPercent = Math.round((row.successRuns / total) * 100);
                    const errorPercent = Math.max(0, 100 - successPercent);
                    const totalWidth = Math.max(4, Math.round((row.totalRuns / displayedMappingDailyMaxRuns) * 100));
                    const isSelected = row.runDate === selectedMappingDailyDate;
                    return (
                      <button
                        key={`map-daily-${row.runDate}`}
                        type="button"
                        onClick={() => setSelectedMappingDailyDate(row.runDate)}
                        className={`grid w-full grid-cols-[88px_1fr_118px] items-center gap-2 rounded-lg px-1 py-1 text-left transition ${
                          isSelected ? "bg-slate-50" : "hover:bg-slate-50"
                        }`}
                      >
                        <span className="text-[11px] text-slate-600">{row.runDate.slice(5).replace("-", ".")}</span>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="flex h-2 overflow-hidden rounded-full" style={{ width: `${totalWidth}%` }}>
                            <div className="h-2 bg-emerald-500" style={{ width: `${successPercent}%` }} />
                            <div className="h-2 bg-rose-400" style={{ width: `${errorPercent}%` }} />
                          </div>
                        </div>
                        <span className="flex items-center justify-end gap-1">
                          <span className="inline-flex w-8 justify-center rounded-full border border-emerald-200 bg-emerald-50 py-0.5 text-[10px] font-semibold text-emerald-700">
                            {row.successRuns}
                          </span>
                          <span className="inline-flex w-8 justify-center rounded-full border border-rose-200 bg-rose-50 py-0.5 text-[10px] font-semibold text-rose-700">
                            {row.errorRuns}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  성공
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-rose-400" />
                  실패
                </span>
                <span>클릭하면 해당 일자 상세를 볼 수 있습니다.</span>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <h4 className="text-sm font-semibold text-slate-900">
                {selectedMappingDailyDate
                  ? `${selectedMappingDailyDate.replaceAll("-", ".")} 수행 상세`
                  : "선택 일자 수행 상세"}
              </h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3">
                  <p className="text-xs font-semibold text-emerald-700">성공 ({selectedMappingDateSuccessRows.length}건)</p>
                  <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                    {selectedMappingDateSuccessRows.length === 0 ? (
                      <p className="text-xs text-emerald-700/80">성공 데이터가 없습니다.</p>
                    ) : (
                      selectedMappingDateSuccessRows.map((row) => (
                        <div key={`map-day-success-${row.runLogId}`} className="rounded-lg border border-emerald-200 bg-white px-2 py-1.5 text-[11px] text-slate-700">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-slate-800">{row.seriesName}</p>
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
                              {row.triggerType === "schedule" ? "스케줄" : "수동"}
                            </span>
                          </div>
                          <p className="text-slate-500">MAP ID: {row.mapId}</p>
                          <p className="text-slate-500">
                            {new Date(row.startedAt).toLocaleTimeString()} / {formatNumber(row.affectedCount)}건
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-3">
                  <p className="text-xs font-semibold text-rose-700">실패 ({selectedMappingDateErrorRows.length}건)</p>
                  <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                    {selectedMappingDateErrorRows.length === 0 ? (
                      <p className="text-xs text-rose-700/80">실패 데이터가 없습니다.</p>
                    ) : (
                      selectedMappingDateErrorRows.map((row) => (
                        <div key={`map-day-error-${row.runLogId}`} className="rounded-lg border border-rose-200 bg-white px-2 py-1.5 text-[11px] text-slate-700">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-slate-800">{row.seriesName}</p>
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
                              {row.triggerType === "schedule" ? "스케줄" : "수동"}
                            </span>
                          </div>
                          <p className="text-slate-500">MAP ID: {row.mapId}</p>
                          <p className="text-slate-500">{new Date(row.startedAt).toLocaleTimeString()}</p>
                          <p className="mt-1 text-rose-700">{row.errorMessage || "에러 메시지 없음"}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
              {!selectedMappingDailyDate ? (
                <p className="mt-3 text-xs text-slate-500">좌측 일별 실행 추이에서 날짜를 선택하세요.</p>
              ) : null}
              {selectedMappingDailyDate && selectedMappingDateDetailRows.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">선택한 일자의 성공/실패 상세 데이터가 없습니다.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <h4 className="text-sm font-semibold text-slate-900">실행 로그</h4>
            <div className="mt-3 space-y-2">
              {mappingFailureRows.length === 0 ? (
                <p className="text-xs text-slate-500">실행 로그가 없습니다.</p>
              ) : (
                mappingFailureRows.map((row) => (
                  <div
                    key={`map-log-${row.runLogId}`}
                    className={`rounded-xl border p-3 ${
                      row.status === "success"
                        ? "border-emerald-200 bg-emerald-50"
                        : row.status === "running"
                          ? "border-amber-200 bg-amber-50"
                          : "border-rose-200 bg-rose-50"
                    }`}
                  >
                    <div
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] ${
                        row.status === "success"
                          ? "text-emerald-700"
                          : row.status === "running"
                            ? "text-amber-700"
                            : "text-rose-700"
                      }`}
                    >
                      <span className="font-semibold">{new Date(row.startedAt).toLocaleString()}</span>
                      <span>{row.seriesName}</span>
                      <span>MAP ID: {row.mapId}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 ${
                          row.status === "success"
                            ? "border border-emerald-300"
                            : row.status === "running"
                              ? "border border-amber-300"
                              : "border border-rose-300"
                        }`}
                      >
                        {row.status === "success" ? "성공" : row.status === "running" ? "실행중" : "실패"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
                        {row.triggerType === "schedule" ? "스케줄" : "수동"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
                        {row.runMode === "regenerate" ? "전체생성" : "신규반영"}
                      </span>
                    </div>
                    {row.status === "error" ? (
                      <p className="mt-1 text-xs text-rose-700">{row.errorMessage || "에러 메시지 없음"}</p>
                    ) : (
                      <p className="mt-1 text-xs text-slate-700">반영건수: {formatNumber(row.affectedCount)}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-4">
            <div className="flex min-h-[42px] flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold leading-6 text-slate-900">
                {activeTab === "mappingSettings" ? "매핑 설정" : "수집 설정"}
              </h3>
              <div
                className={`flex flex-wrap items-center gap-4 border-b border-slate-200 ${
                  activeTab === "apiSettings" ? "" : "invisible"
                }`}
              >
                {ingestionSettingsTabs.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveSettingsTab(tab)}
                    className={`border-b-2 pb-2 text-sm font-semibold transition ${
                      activeSettingsTab === tab
                        ? "border-slate-900 text-slate-900"
                        : "border-transparent text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {activeTab === "apiSettings" && activeSettingsTab === "API 설정" ? (
            <>
            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <span className="text-base font-semibold leading-6 text-slate-900">API/기관 관리</span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setShowUserApiRegisterModal(true)}
                    className="inline-flex h-8 items-center rounded-full bg-slate-900 px-3 text-xs font-semibold text-white transition hover:bg-slate-800"
                  >
                    API 생성
                  </button>
                  <button
                    onClick={() => {
                      resetApiForm();
                      setApiView("list");
                      setShowApiModal(true);
                      void fetchApiList();
                    }}
                    className="inline-flex h-8 items-center rounded-full border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                  >
                    기관 관리
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold leading-6 text-slate-900">
                  API 설정 목록
                </h3>
                <span className="inline-flex h-7 items-center rounded-full border border-slate-200 px-3 text-xs font-semibold text-slate-500">
                  {apiGroupRows.length}건
                </span>
              </div>
              <div className="mt-4 space-y-3">
            {groupedApiGroups.map((grouped) => (
              <div
                key={`${grouped.sourceId}-${grouped.sourceName}`}
                className="overflow-hidden rounded-2xl border border-slate-200"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                  <div className="flex-1 min-w-[200px]">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">
                      기관명
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {grouped.sourceName}
                    </p>
                  </div>
                  <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600">
                    그룹 {grouped.groups.length}건
                  </span>
                </div>
                <div className="divide-y divide-slate-200 text-[11px]">
                  <div className="grid grid-cols-[1.05fr_2fr_150px_150px_170px_290px] gap-2 bg-white px-4 py-2 font-semibold text-slate-600">
                    <span>API 명</span>
                    <span>API URL</span>
                    <span>Created At</span>
                    <span>스케줄</span>
                    <span>적재</span>
                    <span className="text-center">작업</span>
                  </div>
                  {grouped.groups.map((group) => (
                    <div
                      key={group.id}
                      className="grid grid-cols-[1.05fr_2fr_150px_150px_170px_290px] items-center gap-2 px-4 py-2 text-slate-700"
                    >
                      <span>{group.name ?? ""}</span>
                      <span className="break-all text-slate-500">{group.endUrl}</span>
                      <span className="text-slate-500">
                        {new Date(group.created_at).toLocaleString()}
                      </span>
                      <span className="text-slate-500">
                        {group.scheduleEnabled
                          ? group.scheduleType === "cron"
                            ? `CRON: ${group.scheduleCronExpr ?? ""}`
                            : `${group.scheduleIntervalMinutes ?? 0}분 간격`
                          : "미사용"}
                      </span>
                      <span className="text-slate-500">
                        {group.targetTable
                          ? `${group.targetSchema ?? "public"}.${group.targetTable}`
                          : "미지정"}
                        {group.targetMergeSql?.trim() ? " / SQL설정" : ""}
                      </span>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => {
                            const sourceItem = apiList.find(
                              (item) => item.id === group.sourceId,
                            );
                            const fullGroup = sourceItem?.groups.find(
                              (item) => item.id === group.id,
                            );
                            if (sourceItem && fullGroup) {
                              void openGroupTableMap(sourceItem, fullGroup);
                            }
                          }}
                          className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-100"
                        >
                          테이블 설정
                        </button>
                        <button
                          onClick={() => {
                            const sourceItem = apiList.find(
                              (item) => item.id === group.sourceId,
                            );
                            const tbl = group.targetTable ?? "";
                            if (!tbl) return;
                            setDataMapScopeTarget({
                              sourceOrg: sourceItem?.provider ?? "",
                              sourceTable: tbl.replace(/_lrd$/i, ""),
                              apiName: group.name || "API",
                            });
                          }}
                          disabled={!group.targetTable}
                          title={
                            group.targetTable
                              ? "이 수집 원천으로 데이터 매핑 관리"
                              : "먼저 테이블 매핑 후 적재가 필요합니다"
                          }
                          className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          데이터 매핑
                        </button>
                        <button
                          onClick={() =>
                            void handleRunGroupLoad(
                              group.sourceId,
                              group.id,
                              group.targetTruncate,
                            )
                          }
                          disabled={apiLoadStatus.type === "loading"}
                          className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          적재
                        </button>
                        <button
                          onClick={() => {
                            const sourceItem = apiList.find(
                              (item) => item.id === group.sourceId,
                            );
                            const fullGroup = sourceItem?.groups.find(
                              (item) => item.id === group.id,
                            );
                            if (sourceItem && fullGroup) {
                              openGroupEdit(sourceItem, fullGroup);
                            }
                          }}
                          className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          수정
                        </button>
                        <button
                          onClick={() =>
                            setGroupDeleteTarget({
                              sourceId: group.sourceId,
                              groupId: group.id,
                              name: group.name ?? "API",
                            })
                          }
                          className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-600 hover:bg-rose-100"
                        >
                          삭제
                        </button>
                        <button
                          onClick={() => {
                            const sourceItem = apiList.find(
                              (item) => item.id === group.sourceId,
                            );
                            const fullGroup = sourceItem?.groups.find(
                              (item) => item.id === group.id,
                            );
                            if (sourceItem && fullGroup) {
                              openGroupScheduleEdit(sourceItem, fullGroup);
                            }
                          }}
                          className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100"
                        >
                          스케줄
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {groupedApiGroups.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                표시할 API 그룹이 없습니다.
              </div>
            ) : null}
              </div>
            </div>
            </>
          ) : activeTab === "apiSettings" && activeSettingsTab === "엑셀 설정" ? (
            <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center">
              <h4 className="text-base font-semibold text-slate-900">엑셀 설정</h4>
              <p className="mt-2 text-sm text-slate-600">
                엑셀 수집 연결원 등록 및 설정 화면은 다음 단계에서 추가됩니다.
              </p>
            </div>
          ) : activeTab === "apiSettings" && activeSettingsTab === "PDF 설정" ? (
            <PdfItemTradePanel dbSettingId={selectedDbSettingId} />
          ) : activeTab === "apiSettings" ? (
            <PdfTableIngestPanel dbSettingId={selectedDbSettingId} />
          ) : null}
          <div className={activeTab === "mappingSettings" ? "" : "hidden"}>
            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div>
                  <h4 className="text-base font-semibold leading-6 text-slate-900">데이터 매핑관리</h4>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMappingBulkGenerateRequestKey((prev) => prev + 1)}
                    className="inline-flex h-8 items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
                  >
                    전체 데이터 반영
                  </button>
                  <button
                    type="button"
                    onClick={() => setMappingCreateRequestKey((prev) => prev + 1)}
                    className="inline-flex h-8 items-center rounded-full bg-slate-900 px-3 text-xs font-semibold text-white transition hover:bg-slate-800"
                  >
                    신규 매핑 등록
                  </button>
                </div>
              </div>
              <DataMappingManagerModal
                open
                inline
                createRequestKey={mappingCreateRequestKey}
                bulkGenerateRequestKey={mappingBulkGenerateRequestKey}
                dbSettingId={selectedDbSettingId}
              />
            </div>
          </div>
        </div>
      )}

      {dataMapScopeTarget ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 p-4 sm:items-center sm:p-6">
          <div className="flex w-full max-w-4xl flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:max-h-[90vh]">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">데이터 매핑</h3>
                <p className="mt-1 text-xs text-slate-500">
                  {dataMapScopeTarget.apiName} · 원천 테이블{" "}
                  <span className="font-mono">{dataMapScopeTarget.sourceTable}</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScopedMapBulkKey((prev) => prev + 1)}
                  className="inline-flex h-8 items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
                >
                  전체 데이터 반영
                </button>
                <button
                  type="button"
                  onClick={() => setScopedMapCreateKey((prev) => prev + 1)}
                  className="inline-flex h-8 items-center rounded-full bg-slate-900 px-3 text-xs font-semibold text-white transition hover:bg-slate-800"
                >
                  신규 매핑 등록
                </button>
                <button
                  type="button"
                  onClick={() => setDataMapScopeTarget(null)}
                  className="inline-flex h-8 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  닫기
                </button>
              </div>
            </div>
            <div className="mt-3 overflow-auto">
              <DataMappingManagerModal
                open
                inline
                dbSettingId={selectedDbSettingId}
                scopeSourceTable={dataMapScopeTarget.sourceTable}
                scopeSourceOrg={dataMapScopeTarget.sourceOrg}
                scopeApiName={dataMapScopeTarget.apiName}
                createRequestKey={scopedMapCreateKey}
                bulkGenerateRequestKey={scopedMapBulkKey}
              />
            </div>
          </div>
        </div>
      ) : null}

      {showApiModal ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 p-4 sm:items-center sm:p-6">
          <div className="flex w-full max-w-3xl flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:max-h-[90vh]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  기관 관리
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  기관별 API 생성에 사용할 기본 URL과 API Key를 미리 설정하고 관리합니다.
                </p>
        </div>
              <button
                onClick={() => {
                  resetApiForm();
                  setShowApiModal(false);
                }}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={fetchApiList}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                새로고침
              </button>
            </div>
            <div className="mt-4 max-h-[70vh] overflow-y-auto pr-2">
            {apiView === "list" ? (
              <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
                {apiListStatus.type === "loading" ? (
                  <p className="text-xs text-slate-500">불러오는 중...</p>
                ) : apiListStatus.type === "error" ? (
                  <p className="text-xs text-rose-500">{apiListStatus.message}</p>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid min-w-0 grid-cols-[40px_1.1fr_0.9fr_2.2fr_2fr_72px] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                    <label className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={
                          apiList.length > 0 &&
                          selectedSourceIds.length === apiList.length
                        }
                        onChange={(event) =>
                          handleToggleAllSources(event.target.checked)
                        }
                      />
                    </label>
                    <span>기관이름</span>
                    <span>기관식별자</span>
                    <span>BASE URL</span>
                    <span>API KEY</span>
                    <span className="text-center">수정</span>
                  </div>
                  <div className="divide-y divide-slate-200">
                    {apiList.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-slate-500">
                        등록된 기관이 없습니다.
                      </div>
                    ) : null}
                    {apiList.map((sourceItem) => (
                      editingSourceId === sourceItem.id ? (
                        <div
                          key={sourceItem.id}
                          className="grid min-w-0 grid-cols-[40px_1.1fr_0.9fr_2.2fr_2fr_72px] gap-2 px-3 py-2 text-[11px] text-slate-700"
                        >
                          <label className="flex items-center justify-center">
                            <input
                              type="checkbox"
                              checked={selectedSourceIds.includes(sourceItem.id)}
                              onChange={(event) =>
                                handleToggleSourceSelect(
                                  sourceItem.id,
                                  event.target.checked,
                                )
                              }
                            />
                          </label>
                          <input
                            value={editSource.name}
                            onChange={(event) =>
                              setEditSource((prev) => ({
                                ...prev,
                                name: event.target.value,
                              }))
                            }
                            className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          />
                          <input
                            value={editSource.provider}
                            onChange={(event) =>
                              setEditSource((prev) => ({
                                ...prev,
                                provider: event.target.value,
                              }))
                            }
                            className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          />
                          <input
                            value={editSource.baseUrl}
                            onChange={(event) =>
                              setEditSource((prev) => ({
                                ...prev,
                                baseUrl: event.target.value,
                              }))
                            }
                            className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          />
                          <input
                            value={editSource.apiKey}
                            onChange={(event) =>
                              setEditSource((prev) => ({
                                ...prev,
                                apiKey: event.target.value,
                              }))
                            }
                            className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          />
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={handleSaveEditSource}
                              className="whitespace-nowrap rounded-full bg-slate-900 px-2 py-1 text-[10px] font-semibold text-white hover:bg-slate-800"
                            >
                              저장
                            </button>
                            <button
                              onClick={handleCancelEditSource}
                              className="whitespace-nowrap rounded-full border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      ) : (
                      <div
                        key={sourceItem.id}
                        className="grid min-w-0 grid-cols-[40px_1.1fr_0.9fr_2.2fr_2fr_72px] items-center gap-2 px-3 py-2 text-[11px] text-slate-700"
                      >
                        <label className="flex items-center justify-center">
                          <input
                            type="checkbox"
                            checked={selectedSourceIds.includes(sourceItem.id)}
                            onChange={(event) =>
                              handleToggleSourceSelect(
                                sourceItem.id,
                                event.target.checked,
                              )
                            }
                          />
                        </label>
                        <span className="min-w-0 font-semibold text-slate-800">
                          {sourceItem.name}
                        </span>
                        <span className="min-w-0">{sourceItem.provider}</span>
                        <span className="min-w-0 break-all text-slate-500">
                          {sourceItem.base_url}
                        </span>
                        <span className="min-w-0 break-all text-slate-500">
                          {sourceItem.api_key ?? ""}
                        </span>
                        <div className="flex items-center justify-center">
                          <button
                            onClick={() => handleStartEditSource(sourceItem)}
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            수정
                          </button>
                        </div>
                      </div>
                      )
                    ))}
                    {showSourceCreate ? (
                      <div className="grid min-w-0 grid-cols-[40px_1.1fr_0.9fr_2.2fr_2fr_72px] gap-2 px-3 py-2 text-[11px] text-slate-700">
                        <span />
                        <input
                          value={sourceCreate.name}
                          onChange={(event) =>
                            setSourceCreate((prev) => ({
                              ...prev,
                              name: event.target.value,
                            }))
                          }
                          className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          placeholder="기관이름"
                        />
                        <input
                          value={sourceCreate.provider}
                          onChange={(event) =>
                            setSourceCreate((prev) => ({
                              ...prev,
                              provider: event.target.value,
                            }))
                          }
                          className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          placeholder="기관식별자"
                        />
                        <input
                          value={sourceCreate.baseUrl}
                          onChange={(event) =>
                            setSourceCreate((prev) => ({
                              ...prev,
                              baseUrl: event.target.value,
                            }))
                          }
                          className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          placeholder="BASE URL"
                        />
                        <input
                          value={sourceCreate.apiKey}
                          onChange={(event) =>
                            setSourceCreate((prev) => ({
                              ...prev,
                              apiKey: event.target.value,
                            }))
                          }
                          className="h-7 w-full min-w-0 rounded-lg border border-slate-200 px-2 text-[10px] leading-none"
                          placeholder="API KEY"
                        />
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={handleCreateSource}
                            className="whitespace-nowrap rounded-full bg-slate-900 px-2 py-1 text-[10px] font-semibold text-white hover:bg-slate-800"
                          >
                            저장
                          </button>
                          <button
                            onClick={() => {
                              setShowSourceCreate(false);
                              setSourceCreate({
                                name: "",
                                provider: "",
                                baseUrl: "",
                                apiKey: "",
                              });
                            }}
                            className="whitespace-nowrap rounded-full border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            취소
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  </div>
                )}
                <div className="flex justify-end">
                  <button
                  onClick={() => setShowSourceCreate(true)}
                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    추가
                  </button>
                <button
                  onClick={handleDeleteSelectedSources}
                  className="ml-2 rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-100"
                >
                  삭제
                </button>
                </div>
              </div>
            ) : (
                <div className="grid gap-4">
                  <div className="space-y-3 w-full max-w-none">
                    <p className="text-xs font-semibold text-slate-500">API 소스</p>
                    <div className="grid gap-2 w-full">
                    <label className="space-y-1 text-xs text-slate-600 w-full">
                      기관 선택
                      <select
                        value={selectedSourceId}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          setSelectedSourceId(nextId);
                          if (nextId === "custom") {
                            setPeriodInputMode("range");
                            setSource((prev) => ({
                              ...prev,
                              provider: "custom",
                              name: "",
                              baseUrl: "",
                              apiKey: "",
                              apiKeyParamKey: "",
                              apiKeyLocation: "query",
                              apiKeyOrder: 0,
                              apiKeyEncodeMode: "encode",
                            }));
                            setParams([
                              {
                                key: "",
                                value: "",
                                location: "query",
                                order: 1,
                                encodeMode: "encode",
                              },
                            ]);
                            return;
                          }
                          const selected = selectableSources.find(
                            (item) => String(item.id) === nextId,
                          );
                          if (!selected) return;
                          const normalizedSelectedProvider = normalizeProvider(selected.provider);
                          setPeriodInputMode("range");
                          setSource((prev) => ({
                            ...prev,
                            provider: normalizedSelectedProvider,
                            name: selected.name,
                            baseUrl: selected.base_url,
                            apiKey: selected.api_key ?? "",
                            apiKeyParamKey: selected.api_key_param_key ?? "",
                            apiKeyLocation: selected.api_key_location ?? "query",
                            apiKeyOrder: selected.api_key_order ?? 0,
                            apiKeyEncodeMode: selected.api_key_encode_mode ?? "encode",
                          }));
                          const templateGroup = selected.groups[0];
                          setGroupName("");
                          setParams(
                            (templateGroup?.params ?? []).map((param) => {
                              const key = param.param_key;
                              const shouldClear =
                                (normalizedSelectedProvider === "bok" &&
                                  (key === "statCode" ||
                                    key === "apiStart" ||
                                    key === "apiEnd")) ||
                                (normalizedSelectedProvider === "kosis" &&
                                  (key === "userStatsId" ||
                                    key === "startPrdDe" ||
                                    key === "endPrdDe")) ||
                                (normalizedSelectedProvider === "datagokr" &&
                                  (key === "orgCode" ||
                                    key === "apiName" ||
                                    key === "functionName" ||
                                    key === "strtYymm" ||
                                    key === "endYymm"));
                              return {
                                key,
                                value: shouldClear ? "" : param.param_value,
                                location: param.param_location as "path" | "query",
                                order: param.param_order,
                                encodeMode: param.encode_mode ?? "encode",
                                role: param.param_role ?? null,
                              };
                            }),
                          );
                        }}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      >
                        <option value="custom">직접 입력</option>
                        {apiList.map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <input
                      value={source.name}
                      onChange={(event) =>
                        setSource((prev) => ({ ...prev, name: event.target.value }))
                      }
                      placeholder="소스 이름 (예: 공공데이터포탈)"
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      disabled={source.provider !== "custom"}
                    />
                    <div className="grid gap-2 w-full">
                      <input
                        value={source.baseUrl}
                        onChange={(event) =>
                          setSource((prev) => ({
                            ...prev,
                            baseUrl: event.target.value,
                          }))
                        }
                        placeholder="Base URL (예: https://apis.data.go.kr)"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                        disabled={source.provider !== "custom"}
                      />
                      <input
                        value={source.apiKey}
                        onChange={(event) =>
                          setSource((prev) => ({ ...prev, apiKey: event.target.value }))
                        }
                        placeholder="발급받은 키 입력"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                        disabled={source.provider !== "custom"}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        onChange={(event) =>
                          setSource((prev) => ({
                            ...prev,
                            enabled: event.target.checked,
                          }))
                        }
                      />
                      활성화
                    </label>
                  </div>
                  </div>
                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-slate-500">파라미터</p>
                    <label className="space-y-1 text-xs text-slate-600">
                      API 명
                      <input
                        value={groupName}
                        onChange={(event) => setGroupName(event.target.value)}
                        placeholder={
                          normalizedProvider === "bok"
                            ? "예: 경제심리지수"
                            : normalizedProvider === "kosis"
                              ? "예: 근원물가(2020＝100)"
                              : "예: API 명"
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                    </label>
                    <div>
            {normalizedProvider === "bok" ? (
              <div className="grid gap-2">
                <label className="space-y-1 text-xs text-slate-600">
                  Format
                  <select
                    value={getParamValue("format", "json")}
                    onChange={(event) =>
                      setParamValue("format", event.target.value, "path", 1)
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  >
                    <option value="json">json</option>
                    <option value="xml">xml</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  STAT_CODE
                  <input
                    value={getParamValue("statCode")}
                    onChange={(event) =>
                      setParamValue("statCode", event.target.value, "path", 5)
                    }
                    placeholder="예: 513Y001"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
                <div className="space-y-1 text-xs text-slate-600">
                  입력 방식
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1">
                    <button
                      type="button"
                      onClick={() => setPeriodInputMode("range")}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold ${
                        periodInputMode === "range"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      기간
                    </button>
                    <button
                      type="button"
                      onClick={() => setPeriodInputMode("manual")}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold ${
                        periodInputMode === "manual"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      직접입력
                    </button>
                  </div>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={isEndLatest("apiEnd")}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setParamValue("apiEnd", END_LATEST_TOKEN, "path", 8);
                        return;
                      }
                      if (periodInputMode === "range" && periodOffset) {
                        applyPeriodRange(
                          getParamValue("period", "M"),
                          periodOffset,
                          "apiStart",
                          "apiEnd",
                          "path",
                          7,
                          8,
                        );
                      } else {
                        setParamValue("apiEnd", "", "path", 8);
                      }
                    }}
                  />
                  종료날짜를 항상 최신날짜로 설정
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  기간 구분
                  <select
                    value={getParamValue("period", "M")}
                    onChange={(event) => {
                      const keepLatest = isEndLatest("apiEnd");
                      const nextPeriod = event.target.value;
                      setParamValue("period", nextPeriod, "path", 6);
                      if (periodInputMode === "range" && periodOffset) {
                        applyPeriodRange(
                          nextPeriod,
                          periodOffset,
                          "apiStart",
                          "apiEnd",
                          "path",
                          7,
                          8,
                        );
                        if (keepLatest) {
                          setParamValue("apiEnd", END_LATEST_TOKEN, "path", 8);
                        }
                      }
                    }}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  >
                    <option value="D">일</option>
                    <option value="M">월</option>
                    <option value="Q">분기</option>
                    <option value="A">연</option>
                  </select>
                </label>
                {periodInputMode === "range" ? (
                  <label className="space-y-1 text-xs text-slate-600">
                    기간
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={periodOffset}
                        onChange={(event) => {
                          const raw = event.target.value;
                          const keepLatest = isEndLatest("apiEnd");
                          const next =
                            raw === ""
                              ? ""
                              : String(Math.max(0, Number(raw) || 0));
                          setPeriodOffset(next);
                          if (next) {
                            applyPeriodRange(
                              getParamValue("period", "M"),
                              next,
                              "apiStart",
                              "apiEnd",
                              "path",
                              7,
                              8,
                            );
                            if (keepLatest) {
                              setParamValue("apiEnd", END_LATEST_TOKEN, "path", 8);
                            }
                          }
                        }}
                        placeholder="예: 3"
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                      <span className="whitespace-nowrap text-xs text-slate-500">
                        {getPeriodOffsetLabel(getParamValue("period", "M"))}
                      </span>
                    </div>
                  </label>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-slate-600">
                      시작
                      <input
                        value={getParamValue("apiStart")}
                        onChange={(event) =>
                          setParamValue("apiStart", event.target.value, "path", 7)
                        }
                        placeholder={
                          getParamValue("period", "M") === "D"
                            ? "YYYYMMDD (예: 20250101)"
                            : getParamValue("period", "M") === "Q"
                              ? "YYYYQn (예: 2025Q1)"
                              : getParamValue("period", "M") === "A"
                                ? "YYYY (예: 2025)"
                                : "YYYYMM (예: 202501)"
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-slate-600">
                      종료
                      <input
                        value={getParamValue("apiEnd")}
                        disabled={isEndLatest("apiEnd")}
                        onChange={(event) =>
                          setParamValue("apiEnd", event.target.value, "path", 8)
                        }
                        placeholder={
                          getParamValue("period", "M") === "D"
                            ? "YYYYMMDD (예: 20251231)"
                            : getParamValue("period", "M") === "Q"
                              ? "YYYYQn (예: 2025Q4)"
                              : getParamValue("period", "M") === "A"
                                ? "YYYY (예: 2026)"
                                : "YYYYMM (예: 202512)"
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                    </label>
                  </div>
                )}
              </div>
            ) : normalizedProvider === "kosis" ? (
              <div className="grid gap-2">
                <label className="space-y-1 text-xs text-slate-600">
                  format
                  <select
                    value={getParamValue("format", "json")}
                    onChange={(event) =>
                      setParamValue("format", event.target.value, "query", 2)
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  >
                    <option value="json">json</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  userStatsId(사용자 등록 통계표)
                  <input
                    value={getParamValue("userStatsId")}
                    onChange={(event) =>
                      setParamValue("userStatsId", event.target.value, "query", 4)
                    }
                    placeholder="예: openapisample/101/DT_1J22007/2/1/20231220095249"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
                <div className="space-y-1 text-xs text-slate-600">
                  입력 방식
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1">
                    <button
                      type="button"
                      onClick={() => setPeriodInputMode("range")}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold ${
                        periodInputMode === "range"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      기간
                    </button>
                    <button
                      type="button"
                      onClick={() => setPeriodInputMode("manual")}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold ${
                        periodInputMode === "manual"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      직접입력
                    </button>
                  </div>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={isEndLatest("endPrdDe")}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setParamValue("endPrdDe", END_LATEST_TOKEN, "query", 7);
                        return;
                      }
                      if (periodInputMode === "range" && periodOffset) {
                        applyPeriodRange(
                          getParamValue("prdSe", "M"),
                          periodOffset,
                          "startPrdDe",
                          "endPrdDe",
                          "query",
                          6,
                          7,
                        );
                      } else {
                        setParamValue("endPrdDe", "", "query", 7);
                      }
                    }}
                  />
                  종료날짜를 항상 최신날짜로 설정
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  prdSe(기간 구분)
                  <select
                    value={getParamValue("prdSe", "M")}
                    onChange={(event) => {
                      const keepLatest = isEndLatest("endPrdDe");
                      const nextPeriod = event.target.value;
                      setParamValue("prdSe", nextPeriod, "query", 5);
                      if (periodInputMode === "range" && periodOffset) {
                        applyPeriodRange(
                          nextPeriod,
                          periodOffset,
                          "startPrdDe",
                          "endPrdDe",
                          "query",
                          6,
                          7,
                        );
                        if (keepLatest) {
                          setParamValue("endPrdDe", END_LATEST_TOKEN, "query", 7);
                        }
                      }
                    }}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  >
                    <option value="D">일</option>
                    <option value="M">월</option>
                    <option value="Q">분기</option>
                    <option value="Y">연</option>
                  </select>
                </label>
                {periodInputMode === "range" ? (
                  <label className="space-y-1 text-xs text-slate-600">
                    기간
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={periodOffset}
                        onChange={(event) => {
                          const raw = event.target.value;
                          const keepLatest = isEndLatest("endPrdDe");
                          const next =
                            raw === ""
                              ? ""
                              : String(Math.max(0, Number(raw) || 0));
                          setPeriodOffset(next);
                          if (next) {
                            applyPeriodRange(
                              getParamValue("prdSe", "M"),
                              next,
                              "startPrdDe",
                              "endPrdDe",
                              "query",
                              6,
                              7,
                            );
                            if (keepLatest) {
                              setParamValue("endPrdDe", END_LATEST_TOKEN, "query", 7);
                            }
                          }
                        }}
                        placeholder="예: 3"
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                      <span className="whitespace-nowrap text-xs text-slate-500">
                        {getPeriodOffsetLabel(getParamValue("prdSe", "M"))}
                      </span>
                    </div>
                  </label>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-slate-600">
                      startPrdDe(시작)
                      <input
                        value={getParamValue("startPrdDe")}
                        onChange={(event) =>
                          setParamValue("startPrdDe", event.target.value, "query", 6)
                        }
                        placeholder={
                          getParamValue("prdSe", "M") === "D"
                            ? "YYYYMMDD (예: 20250101)"
                            : getParamValue("prdSe", "M") === "Q"
                              ? "YYYYQn (예: 2025Q1)"
                              : getParamValue("prdSe", "M") === "Y"
                                ? "YYYY (예: 1985)"
                                : "YYYYMM (예: 202501)"
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] text-slate-500">
                          예: <code>3개월 전</code> 또는 <code>__TODAY_MINUS_3M__</code>
                        </p>
                        <button
                          type="button"
                          onClick={() => setParamValue("startPrdDe", "3개월 전", "query", 6)}
                          className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          3개월 전
                        </button>
                      </div>
                    </label>
                    <label className="space-y-1 text-xs text-slate-600">
                      endPrdDe(종료)
                      <input
                        value={getParamValue("endPrdDe")}
                        disabled={isEndLatest("endPrdDe")}
                        onChange={(event) =>
                          setParamValue("endPrdDe", event.target.value, "query", 7)
                        }
                        placeholder={
                          getParamValue("prdSe", "M") === "D"
                            ? "YYYYMMDD (예: 20251231)"
                            : getParamValue("prdSe", "M") === "Q"
                              ? "YYYYQn (예: 2025Q4)"
                              : getParamValue("prdSe", "M") === "Y"
                                ? "YYYY (예: 2030)"
                                : "YYYYMM (예: 202512)"
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                    </label>
                  </div>
                )}
              </div>
            ) : normalizedProvider === "datagokr" ? (
              <div className="grid gap-2">
                <label className="space-y-1 text-xs text-slate-600">
                  기관코드
                  <input
                    value={getParamValue("orgCode")}
                    onChange={(event) =>
                      setParamValue("orgCode", event.target.value, "path", 1)
                    }
                    placeholder="예: 1220000"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  API 서비스명
                  <input
                    value={getParamValue("apiName")}
                    onChange={(event) =>
                      setParamValue("apiName", event.target.value, "path", 2)
                    }
                    placeholder="예: Newtrade"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  상세 기능명
                  <input
                    value={getParamValue("functionName")}
                    onChange={(event) =>
                      setParamValue("functionName", event.target.value, "path", 3)
                    }
                    placeholder="예: getNewtradeList"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
                <div className="space-y-1 text-xs text-slate-600">
                  입력 방식
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1">
                    <button
                      type="button"
                      onClick={() => setPeriodInputMode("range")}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold ${
                        periodInputMode === "range"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      기간
                    </button>
                    <button
                      type="button"
                      onClick={() => setPeriodInputMode("manual")}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold ${
                        periodInputMode === "manual"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      직접입력
                    </button>
                  </div>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={isEndLatest("endYymm")}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setParamValue("endYymm", END_LATEST_TOKEN, "query", 2);
                        return;
                      }
                      if (periodInputMode === "range" && periodOffset) {
                        applyPeriodRange(
                          getParamValue("periodType", "M"),
                          periodOffset,
                          "strtYymm",
                          "endYymm",
                          "query",
                          1,
                          2,
                        );
                      } else {
                        setParamValue("endYymm", "", "query", 2);
                      }
                    }}
                  />
                  종료날짜를 항상 최신날짜로 설정
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  기간 구분
                  <select
                    value={getParamValue("periodType", "M")}
                    onChange={(event) => {
                      const keepLatest = isEndLatest("endYymm");
                      const nextPeriod = event.target.value;
                      setParamValue("periodType", nextPeriod, "query", 0);
                      if (periodInputMode === "range" && periodOffset) {
                        applyPeriodRange(
                          nextPeriod,
                          periodOffset,
                          "strtYymm",
                          "endYymm",
                          "query",
                          1,
                          2,
                        );
                        if (keepLatest) {
                          setParamValue("endYymm", END_LATEST_TOKEN, "query", 2);
                        }
                      }
                    }}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  >
                    <option value="D">일</option>
                    <option value="M">월</option>
                    <option value="Q">분기</option>
                    <option value="A">연</option>
                  </select>
                </label>
                {periodInputMode === "range" ? (
                  <label className="space-y-1 text-xs text-slate-600">
                    기간
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={periodOffset}
                        onChange={(event) => {
                          const raw = event.target.value;
                          const keepLatest = isEndLatest("endYymm");
                          const next =
                            raw === ""
                              ? ""
                              : String(Math.max(0, Number(raw) || 0));
                          setPeriodOffset(next);
                          if (next) {
                            applyPeriodRange(
                              getParamValue("periodType", "M"),
                              next,
                              "strtYymm",
                              "endYymm",
                              "query",
                              1,
                              2,
                            );
                            if (keepLatest) {
                              setParamValue("endYymm", END_LATEST_TOKEN, "query", 2);
                            }
                          }
                        }}
                        placeholder="예: 3"
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                      <span className="whitespace-nowrap text-xs text-slate-500">
                        {getPeriodOffsetLabel(getParamValue("periodType", "M"))}
                      </span>
                    </div>
                  </label>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-slate-600">
                      시작
                      <input
                        value={getParamValue("strtYymm")}
                        onChange={(event) =>
                          setParamValue("strtYymm", event.target.value, "query", 1)
                        }
                        placeholder={
                          getParamValue("periodType", "M") === "D"
                            ? "YYYYMMDD (예: 20250101)"
                            : getParamValue("periodType", "M") === "Q"
                              ? "YYYYQn (예: 2025Q1)"
                              : getParamValue("periodType", "M") === "A"
                                ? "YYYY (예: 2025)"
                                : "YYYYMM (예: 202501)"
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] text-slate-500">
                          예: <code>3개월 전</code> 또는 <code>__TODAY_MINUS_3M__</code>
                        </p>
                        <button
                          type="button"
                          onClick={() => setParamValue("strtYymm", "3개월 전", "query", 1)}
                          className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          3개월 전
                        </button>
                      </div>
                    </label>
                    <label className="space-y-1 text-xs text-slate-600">
                      종료
                      <input
                        value={getParamValue("endYymm")}
                        disabled={isEndLatest("endYymm")}
                        onChange={(event) =>
                          setParamValue("endYymm", event.target.value, "query", 2)
                        }
                        placeholder={
                          getParamValue("periodType", "M") === "D"
                            ? "YYYYMMDD (예: 20251231)"
                            : getParamValue("periodType", "M") === "Q"
                              ? "YYYYQn (예: 2025Q4)"
                              : getParamValue("periodType", "M") === "A"
                                ? "YYYY (예: 2026)"
                                : "YYYYMM (예: 202512)"
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                      />
                    </label>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {params.map((item, index) => (
                  <div
                    key={`${item.key}-${index}`}
                    className="grid grid-cols-1 items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px_90px_40px]"
                  >
                    <input
                      value={item.key}
                      onChange={(event) => {
                        const value = event.target.value;
                        setParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, key: value } : row,
                          ),
                        );
                      }}
                      placeholder="param_key"
                      className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
                    />
                    <input
                      value={item.value}
                      onChange={(event) => {
                        const value = event.target.value;
                        setParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, value } : row,
                          ),
                        );
                      }}
                      placeholder="param_value"
                      className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
                    />
                    <select
                      value={item.location}
                      onChange={(event) => {
                        const value = event.target.value as "path" | "query";
                        setParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, location: value } : row,
                          ),
                        );
                      }}
                      className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
                    >
                      <option value="path">path</option>
                      <option value="query">query</option>
                    </select>
                    <input
                      type="number"
                      value={item.order}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, order: value } : row,
                          ),
                        );
                      }}
                      className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
                    />
                    <button
                      onClick={() => handleRemoveParam(index)}
                      className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={handleAddParam}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  + 파라미터 추가
                </button>
              </div>
            )}
            <div className="mt-3 space-y-1 text-xs text-slate-600">
              <p className="font-semibold text-slate-500">최종 URL (미리보기)</p>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 break-all">
                {requestPreviewUrl || "API 기본 URL과 파라미터를 입력하면 미리보기가 표시됩니다."}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
            {apiView === "register" ? (
              <div className="mt-4 min-h-[48px]">
                {submitStatus.type !== "idle" ? (
                  <div
                    className={`rounded-2xl border px-4 py-3 text-xs ${
                      submitStatus.type === "success"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-rose-200 bg-rose-50 text-rose-600"
                    }`}
                  >
                    {submitStatus.message}
                  </div>
                ) : testStatus.type !== "idle" ? (
                  <div
                    className={`rounded-2xl border px-4 py-3 text-xs ${
                      testStatus.type === "success"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-rose-200 bg-rose-50 text-rose-600"
                    }`}
                  >
                    {testStatus.message}
                  </div>
                ) : null}
              </div>
            ) : null}
            {apiView === "register" ? (
              <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  resetApiForm();
                  setShowApiModal(false);
                }}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                닫기
              </button>
              <button
                onClick={handleTest}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                테스트
              </button>
              <button
                onClick={handleSubmit}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
              >
                저장
              </button>
            </div>
            ) : null}
            {apiView === "list" ? (
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => {
                    resetApiForm();
                    setShowApiModal(false);
                  }}
                  className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                >
                  확인
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {showSuccessModal ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">저장 완료</p>
                <p className="mt-1 text-xs text-slate-500">저장되었습니다.</p>
              </div>
              <button
                onClick={() => {
                  setShowSuccessModal(false);
                  resetApiForm();
                }}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowSuccessModal(false);
                  resetApiForm();
                }}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {apiLoadStatus.type !== "idle" ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-6 backdrop-blur-[1px]">
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            {apiLoadStatus.type === "loading" ? (
              <div className="flex flex-col items-center text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
                  <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
                </div>
                <p className="mt-4 text-base font-semibold text-slate-900">적재 실행 중</p>
                <p className="mt-1 text-xs text-slate-500">{apiLoadStatus.message}</p>
                <div className="mt-5">
                  <button
                    onClick={handleCancelApiLoad}
                    disabled={!runningLoadTaskId || apiLoadCancelBusy}
                    className="rounded-full border border-rose-200 bg-rose-50 px-5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    {apiLoadCancelBusy ? "중단 요청 중..." : "닫기(중단)"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-col items-center text-center">
                  <div
                    className={`flex h-14 w-14 items-center justify-center rounded-full ${
                      apiLoadStatus.type === "success"
                        ? "bg-emerald-100 text-emerald-700"
                        : apiLoadStatus.type === "cancelled"
                          ? "bg-amber-100 text-amber-700"
                        : "bg-rose-100 text-rose-700"
                    }`}
                  >
                    <span className="text-2xl leading-none">
                      {apiLoadStatus.type === "success" ? "✓" : apiLoadStatus.type === "cancelled" ? "■" : "!"}
                    </span>
                  </div>
                  <p
                    className={`mt-4 text-base font-semibold ${
                      apiLoadStatus.type === "success"
                        ? "text-emerald-700"
                        : apiLoadStatus.type === "cancelled"
                          ? "text-amber-700"
                          : "text-rose-700"
                    }`}
                  >
                    {apiLoadStatus.type === "success"
                      ? "적재 성공"
                      : apiLoadStatus.type === "cancelled"
                        ? "적재 중단"
                        : "적재 실패"}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">{apiLoadStatus.message}</p>
                </div>
                <div className="mt-5 flex justify-center">
                  <button
                    onClick={() => setApiLoadStatus({ type: "idle", message: "" })}
                    className="rounded-full bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    확인
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      {showDeleteSelectAlert ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <p className="text-sm font-semibold text-slate-900">삭제할 항목을 선택하세요.</p>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowDeleteSelectAlert(false)}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {deleteTarget ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">삭제 확인</p>
          <p className="mt-1 text-xs text-slate-500">
                  {deleteTarget.name} 설정을 삭제할까요?
          </p>
        </div>
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={confirmDeleteSource}
                className="rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {groupDeleteTarget ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">삭제 확인</p>
          <p className="mt-1 text-xs text-slate-500">
                  {groupDeleteTarget.name} 파라미터를 삭제할까요?
          </p>
        </div>
              <button
                onClick={() => setGroupDeleteTarget(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
      </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setGroupDeleteTarget(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={confirmDeleteGroup}
                className="rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
              >
                삭제
          </button>
        </div>
          </div>
        </div>
      ) : null}
      {sourceEditTarget ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">API 소스 수정</p>
                <p className="mt-1 text-xs text-slate-500">
                  URL과 키 정보를 수정합니다.
                </p>
              </div>
              <button
                onClick={() => setSourceEditTarget(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 grid gap-3">
              <label className="space-y-1 text-xs text-slate-600">
                소스 이름
                <input
                  value={sourceEdit.name}
                  onChange={(event) =>
                    setSourceEdit((prev) => ({ ...prev, name: event.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm text-slate-500"
                  disabled
                />
              </label>
              <label className="space-y-1 text-xs text-slate-600">
                제공 기관
                <input
                  value={sourceEdit.provider}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm text-slate-500"
                  disabled
                />
              </label>
              <label className="space-y-1 text-xs text-slate-600">
                Base URL
                <input
                  value={sourceEdit.baseUrl}
                  onChange={(event) =>
                    setSourceEdit((prev) => ({
                      ...prev,
                      baseUrl: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                />
              </label>
              <label className="space-y-1 text-xs text-slate-600">
                API Key
                <input
                  value={sourceEdit.apiKey}
                  onChange={(event) =>
                    setSourceEdit((prev) => ({
                      ...prev,
                      apiKey: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={sourceEdit.enabled}
                  onChange={(event) =>
                    setSourceEdit((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                />
                활성화
              </label>
              {sourceEditStatus.type !== "idle" ? (
                <div
                  className={`rounded-2xl border px-3 py-2 text-xs ${
                    sourceEditStatus.type === "success"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-rose-200 bg-rose-50 text-rose-600"
                  }`}
                >
                  {sourceEditStatus.message}
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setSourceEditTarget(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={handleSourceEditSave}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {groupEditTarget ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  API 파라미터 수정
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  그룹 및 파라미터 값을 수정합니다.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowGroupParamGuide(true)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                >
                  파라미터 설명 보기
                </button>
                <button
                  onClick={() => {
                    setShowGroupParamGuide(false);
                    setGroupEditTarget(null);
                  }}
                  className="text-sm font-semibold text-slate-400 hover:text-slate-600"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto pr-2">
              <label className="space-y-1 text-xs text-slate-600">
                API 명
                <input
                  value={groupEditName}
                  onChange={(event) => setGroupEditName(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                />
              </label>
              <div className="space-y-2">
                {(() => {
                  const orderedParams = groupEditParams
                    .map((item, index) => ({ item, index }))
                    .sort((a, b) => {
                      if (a.item.location === b.item.location) {
                        const orderDiff = a.item.order - b.item.order;
                        return orderDiff !== 0 ? orderDiff : a.index - b.index;
                      }
                      return a.item.location === "path" ? -1 : 1;
                    });
                  return orderedParams.map(({ item, index }) => (
                    <div
                      key={`${item.key}-${index}`}
                      className="grid grid-cols-1 items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px_90px_40px]"
                    >
                      <input
                        value={item.key}
                        onChange={(event) => {
                          const value = event.target.value;
                          setGroupEditParams((prev) =>
                            prev.map((row, idx) =>
                              idx === index ? { ...row, key: value } : row,
                            ),
                          );
                        }}
                        placeholder="param_key"
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                      />
                      <input
                        value={item.value}
                        onChange={(event) => {
                          const value = event.target.value;
                          setGroupEditParams((prev) =>
                            prev.map((row, idx) =>
                              idx === index ? { ...row, value } : row,
                            ),
                          );
                        }}
                        placeholder="param_value"
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                      />
                      <select
                        value={item.location}
                        onChange={(event) => {
                          const value = event.target.value as "path" | "query";
                          setGroupEditParams((prev) =>
                            prev.map((row, idx) =>
                              idx === index ? { ...row, location: value } : row,
                            ),
                          );
                        }}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                      >
                        <option value="path">path</option>
                        <option value="query">query</option>
                      </select>
                      <input
                        type="number"
                        value={item.order}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setGroupEditParams((prev) =>
                            prev.map((row, idx) =>
                              idx === index ? { ...row, order: value } : row,
                            ),
                          );
                        }}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                      />
                      <button
                        onClick={() => handleRemoveGroupEditParam(index)}
                        className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600"
                      >
                        ×
                      </button>
                    </div>
                  ));
                })()}
                <button
                  onClick={handleAddGroupEditParam}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  + 파라미터 추가
                </button>
              </div>
              {groupEditStatus.type !== "idle" ? (
                <div
                  className={`rounded-2xl border px-3 py-2 text-xs ${
                    groupEditStatus.type === "success"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-rose-200 bg-rose-50 text-rose-600"
                  }`}
                >
                  {groupEditStatus.message}
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowGroupParamGuide(false);
                  setGroupEditTarget(null);
                }}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={handleGroupEditSave}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {groupEditTarget && showGroupParamGuide ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">파라미터 설명</p>
                <p className="mt-1 text-xs text-slate-500">
                  날짜 파라미터 사용값과 현재 파라미터 의미를 확인합니다.
                </p>
              </div>
              <button
                onClick={() => setShowGroupParamGuide(false)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <p className="font-semibold text-slate-900">현재 파라미터 설명</p>
                <div className="mt-2 space-y-1.5">
                  {groupEditParams.map((item, index) => {
                    const help = getParamDescription(item.key, item.role);
                    return (
                      <div key={`help-modal-${item.key}-${index}`} className="rounded-lg bg-white px-2 py-1.5">
                        <p className="font-semibold text-slate-800">
                          {item.key?.trim() || `(파라미터 ${index + 1})`}
                          {help ? ` - ${help.label}` : ""}
                        </p>
                        <p className="mt-0.5 text-slate-600">
                          {help
                            ? help.description
                            : "기본 사용자 파라미터입니다. API 문서 기준으로 key/value를 확인해 주세요."}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-slate-700">
                <p className="font-semibold text-sky-900">날짜 파라미터 지원 값</p>
                <div className="mt-2 space-y-1">
                  {DATE_PARAM_VALUE_GUIDE.map((guide) => (
                    <p key={guide}>- {guide}</p>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowGroupParamGuide(false)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {groupTableMapTarget ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">적재 테이블 매핑</p>
                <p className="mt-1 text-xs text-slate-500">
                  {groupTableMapTarget.name} API 결과를 임시(_LRD) 테이블에 적재하고, 필요 시 최종 반영 SQL을 실행합니다.
                </p>
              </div>
              <button
                onClick={() => setGroupTableMapTarget(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="space-y-1 text-xs text-slate-600">
                스키마
                <select
                  value={groupTableMapForm.schema}
                  onChange={async (event) => {
                    const nextSchema = event.target.value;
                    setGroupTableMapForm((prev) => ({
                      ...prev,
                      schema: nextSchema,
                      table: "",
                      loadingTables: true,
                    }));
                    try {
                      const tables = await fetchMetaTables(nextSchema);
                      setGroupTableMapForm((prev) => ({
                        ...prev,
                        tables,
                        loadingTables: false,
                      }));
                    } catch (error) {
                      const message =
                        error instanceof Error
                          ? error.message
                          : "테이블 목록을 불러오지 못했습니다.";
                      setGroupTableMapForm((prev) => ({
                        ...prev,
                        tables: [],
                        loadingTables: false,
                      }));
                      setApiListStatus({ type: "error", message });
                    }
                  }}
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  disabled={groupTableMapForm.loadingSchemas}
                >
                  {groupTableMapForm.schemas.map((schema) => (
                    <option key={schema} value={schema}>
                      {schema}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-slate-600">
                임시 적재 테이블
                <select
                  value={groupTableMapForm.table}
                  onChange={(event) =>
                    setGroupTableMapForm((prev) => ({
                      ...prev,
                      table: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  disabled={groupTableMapForm.loadingTables}
                >
                  <option value="">_LRD 테이블 선택</option>
                  {groupTableMapForm.tables.map((table) => (
                    <option key={table} value={table}>
                      {table}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={groupTableMapForm.truncate}
                  onChange={(event) =>
                    setGroupTableMapForm((prev) => ({
                      ...prev,
                      truncate: event.target.checked,
                    }))
                  }
                />
                기존 데이터 삭제 후 적재
              </label>
              <label className="space-y-1 text-xs text-slate-600">
                최종 테이블 반영 SQL (선택)
                <textarea
                  value={groupTableMapForm.mergeSql}
                  onChange={(event) =>
                    setGroupTableMapForm((prev) => ({
                      ...prev,
                      mergeSql: event.target.value,
                    }))
                  }
                  rows={5}
                  placeholder="insert into schema.a (...) select ... from schema.a_lrd ... on conflict do nothing"
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs font-mono"
                />
              </label>
        </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setGroupTableMapTarget(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={handleSaveGroupTableMap}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                저장
              </button>
      </div>
          </div>
        </div>
      ) : null}
      {groupScheduleTarget ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">API 스케줄 설정</p>
                <p className="mt-1 text-xs text-slate-500">
                  {groupScheduleTarget.name} 실행 주기를 설정합니다.
                </p>
              </div>
              <button
                onClick={() => setGroupScheduleTarget(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={groupScheduleForm.enabled}
                  onChange={(event) =>
                    setGroupScheduleForm((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                />
                스케줄 활성화
              </label>
              <label className="space-y-1 text-xs text-slate-600">
                실행 방식
                <select
                  value={groupScheduleForm.type}
                  onChange={(event) =>
                    setGroupScheduleForm((prev) => ({
                      ...prev,
                      type: event.target.value as "interval" | "cron",
                    }))
                  }
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                >
                  <option value="interval">간격(분)</option>
                  <option value="cron">CRON</option>
                </select>
              </label>
              {groupScheduleForm.type === "interval" ? (
                <label className="space-y-1 text-xs text-slate-600">
                  실행 주기(분)
                  <input
                    type="number"
                    min={1}
                    value={groupScheduleForm.intervalMinutes}
                    onChange={(event) =>
                      setGroupScheduleForm((prev) => ({
                        ...prev,
                        intervalMinutes: Math.max(
                          1,
                          Number(event.target.value) || 1,
                        ),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
              ) : (
                <label className="space-y-1 text-xs text-slate-600">
                  CRON 표현식
                  <input
                    value={groupScheduleForm.cronExpr}
                    onChange={(event) =>
                      setGroupScheduleForm((prev) => ({
                        ...prev,
                        cronExpr: event.target.value,
                      }))
                    }
                    placeholder="예: 0 8 * * *"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setGroupScheduleTarget(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={handleSaveGroupSchedule}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <UserApiRegistrationModal
        open={showUserApiRegisterModal}
        templates={apiTemplates}
        sources={apiList}
        onClose={() => setShowUserApiRegisterModal(false)}
        onCompleted={() => {
          void fetchApiList();
          void fetchApiTemplates();
        }}
      />
    </section>
  );
}

