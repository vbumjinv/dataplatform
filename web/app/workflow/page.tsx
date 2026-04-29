'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ReactFlowProvider,
  addEdge,
  Connection,
  Edge,
  updateEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "reactflow";
import * as XLSX from "xlsx";
import { Toolbar } from "./components/Toolbar";
import { NodeSidebar } from "./components/NodeSidebar";
import { WorkflowCanvas } from "./components/WorkflowCanvas";
import { WorkflowProvider } from "./components/WorkflowContext";
import { NodeConfigModal } from "./components/NodeConfigModal";
import type {
  DataCollectorConfig,
  DataCollectorData,
  DataCollectorNode,
  IngestionKind,
  StorageKind,
  WorkflowState,
} from "./types";

const STORAGE_KEY = "workflow-prototype-state";
const SAVED_LIST_KEY = "workflow-prototype-saves";

type SavedWorkflow = {
  id: string;
  name: string;
  savedAt: string;
  state: WorkflowState;
  schedule?: WorkflowSchedule;
};
type WorkflowTab = {
  id: string;
  name: string;
  nodes: DataCollectorNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  configNodeId: string | null;
  savedId?: string;
};
type WorkflowSchedule = {
  enabled: boolean;
  mode: "interval" | "cron";
  intervalMinutes: number;
  cron: string;
  lastRunAt?: string;
  lastStatus?: "success" | "failure" | "running";
  lastError?: string;
  history?: Array<{
    ranAt: string;
    status: "success" | "failure";
    error?: string;
  }>;
};

const defaultConfig: DataCollectorConfig = {
  endpoint: "",
  method: "GET",
  timeout: 5000,
  apiKey: "",
  apiKeyByProvider: {},
  apiProviderConfigs: {},
  apiKeyParam: "",
  queryParams: "",
  apiListMode: false,
  apiFormat: "json",
  apiLang: "kr",
  apiStatCode: "",
  apiPeriod: "M",
  apiStart: "",
  apiEnd: "",
  apiUserStatsId: "",
  apiPrdSe: "Y",
  apiStartPrdDe: "",
  apiEndPrdDe: "",
  apiStrtYymm: "",
  apiEndYymm: "",
  apiOrgCode: "",
  apiName: "",
  apiFunctionName: "",
};

const ingestionLabels: Record<IngestionKind, string> = {
  excel: "엑셀 업로드",
  api: "API 수집",
  db: "DB 조회",
};

const storageLabels: Record<"dbSink", string> = {
  dbSink: "DB 설정",
};

const dataStorageLabels: Record<StorageKind, string> = {
  dbSave: "DB 저장",
  fileSave: "파일 저장",
};

const defaultEndpointByKind: Record<IngestionKind, string> = {
  api: defaultConfig.endpoint,
  excel: "",
  db: "/api/mock/db",
};

const parseJsonSafe = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const parseXmlRows = (value: string) => {
  if (typeof window === "undefined") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("<")) return null;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, "text/xml");
    const rowNodes = Array.from(doc.getElementsByTagName("row"));
    const itemNodes =
      rowNodes.length === 0 ? Array.from(doc.getElementsByTagName("item")) : [];
    const nodes = rowNodes.length > 0 ? rowNodes : itemNodes;
    if (nodes.length > 0) {
      const rows = nodes.map((row) => {
        const record: Record<string, unknown> = {};
        Array.from(row.children).forEach((child) => {
          record[child.tagName] = child.textContent ?? "";
        });
        return record;
      });
      return rows;
    }
  } catch {
    return null;
  }
  return null;
};

const createDefaultSchedule = (): WorkflowSchedule => ({
  enabled: false,
  mode: "interval",
  intervalMinutes: 60,
  cron: "0 * * * *",
});

const formatScheduleSummary = (schedule?: WorkflowSchedule) => {
  if (!schedule) return "스케줄 없음";
  if (!schedule.enabled) return "스케줄 비활성";
  if (schedule.mode === "interval") {
    return `매 ${schedule.intervalMinutes}분`;
  }
  return `크론 ${schedule.cron}`;
};

const formatScheduleLastRun = (schedule?: WorkflowSchedule) => {
  if (!schedule?.lastRunAt) return "마지막 실행 없음";
  const parsed = new Date(schedule.lastRunAt);
  const timestamp = Number.isNaN(parsed.getTime())
    ? schedule.lastRunAt
    : parsed.toLocaleString();
  if (!schedule.lastStatus) {
    return `마지막 실행 ${timestamp}`;
  }
  const statusLabel =
    schedule.lastStatus === "success"
      ? "성공"
      : schedule.lastStatus === "failure"
        ? "실패"
        : "실행 중";
  return `마지막 실행 ${timestamp} (${statusLabel})`;
};

const normalizeApiPayload = (payload: unknown) => {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const xmlRows = parseXmlRows(payload);
    if (xmlRows) return xmlRows;
    const trimmed = payload.trim();
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
    const header = Object.keys(first as Record<string, unknown>);
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

const buildProviderEndpoint = (config: DataCollectorConfig) => {
  const provider = config.apiProvider ?? "custom";
  if (provider === "bok") {
    const apiKey = config.apiKey ?? "";
    const format = config.apiFormat ?? "json";
    const lang = config.apiLang ?? "kr";
    const statCode = config.apiStatCode ?? "513Y001";
    const period = config.apiPeriod ?? "M";
    const start = config.apiStart ?? "202501";
    const end = config.apiEnd ?? "202601";
    return `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(
      apiKey,
    )}/${format}/${lang}/1/100000/${statCode}/${period}/${start}/${end}`;
  }
  if (provider === "kosis") {
    const url = new URL("https://kosis.kr/openapi/statisticsData.do");
    url.searchParams.set("method", "getList");
    url.searchParams.set("format", "json");
    url.searchParams.set("jsonVD", "Y");
    if (config.apiKey) url.searchParams.set("apiKey", config.apiKey);
    if (config.apiUserStatsId) {
      url.searchParams.set("userStatsId", config.apiUserStatsId);
    }
    url.searchParams.set("prdSe", config.apiPrdSe ?? "Y");
    if (config.apiStartPrdDe) {
      url.searchParams.set("startPrdDe", config.apiStartPrdDe);
    }
    if (config.apiEndPrdDe) {
      url.searchParams.set("endPrdDe", config.apiEndPrdDe);
    }
    return url.toString();
  }
  if (provider === "dataGoKr") {
    const orgCode = config.apiOrgCode ?? "";
    const apiName = config.apiName ?? "";
    const functionName = config.apiFunctionName ?? "";
    const url = new URL(
      `https://apis.data.go.kr/${orgCode}/${apiName}/${functionName}`,
    );
    const normalizeQueryValue = (value: string) => {
      if (value.includes("%")) {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
      return value;
    };
    if (config.apiKey) {
      url.searchParams.set("serviceKey", normalizeQueryValue(config.apiKey));
    }
    if (config.apiStrtYymm) {
      url.searchParams.set("strtYymm", config.apiStrtYymm);
    }
    if (config.apiEndYymm) {
      url.searchParams.set("endYymm", config.apiEndYymm);
    }
    return url.toString();
  }
  return config.endpoint;
};

const buildApiEndpoint = (endpoint: string, config: DataCollectorConfig) => {
  const provider = config.apiProvider ?? "custom";
  if (provider !== "custom") {
    return buildProviderEndpoint(config);
  }
  if (!endpoint) return endpoint;
  const isRelative = endpoint.startsWith("/");
  const url = new URL(endpoint, isRelative ? window.location.origin : undefined);
  const params = new URLSearchParams(config.queryParams ?? "");
  if (config.apiKey && config.apiKeyParam) {
    params.set(config.apiKeyParam, config.apiKey);
  }
  for (const [key, value] of params.entries()) {
    if (value) url.searchParams.set(key, value);
  }
  return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
};

type ApiParamRow = {
  id: number;
  param_key: string;
  param_value: string;
  param_location: string;
  param_order: number;
  encode_mode?: string | null;
  param_role?: string | null;
};

type ApiParamGroup = {
  id: number;
  name: string | null;
  params: ApiParamRow[];
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
  groups: ApiParamGroup[];
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
const buildApiUrlFromGroup = (source: ApiSource, group: ApiParamGroup) => {
  const url = new URL(source.base_url);
  const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
  const apiKeyKey = source.api_key_param_key?.trim() || "";
  const apiKeyLocation = source.api_key_location || "query";
  const apiKeyOrder = Number.isFinite(source.api_key_order)
    ? Number(source.api_key_order)
    : 0;
  const apiKeyValue = source.api_key ?? "";

  const pathParams = group.params
    .filter((item) => item.param_location === "path" && item.param_value.trim())
    .map((item) => ({
      key: item.param_key,
      value: item.param_value,
      order: item.param_order,
      encodeMode: item.encode_mode ?? "encode",
    }));
  const queryParams = group.params
    .filter(
      (item) =>
        item.param_location === "query" &&
        item.param_key.trim() &&
        item.param_value.trim() &&
        (!apiKeyKey || item.param_key !== apiKeyKey),
    )
    .map((item) => ({
      key: item.param_key,
      value: item.param_value,
      order: item.param_order,
      encodeMode: item.encode_mode ?? "encode",
    }));

  if (apiKeyValue && apiKeyKey) {
    if (apiKeyLocation === "path") {
      pathParams.push({
        key: apiKeyKey,
        value: apiKeyValue,
        order: apiKeyOrder,
        encodeMode: source.api_key_encode_mode ?? "encode",
      });
    } else {
      queryParams.push({
        key: apiKeyKey,
        value: apiKeyValue,
        order: apiKeyOrder,
        encodeMode: source.api_key_encode_mode ?? "encode",
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

/** 미리보기 UI용(상위 몇 행·열) */
const MAX_EXCEL_PREVIEW_ROWS = 100;
const MAX_EXCEL_PREVIEW_COLS = 80;
/**
 * 노드 상태에 보관하는 시트당 최대 행 수(브라우저 메모리 보호).
 * 10만 행 이상 엑셀은 이 한도 이내여야 합니다.
 */
const MAX_EXCEL_ROWS_STORED = 2_000_000;
/** 한 번의 /api/db/insert 요청 본문이 과도해지지 않도록 행 단위 분할 */
const DB_INSERT_CLIENT_CHUNK_SIZE = 2500;
/** 대량 INSERT 시 fetch 타임아웃(밀리초) */
const DB_INSERT_FETCH_TIMEOUT_MS = 600_000;

async function fetchDbInsertBatched(
  dbConfig: Record<string, unknown>,
  payloadBase: {
    schema: string;
    table: string;
    columns: string[];
    truncate?: boolean;
  },
  insertRows: Array<Array<unknown>>,
  options?: { chunkSize?: number; signal?: AbortSignal },
): Promise<number> {
  const chunkSize = options?.chunkSize ?? DB_INSERT_CLIENT_CHUNK_SIZE;
  if (!insertRows.length) return 0;
  let totalInserted = 0;
  for (let start = 0; start < insertRows.length; start += chunkSize) {
    const chunk = insertRows.slice(start, start + chunkSize);
    const response = await fetch("/api/db/insert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...dbConfig,
        schema: payloadBase.schema,
        table: payloadBase.table,
        columns: payloadBase.columns,
        rows: chunk,
        truncate: Boolean(payloadBase.truncate && start === 0),
      }),
      signal: options?.signal,
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      inserted?: number;
      error?: string;
    };
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || "데이터 저장에 실패했습니다.");
    }
    totalInserted += payload.inserted ?? chunk.length;
  }
  return totalInserted;
}

const normalizeColumnName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[^\w]/g, "");

const tokenizeColumnName = (value: string) => {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[\s_-]+/g, " ")
    .trim();
  if (!spaced) return [];
  return spaced
    .split(" ")
    .map((token) => token.toLowerCase())
    .filter(Boolean);
};

const buildAliasKeys = (value: string) => {
  const keys = new Set<string>();
  const normalized = normalizeColumnName(value);
  const tokens = tokenizeColumnName(value);
  if (normalized) keys.add(normalized);
  if (tokens.length > 0) keys.add(tokens.join("|"));
  if (tokens[tokens.length - 1] === "id") keys.add("id");
  if (normalized.endsWith("id")) keys.add("id");
  return keys;
};

const levenshteinDistance = (a: string, b: string) => {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[rows - 1][cols - 1];
};

const findBestFuzzyMatch = (value: string, candidates: string[]) => {
  const target = normalizeColumnName(value);
  if (!target || candidates.length === 0) return null;
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const normalized = normalizeColumnName(candidate);
    if (!normalized) continue;
    const distance = levenshteinDistance(target, normalized);
    const maxLen = Math.max(target.length, normalized.length);
    const ratio = maxLen ? distance / maxLen : 0;
    if (ratio < bestScore) {
      bestScore = ratio;
      best = candidate;
    }
  }
  return bestScore <= 0.3 ? best : null;
};

const buildAutoMappings = (
  columns: Array<{ name: string }>,
  sourceColumns: string[],
  existingMappings: Record<string, string>,
) => {
  const nextMappings: Record<string, string> = { ...existingMappings };
  if (!sourceColumns.length) return nextMappings;

  const normalizedSource = new Map<string, string>();
  const tokenSource = new Map<string, string>();
  const aliasSource = new Map<string, string>();
  for (const column of sourceColumns) {
    const normalized = normalizeColumnName(column);
    if (normalized && !normalizedSource.has(normalized)) {
      normalizedSource.set(normalized, column);
    }
    const tokenKey = tokenizeColumnName(column).join("|");
    if (tokenKey && !tokenSource.has(tokenKey)) {
      tokenSource.set(tokenKey, column);
    }
    for (const key of buildAliasKeys(column)) {
      if (!aliasSource.has(key)) {
        aliasSource.set(key, column);
      }
    }
  }

  for (const column of columns) {
    if (nextMappings[column.name]) continue;
    const exact = sourceColumns.find((value) => value === column.name);
    if (exact) {
      nextMappings[column.name] = exact;
      continue;
    }
    const insensitive = sourceColumns.find(
      (value) => value.toLowerCase() === column.name.toLowerCase(),
    );
    if (insensitive) {
      nextMappings[column.name] = insensitive;
      continue;
    }
    const normalized = normalizedSource.get(normalizeColumnName(column.name));
    if (normalized) {
      nextMappings[column.name] = normalized;
      continue;
    }
    const tokenMatch = tokenSource.get(
      tokenizeColumnName(column.name).join("|"),
    );
    if (tokenMatch) {
      nextMappings[column.name] = tokenMatch;
      continue;
    }
    const aliasMatch = Array.from(buildAliasKeys(column.name)).find((key) =>
      aliasSource.has(key),
    );
    if (aliasMatch) {
      nextMappings[column.name] = aliasSource.get(aliasMatch) ?? "";
      continue;
    }
    const fuzzyMatch = findBestFuzzyMatch(column.name, sourceColumns);
    if (fuzzyMatch) {
      nextMappings[column.name] = fuzzyMatch;
    }
  }

  return nextMappings;
};

const createIngestionNode = (
  id: string,
  kind: IngestionKind,
  position: { x: number; y: number },
): DataCollectorNode => ({
  id,
  type: "dataCollector",
  position,
  data: {
    label: ingestionLabels[kind],
    kind,
    status: "idle",
    preview: "",
    excelOptions:
      kind === "excel"
        ? {
            sheetName: undefined,
            startRow: 1,
            startCol: 1,
            hasHeader: true,
          }
        : undefined,
    dbQueryOptions:
      kind === "db"
        ? {
            mode: "table",
            schema: "public",
            schemas: [],
            schemasLoading: false,
            tableName: "",
            tables: [],
            tablesLoading: false,
            sql: "",
          }
        : undefined,
    config: { ...defaultConfig, endpoint: defaultEndpointByKind[kind] },
  },
});

const createDbSinkNode = (
  id: string,
  position: { x: number; y: number },
): DataCollectorNode => ({
  id,
  type: "dbSink",
  position,
  data: {
    label: storageLabels.dbSink,
    kind: "dbSink",
    status: "idle",
    preview: "",
    dbConfig: {
      url: "",
      database: "",
      user: "",
      password: "",
      dbType: "postgres",
    },
    config: { ...defaultConfig },
  },
});

const createDataStorageNode = (
  id: string,
  kind: StorageKind,
  position: { x: number; y: number },
): DataCollectorNode => ({
  id,
  type: "dataStorage",
  position,
  data: {
    label: dataStorageLabels[kind],
    kind,
    status: "idle",
    preview: "",
    storageOptions:
      kind === "dbSave"
        ? {
            schema: "public",
            schemas: [],
            schemasLoading: false,
            tableName: "",
            tables: [],
            tablesLoading: false,
            columns: [],
            columnsLoading: false,
            columnMappings: {},
            truncateBeforeInsert: false,
            apiListMode: false,
            groupTableMappings: {},
            groupTableOptions: {},
          }
        : undefined,
    fileSaveOptions:
      kind === "fileSave"
        ? {
            format: "xls",
            jsonShape: "array",
            fileName: "",
            includeHeader: true,
          }
        : undefined,
    config: { ...defaultConfig },
  },
});

function WorkflowPageInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<DataCollectorData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [configNodeId, setConfigNodeId] = useState<string | null>(null);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [errorPopup, setErrorPopup] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>([]);
  const [savedWorkflowsLoaded, setSavedWorkflowsLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<"workflow" | "saved">("workflow");
  const [workflowTabs, setWorkflowTabs] = useState<WorkflowTab[]>([]);
  const [activeWorkflowTabId, setActiveWorkflowTabId] = useState<string | null>(
    null,
  );
  const [savedView, setSavedView] = useState<"list" | "history">("list");
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(
    null,
  );
  const [editingWorkflowName, setEditingWorkflowName] = useState("");
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [savePromptName, setSavePromptName] = useState("");
  const [successPopup, setSuccessPopup] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<SavedWorkflow | null>(null);
  const [closeTabPrompt, setCloseTabPrompt] = useState<{
    tabId: string;
    name: string;
  } | null>(null);
  const [schedulePrompt, setSchedulePrompt] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [scheduleForm, setScheduleForm] = useState<WorkflowSchedule>(() =>
    createDefaultSchedule(),
  );
  const [importTargetId, setImportTargetId] = useState<string | null>(null);
  const idRef = useRef(2);
  const nodesRef = useRef<DataCollectorNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const savedListRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const reactFlow = useReactFlow();

  const scheduleTarget = useMemo(() => {
    if (!schedulePrompt) return null;
    return savedWorkflows.find((entry) => entry.id === schedulePrompt.id) ?? null;
  }, [savedWorkflows, schedulePrompt]);

  const configNode = useMemo(
    () => nodes.find((node) => node.id === configNodeId),
    [nodes, configNodeId],
  );
  const connectedDbNode = useMemo(() => {
    if (!configNode || configNode.data.kind !== "dbSave") return null;
    const dbEdge = edges.find((item) => {
      if (item.target !== configNode.id) return false;
      const sourceNode = nodes.find((node) => node.id === item.source);
      return sourceNode?.data.kind === "dbSink";
    });
    if (!dbEdge) return null;
    const sourceNode = nodes.find((node) => node.id === dbEdge.source);
    return sourceNode?.data.kind === "dbSink" ? sourceNode : null;
  }, [configNode, edges, nodes]);
  const connectedDbNodeForQuery = useMemo(() => {
    if (!configNode || configNode.data.kind !== "db") return null;
    const dbEdge = edges.find((item) => {
      if (item.target !== configNode.id) return false;
      const sourceNode = nodes.find((node) => node.id === item.source);
      return sourceNode?.data.kind === "dbSink";
    });
    if (!dbEdge) return null;
    const sourceNode = nodes.find((node) => node.id === dbEdge.source);
    return sourceNode?.data.kind === "dbSink" ? sourceNode : null;
  }, [configNode, edges, nodes]);
  const connectedSourceNodeForDbSave = useMemo(() => {
    if (!configNode || configNode.data.kind !== "dbSave") return null;
    const inputEdge = edges.find((item) => {
      if (item.target !== configNode.id) return false;
      const sourceNode = nodes.find((node) => node.id === item.source);
      return sourceNode?.data.kind !== "dbSink";
    });
    if (!inputEdge) return null;
    const sourceNode = nodes.find((node) => node.id === inputEdge.source);
    return sourceNode ?? null;
  }, [configNode, edges, nodes]);
  const connectedSourceNodeForFileSave = useMemo(() => {
    if (!configNode || configNode.data.kind !== "fileSave") return null;
    const inputEdge = edges.find((item) => item.target === configNode.id);
    if (!inputEdge) return null;
    const sourceNode = nodes.find((node) => node.id === inputEdge.source);
    return sourceNode ?? null;
  }, [configNode, edges, nodes]);
  const sourceColumnsForDbSave = useMemo(() => {
    const sourceNode = connectedSourceNodeForDbSave;
    if (!sourceNode) return [];
    if (sourceNode.data.kind === "excel") {
      const header = sourceNode.data.excelPreview?.header;
      if (header && header.length > 0) {
        return header.map((cell, index) => `${cell ?? `Column ${index + 1}`}`);
      }
      const rows = sourceNode.data.excelPreview?.rows;
      if (rows && rows.length > 0) {
        const width = rows[0].length;
        return Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
      }
      return [];
    }
    if (sourceNode.data.kind === "db") {
      const columnMeta = sourceNode.data.dbQueryColumns ?? [];
      if (columnMeta.length > 0) {
        return columnMeta.map((column) => column.name);
      }
      const rows = sourceNode.data.dbQueryRows ?? [];
      if (rows.length > 0) {
        return Object.keys(rows[0]);
      }
      return [];
    }
    if (sourceNode.data.kind === "api") {
      const parsed = sourceNode.data.apiResult ?? parseJsonSafe(sourceNode.data.preview ?? "");
      const tabular = buildTabularFromApi(parsed);
      return tabular.header;
    }
    return [];
  }, [connectedSourceNodeForDbSave]);
  const sourceColumnsForDbSaveMemo = useMemo(
    () => sourceColumnsForDbSave,
    [sourceColumnsForDbSave],
  );
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId],
  );

  useEffect(() => {
    if (!selectedNodeId && nodes.length > 0) {
      setSelectedNodeId(nodes[0].id);
    }
  }, [nodes, selectedNodeId]);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [edges, nodes]);

  useEffect(() => {
    if (!activeWorkflowTabId) return;
    setWorkflowTabs((prev) =>
      prev.map((tab) =>
        tab.id === activeWorkflowTabId
          ? {
              ...tab,
              nodes,
              edges,
              selectedNodeId,
              configNodeId,
            }
          : tab,
      ),
    );
  }, [activeWorkflowTabId, configNodeId, edges, nodes, selectedNodeId]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const handleSelectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    setNodeMenu(null);
  }, []);

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((prev) => prev.filter((node) => node.id !== nodeId));
      setEdges((prev) =>
        prev.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );
      setSelectedNodeId((prev) => (prev === nodeId ? null : prev));
      setConfigNodeId((prev) => (prev === nodeId ? null : prev));
      setNodeMenu((prev) => (prev?.nodeId === nodeId ? null : prev));
    },
    [setEdges, setNodes],
  );
  const handleDeleteEdge = useCallback(
    (edgeId: string) => {
      setEdges((prev) => prev.filter((edge) => edge.id !== edgeId));
    },
    [setEdges],
  );
  const handleEdgeUpdate = useCallback(
    (edge: Edge, connection: Connection) => {
      setEdges((prev) => updateEdge(edge, connection, prev));
    },
    [setEdges],
  );

  const updateNodeData = useCallback(
    (
      nodeId: string,
      updater: (prev: DataCollectorData) => DataCollectorData,
    ) => {
      setNodes((prev) => {
        const next = prev.map((node) =>
          node.id === nodeId ? { ...node, data: updater(node.data) } : node,
        );
        nodesRef.current = next;
        return next;
      });
    },
    [setNodes],
  );

  const handleChangeConfig = useCallback(
    (nodeId: string, config: Partial<DataCollectorConfig>) => {
      updateNodeData(nodeId, (prev) => ({
        ...prev,
        config: { ...prev.config, ...config },
      }));
    },
    [updateNodeData],
  );

  const handleChangeDbConfig = useCallback(
    (
      nodeId: string,
      config: {
        url?: string;
        database?: string;
        user?: string;
        password?: string;
      },
    ) => {
      setNodes((prev) => {
        const next = prev.map((node) => {
          if (node.id === nodeId) {
            return {
              ...node,
              data: {
                ...node.data,
                dbConfig: {
                  url: "",
                  database: "",
                  user: "",
                  password: "",
                  dbType: "postgres" as const,
                  ...node.data.dbConfig,
                  ...config,
                },
              },
            };
          }
          const isConnected =
            edges.some((edge) => edge.source === nodeId && edge.target === node.id);
          if (!isConnected) return node;
          if (node.data.kind === "dbSave") {
            return {
              ...node,
              data: {
                ...node.data,
                storageOptions: {
                  ...node.data.storageOptions,
                  schema: "",
                  tableName: "",
                  schemas: [],
                  tables: [],
                  columns: [],
                  schemasError: undefined,
                  tablesError: undefined,
                  columnsError: undefined,
                  columnMappings: {},
                },
              },
            };
          }
          if (node.data.kind === "db") {
            return {
              ...node,
              data: {
                ...node.data,
                dbQueryOptions: {
                  ...node.data.dbQueryOptions,
                  schema: "",
                  tableName: "",
                  schemas: [],
                  tables: [],
                  schemasError: undefined,
                  tablesError: undefined,
                },
              },
            };
          }
          return node;
        });
        nodesRef.current = next;
        return next;
      });
    },
    [edges, setNodes],
  );

  const showErrorPopup = useCallback((message: string, title = "오류 발생") => {
    setErrorPopup({ title, message });
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_LIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SavedWorkflow[];
      if (Array.isArray(parsed)) {
        setSavedWorkflows(parsed);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "저장된 목록을 불러오지 못했습니다.";
      showErrorPopup(message, "저장된 워크플로우");
    } finally {
      setSavedWorkflowsLoaded(true);
    }
  }, [showErrorPopup]);

  useEffect(() => {
    if (!savedWorkflowsLoaded) return;
    if (workflowTabs.length > 0) return;
    const existingNames = new Set(savedWorkflows.map((item) => item.name));
    let index = 1;
    let candidate = `워크플로우 ${index}`;
    while (existingNames.has(candidate)) {
      index += 1;
      candidate = `워크플로우 ${index}`;
    }
    const tabId = `tab-${Date.now()}`;
    const initialTab: WorkflowTab = {
      id: tabId,
      name: candidate,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      configNodeId: null,
    };
    setWorkflowTabs([initialTab]);
    setActiveWorkflowTabId(tabId);
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setConfigNodeId(null);
  }, [savedWorkflows, savedWorkflowsLoaded, setEdges, setNodes, workflowTabs.length]);

  const handleChangeStorageOptions = useCallback(
    (
      nodeId: string,
      options: {
        schema?: string;
        schemas?: string[];
        schemasLoading?: boolean;
        schemasError?: string;
        tableName?: string;
        tables?: string[];
        tablesLoading?: boolean;
        tablesError?: string;
        columns?: Array<{ name: string; dataType: string }>;
        columnsLoading?: boolean;
        columnsError?: string;
        columnMappings?: Record<string, string>;
        truncateBeforeInsert?: boolean;
        apiListMode?: boolean;
        groupTableMappings?: Record<string, { schema?: string; table?: string }>;
        groupTableOptions?: Record<
          string,
          { tables?: string[]; loading?: boolean; error?: string }
        >;
      },
    ) => {
      updateNodeData(nodeId, (prev) => ({
        ...prev,
        storageOptions: {
          ...prev.storageOptions,
          ...options,
        },
      }));
    },
    [updateNodeData],
  );

  const handleChangeFileSaveOptions = useCallback(
    (
      nodeId: string,
      options: {
        fileName?: string;
        includeHeader?: boolean;
      },
    ) => {
      updateNodeData(nodeId, (prev) => ({
        ...prev,
        fileSaveOptions: {
          ...prev.fileSaveOptions,
          ...options,
        },
      }));
    },
    [updateNodeData],
  );

  const handleFetchDbSchemas = useCallback(
    async (nodeId: string, dbNodeId: string) => {
      const dbNode = nodes.find((node) => node.id === dbNodeId);
      if (!dbNode || dbNode.data.kind !== "dbSink") {
        showErrorPopup("연결된 DB 설정 노드를 찾을 수 없습니다.", "DB 설정");
        return;
      }
      const dbConfig = dbNode.data.dbConfig;
      if (
        !dbConfig?.url ||
        !dbConfig.database ||
        !dbConfig.user ||
        !dbConfig.password
      ) {
        showErrorPopup("DB 설정 정보를 모두 입력하세요.", "DB 설정");
        return;
      }

      handleChangeStorageOptions(nodeId, {
        schemasLoading: true,
        schemasError: undefined,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch("/api/db/schemas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dbConfig),
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          schemas?: string[];
          error?: string;
        };
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || "스키마를 불러오지 못했습니다.");
        }
        handleChangeStorageOptions(nodeId, {
          schemas: payload.schemas ?? [],
          schemasLoading: false,
          schemasError: undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "스키마를 불러오지 못했습니다.";
        handleChangeStorageOptions(nodeId, {
          schemasLoading: false,
          schemasError: message,
        });
        showErrorPopup(message, "DB 설정");
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [handleChangeStorageOptions, nodes, showErrorPopup],
  );

  const handleFetchDbColumns = useCallback(
    async (nodeId: string, dbNodeId: string, tableName: string) => {
      const storageNode = nodes.find((node) => node.id === nodeId);
      const dbNode = nodes.find((node) => node.id === dbNodeId);
      if (!dbNode || dbNode.data.kind !== "dbSink") {
        showErrorPopup("연결된 DB 설정 노드를 찾을 수 없습니다.", "DB 설정");
        return;
      }
      const dbConfig = dbNode.data.dbConfig;
      if (
        !dbConfig?.url ||
        !dbConfig.database ||
        !dbConfig.user ||
        !dbConfig.password
      ) {
        showErrorPopup("DB 설정 정보를 모두 입력하세요.", "DB 설정");
        return;
      }
      const schema =
        storageNode?.data.storageOptions?.schema?.trim() || "public";

      handleChangeStorageOptions(nodeId, {
        columnsLoading: true,
        columnsError: undefined,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch("/api/db/columns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...dbConfig, schema, table: tableName }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          columns?: Array<{ name: string; dataType: string }>;
          error?: string;
        };
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || "컬럼을 불러오지 못했습니다.");
        }
        const columns = payload.columns ?? [];
        const existingMappings =
          storageNode?.data.storageOptions?.columnMappings ?? {};
        const nextMappings = buildAutoMappings(
          columns,
          sourceColumnsForDbSave,
          existingMappings,
        );
        handleChangeStorageOptions(nodeId, {
          columns,
          columnsLoading: false,
          columnsError: undefined,
          columnMappings: nextMappings,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "컬럼을 불러오지 못했습니다.";
        handleChangeStorageOptions(nodeId, {
          columnsLoading: false,
          columnsError: message,
        });
        showErrorPopup(message, "DB 설정");
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [
      handleChangeStorageOptions,
      nodes,
      showErrorPopup,
      sourceColumnsForDbSave,
    ],
  );

  const handleFetchDbTablesAction = useCallback(
    async (nodeId: string, dbNodeId: string) => {
      const storageNode = nodes.find((node) => node.id === nodeId);
      const dbNode = nodes.find((node) => node.id === dbNodeId);
      if (!dbNode || dbNode.data.kind !== "dbSink") {
        showErrorPopup("연결된 DB 설정 노드를 찾을 수 없습니다.", "DB 설정");
        return;
      }
      const dbConfig = dbNode.data.dbConfig;
      if (
        !dbConfig?.url ||
        !dbConfig.database ||
        !dbConfig.user ||
        !dbConfig.password
      ) {
        showErrorPopup("DB 설정 정보를 모두 입력하세요.", "DB 설정");
        return;
      }

      handleChangeStorageOptions(nodeId, {
        tablesLoading: true,
        tablesError: undefined,
      });

      const schema =
        storageNode?.data.storageOptions?.schema?.trim() || "public";

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch("/api/db/tables", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...dbConfig, schema }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          tables?: string[];
          error?: string;
        };
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || "테이블을 불러오지 못했습니다.");
        }
        const nextTables = payload.tables ?? [];
        handleChangeStorageOptions(nodeId, {
          tables: nextTables,
          tablesLoading: false,
          tablesError: undefined,
        });
        const currentTable = storageNode?.data.storageOptions?.tableName?.trim();
        if (currentTable && !nextTables.includes(currentTable)) {
          handleChangeStorageOptions(nodeId, {
            tableName: "",
            columns: [],
            columnsError: undefined,
            columnMappings: {},
          });
        }
        if (currentTable && nextTables.includes(currentTable)) {
          await handleFetchDbColumns(nodeId, dbNodeId, currentTable);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "테이블을 불러오지 못했습니다.";
        handleChangeStorageOptions(nodeId, {
          tablesLoading: false,
          tablesError: message,
        });
        showErrorPopup(message, "DB 설정");
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [handleChangeStorageOptions, handleFetchDbColumns, nodes, showErrorPopup],
  );

  const handleFetchDbTablesBySchema = useCallback(
    async (nodeId: string, dbNodeId: string, schema: string, groupId: number) => {
      const storageNode = nodes.find((node) => node.id === nodeId);
      const dbNode = nodes.find((node) => node.id === dbNodeId);
      if (!dbNode || dbNode.data.kind !== "dbSink") {
        showErrorPopup("연결된 DB 설정 노드를 찾을 수 없습니다.", "DB 설정");
        return;
      }
      const dbConfig = dbNode.data.dbConfig;
      if (
        !dbConfig?.url ||
        !dbConfig.database ||
        !dbConfig.user ||
        !dbConfig.password
      ) {
        showErrorPopup("DB 설정 정보를 모두 입력하세요.", "DB 설정");
        return;
      }

      const groupKey = String(groupId);
      const currentOptions =
        storageNode?.data.storageOptions?.groupTableOptions ?? {};

      handleChangeStorageOptions(nodeId, {
        groupTableOptions: {
          ...currentOptions,
          [groupKey]: { tables: [], loading: true, error: undefined },
        },
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch("/api/db/tables", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...dbConfig, schema }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          tables?: string[];
          error?: string;
        };
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || "테이블을 불러오지 못했습니다.");
        }
        const nextTables = payload.tables ?? [];
        const nextGroupOptions = {
          ...(storageNode?.data.storageOptions?.groupTableOptions ?? {}),
          [groupKey]: { tables: nextTables, loading: false, error: undefined },
        };
        const currentMappings =
          storageNode?.data.storageOptions?.groupTableMappings ?? {};
        const currentMapping = currentMappings[groupKey];
        const nextMapping = {
          ...(currentMapping ?? {}),
          schema,
          table:
            currentMapping?.table && nextTables.includes(currentMapping.table)
              ? currentMapping.table
              : "",
        };
        handleChangeStorageOptions(nodeId, {
          groupTableOptions: nextGroupOptions,
          groupTableMappings: {
            ...currentMappings,
            [groupKey]: nextMapping,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "테이블을 불러오지 못했습니다.";
        handleChangeStorageOptions(nodeId, {
          groupTableOptions: {
            ...(storageNode?.data.storageOptions?.groupTableOptions ?? {}),
            [groupKey]: { tables: [], loading: false, error: message },
          },
        });
        showErrorPopup(message, "DB 설정");
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [handleChangeStorageOptions, nodes, showErrorPopup],
  );

  const handleChangeDbQueryOptions = useCallback(
    (
      nodeId: string,
      options: {
        mode?: "table" | "sql";
        schema?: string;
        schemas?: string[];
        schemasLoading?: boolean;
        schemasError?: string;
        tableName?: string;
        tables?: string[];
        tablesLoading?: boolean;
        tablesError?: string;
        sql?: string;
      },
    ) => {
      updateNodeData(nodeId, (prev) => ({
        ...prev,
        dbQueryOptions: {
          ...prev.dbQueryOptions,
          ...options,
        },
      }));
    },
    [updateNodeData],
  );

  const handleApplyAutoMapping = useCallback(
    (nodeId: string) => {
      const storageNode = nodes.find((node) => node.id === nodeId);
      const columns = storageNode?.data.storageOptions?.columns ?? [];
      const existingMappings =
        storageNode?.data.storageOptions?.columnMappings ?? {};
      const nextMappings = buildAutoMappings(
        columns,
        sourceColumnsForDbSave,
        existingMappings,
      );
      handleChangeStorageOptions(nodeId, {
        columnMappings: nextMappings,
      });
    },
    [handleChangeStorageOptions, nodes, sourceColumnsForDbSave],
  );

  const handleResetMapping = useCallback(
    (nodeId: string) => {
      handleChangeStorageOptions(nodeId, { columnMappings: {} });
    },
    [handleChangeStorageOptions],
  );

  const handleFetchDbQuerySchemas = useCallback(
    async (nodeId: string, dbNodeId: string) => {
      const dbNode = nodes.find((node) => node.id === dbNodeId);
      if (!dbNode || dbNode.data.kind !== "dbSink") {
        showErrorPopup("연결된 DB 설정 노드를 찾을 수 없습니다.", "DB 설정");
        return;
      }
      const dbConfig = dbNode.data.dbConfig;
      if (
        !dbConfig?.url ||
        !dbConfig.database ||
        !dbConfig.user ||
        !dbConfig.password
      ) {
        showErrorPopup("DB 설정 정보를 모두 입력하세요.", "DB 설정");
        return;
      }

      handleChangeDbQueryOptions(nodeId, {
        schemasLoading: true,
        schemasError: undefined,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch("/api/db/schemas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dbConfig),
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          schemas?: string[];
          error?: string;
        };
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || "스키마를 불러오지 못했습니다.");
        }
        handleChangeDbQueryOptions(nodeId, {
          schemas: payload.schemas ?? [],
          schemasLoading: false,
          schemasError: undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "스키마를 불러오지 못했습니다.";
        handleChangeDbQueryOptions(nodeId, {
          schemasLoading: false,
          schemasError: message,
        });
        showErrorPopup(message, "DB 설정");
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [handleChangeDbQueryOptions, nodes, showErrorPopup],
  );

  const handleFetchDbQueryTables = useCallback(
    async (nodeId: string, dbNodeId: string) => {
      const dbNode = nodes.find((node) => node.id === dbNodeId);
      if (!dbNode || dbNode.data.kind !== "dbSink") {
        showErrorPopup("연결된 DB 설정 노드를 찾을 수 없습니다.", "DB 설정");
        return;
      }
      const dbConfig = dbNode.data.dbConfig;
      if (
        !dbConfig?.url ||
        !dbConfig.database ||
        !dbConfig.user ||
        !dbConfig.password
      ) {
        showErrorPopup("DB 설정 정보를 모두 입력하세요.", "DB 설정");
        return;
      }

      handleChangeDbQueryOptions(nodeId, {
        tablesLoading: true,
        tablesError: undefined,
      });

      const schema =
        nodes.find((node) => node.id === nodeId)?.data.dbQueryOptions?.schema ??
        "public";

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch("/api/db/tables", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...dbConfig, schema }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          tables?: string[];
          error?: string;
        };
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || "테이블을 불러오지 못했습니다.");
        }
        handleChangeDbQueryOptions(nodeId, {
          tables: payload.tables ?? [],
          tablesLoading: false,
          tablesError: undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "테이블을 불러오지 못했습니다.";
        handleChangeDbQueryOptions(nodeId, {
          tablesLoading: false,
          tablesError: message,
        });
        showErrorPopup(message, "DB 설정");
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [handleChangeDbQueryOptions, nodes, showErrorPopup],
  );

  const buildExcelPreview = useCallback(
    (
      rows: Array<Array<string | number | boolean | null>>,
      options: { startRow: number; startCol: number; hasHeader: boolean },
      sheetName: string,
    ) => {
      const startRow = Math.max(1, options.startRow || 1);
      const startCol = Math.max(1, options.startCol || 1);
      const slicedRows = rows
        .slice(startRow - 1, startRow - 1 + MAX_EXCEL_PREVIEW_ROWS)
        .map((row) =>
          row.slice(startCol - 1, startCol - 1 + MAX_EXCEL_PREVIEW_COLS),
        );
      const previewRows = slicedRows.slice(0, 5);
      if (options.hasHeader && previewRows.length > 0) {
        const [header, ...body] = previewRows;
        return { sheet: sheetName, rows: body, header };
      }
      return { sheet: sheetName, rows: previewRows };
    },
    [],
  );

  const buildExcelInsertData = useCallback(
    (
      rows: Array<Array<string | number | boolean | null>>,
      options: { startRow: number; startCol: number; hasHeader: boolean },
    ) => {
      const startRow = Math.max(1, options.startRow || 1);
      const startCol = Math.max(1, options.startCol || 1);
      const fromRow = startRow - 1;
      const maxRows = Math.max(0, MAX_EXCEL_ROWS_STORED - fromRow);
      const slicedRows = rows
        .slice(fromRow, fromRow + maxRows)
        .map((row) => row.slice(startCol - 1));
      if (!slicedRows.length) {
        return { header: [], dataRows: [] };
      }
      if (options.hasHeader) {
        const [header, ...body] = slicedRows;
        const normalizedHeader = header.map((cell, index) =>
          String(cell ?? `Column ${index + 1}`),
        );
        return { header: normalizedHeader, dataRows: body };
      }
      const width = slicedRows[0].length;
      const normalizedHeader = Array.from(
        { length: width },
        (_, index) => `Column ${index + 1}`,
      );
      return { header: normalizedHeader, dataRows: slicedRows };
    },
    [],
  );

  const downloadXls = useCallback(
    (
      rows: Array<Array<unknown>>,
      options?: { fileName?: string; textColumnIndexes?: Set<number> },
    ) => {
      const textColumnIndexes = options?.textColumnIndexes;
      const normalizedRows = rows.map((row) =>
        row.map((cell, index) => {
          if (cell == null) return "";
          if (textColumnIndexes?.has(index)) return String(cell);
          return cell;
        }),
      );
      const worksheet = XLSX.utils.aoa_to_sheet(normalizedRows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Data");
      const buffer = XLSX.write(workbook, { bookType: "xls", type: "array" });
      const blob = new Blob([buffer], {
        type: "application/vnd.ms-excel",
      });
      const url = URL.createObjectURL(blob);
      const fileName = options?.fileName?.trim() || "data";
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName.endsWith(".xls") ? fileName : `${fileName}.xls`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      return anchor.download;
    },
    [],
  );

  const handleExcelUpload = useCallback(
    async (nodeId: string, file: File) => {

      updateNodeData(nodeId, (prev) => ({
        ...prev,
        status: "running",
        error: undefined,
        preview: "",
        excelPreview: undefined,
        fileName: file.name,
      }));

      try {
        const node = nodes.find((n) => n.id === nodeId);
        const excelOptions = {
          startRow: 1,
          startCol: 1,
          hasHeader: node?.data.excelOptions?.hasHeader ?? true,
          sheetName: undefined,
        };
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const sheetNames = workbook.SheetNames;
        const sheetName = sheetNames[0];
        if (!sheetName) {
          throw new Error("엑셀 시트를 찾을 수 없습니다.");
        }
        const excelRowsBySheet: Record<
          string,
          Array<Array<string | number | boolean | null>>
        > = {};
        sheetNames.forEach((name) => {
          const sheet = workbook.Sheets[name];
          const rows = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
          }) as Array<Array<string | number | boolean | null>>;
          excelRowsBySheet[name] =
            rows.length > MAX_EXCEL_ROWS_STORED
              ? rows.slice(0, MAX_EXCEL_ROWS_STORED)
              : rows;
        });
        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "idle",
          excelRowsBySheet,
          excelSheets: sheetNames,
          excelOptions: {
            ...excelOptions,
            sheetName,
          },
          error: undefined,
          fileName: file.name,
        }));
      } catch (error) {
        const rawMessage =
          error instanceof Error
            ? error.message
            : "엑셀 파일을 읽는 중 오류가 발생했습니다.";
        const message = rawMessage.includes("Bad uncompressed size")
          ? "엑셀 파일이 손상되었거나 지원되지 않는 형식입니다."
          : rawMessage;
        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "error",
          error: message,
          lastRun: new Date().toISOString(),
          preview: "",
          excelPreview: undefined,
        }));
        showErrorPopup(message, "엑셀 업로드 실패");
      }
    },
    [buildExcelPreview, nodes, showErrorPopup, updateNodeData],
  );

  const handleExcelOptionsChange = useCallback(
    (nodeId: string, options: Partial<NonNullable<DataCollectorData["excelOptions"]>>) => {
      updateNodeData(nodeId, (prev) => {
        const excelOptions = {
          startRow: 1,
          startCol: 1,
          hasHeader: true,
          ...prev.excelOptions,
          ...options,
        };
        const canAutoPreview =
          !!prev.excelRowsBySheet &&
          !!prev.lastRun &&
          prev.status !== "running";
        const sheetName =
          excelOptions.sheetName ||
          prev.excelPreview?.sheet ||
          prev.excelSheets?.[0];
        if (
          canAutoPreview &&
          sheetName &&
          prev.excelRowsBySheet?.[sheetName]
        ) {
          const previewPayload = buildExcelPreview(
            prev.excelRowsBySheet[sheetName],
            excelOptions,
            sheetName,
          );
          const preview = JSON.stringify(previewPayload, null, 2);
          return {
            ...prev,
            excelOptions,
            excelPreview: previewPayload,
            preview,
          };
        }
        return {
          ...prev,
          excelOptions,
          preview: "",
          excelPreview: undefined,
        };
      });
    },
    [buildExcelPreview, updateNodeData],
  );

  const executeNode = useCallback(
    async (nodeId: string) => {
      const nodesSnapshot = nodesRef.current;
      const edgesSnapshot = edgesRef.current;
      const target = nodesSnapshot.find((n) => n.id === nodeId);
      if (!target) return;
      const getSourceNodeForTarget = (
        targetId: string,
        predicate?: (node: DataCollectorNode) => boolean,
      ) => {
        const targetEdges = edgesSnapshot.filter(
          (item) => item.target === targetId,
        );
        for (const edge of targetEdges) {
          const sourceNode =
            nodesSnapshot.find((node) => node.id === edge.source) ?? null;
          if (!sourceNode) continue;
          if (predicate && !predicate(sourceNode)) continue;
          return sourceNode;
        }
        return null;
      };
      const getDbSinkForTarget = (targetId: string) =>
        getSourceNodeForTarget(
          targetId,
          (node) => node.data.kind === "dbSink",
        );

      if (target.data.kind === "dbSave" || target.data.kind === "fileSave") {
        if (target.data.kind === "fileSave") {
          const sourceNode = getSourceNodeForTarget(
            nodeId,
            (node) => node.data.kind !== "dbSink",
          );
          if (!sourceNode) {
            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "error",
              error: "입력 노드를 연결하세요.",
              lastRun: new Date().toISOString(),
            }));
            showErrorPopup("입력 노드를 연결하세요.", "파일 저장");
            return;
          }

          let csvRows: Array<Array<unknown>> = [];
          let jsonPayload: unknown = null;
          const includeHeader = target.data.fileSaveOptions?.includeHeader ?? true;
          const format = target.data.fileSaveOptions?.format ?? "xls";
          const jsonShape = target.data.fileSaveOptions?.jsonShape ?? "array";

          if (sourceNode.data.kind === "excel") {
            const sheetName =
              sourceNode.data.excelOptions?.sheetName ||
              sourceNode.data.excelSheets?.[0];
            const rows = sheetName
              ? sourceNode.data.excelRowsBySheet?.[sheetName]
              : undefined;
            if (!rows || !rows.length) {
              updateNodeData(nodeId, (prev) => ({
                ...prev,
                status: "error",
                error: "엑셀 데이터를 먼저 실행하세요.",
                lastRun: new Date().toISOString(),
              }));
              showErrorPopup("엑셀 데이터를 먼저 실행하세요.", "파일 저장");
              return;
            }

            const excelOptions = {
              startRow: 1,
              startCol: 1,
              hasHeader: true,
              ...sourceNode.data.excelOptions,
            };
            const { header, dataRows } = buildExcelInsertData(rows, excelOptions);
            csvRows = includeHeader ? [header, ...dataRows] : dataRows;
            jsonPayload = includeHeader
              ? dataRows.map((row) =>
                  header.reduce<Record<string, unknown>>((acc, key, index) => {
                    acc[key] = row[index] ?? null;
                    return acc;
                  }, {}),
                )
              : dataRows;
          } else if (sourceNode.data.kind === "db") {
            const rows = sourceNode.data.dbQueryRows ?? [];
            if (!rows.length) {
              updateNodeData(nodeId, (prev) => ({
                ...prev,
                status: "error",
                error: "DB 조회 데이터를 먼저 실행하세요.",
                lastRun: new Date().toISOString(),
              }));
              showErrorPopup("DB 조회 데이터를 먼저 실행하세요.", "파일 저장");
              return;
            }
            const columnMeta = sourceNode.data.dbQueryColumns ?? [];
            const headers =
              columnMeta.length > 0
                ? columnMeta.map((column) => column.name)
                : Object.keys(rows[0]);
            const textColumnIndexes = new Set<number>();
            const textTypes = new Set([
              "character varying",
              "character",
              "text",
              "varchar",
              "char",
              "bpchar",
              "citext",
            ]);
            columnMeta.forEach((column, index) => {
              if (textTypes.has(column.dataType.toLowerCase())) {
                textColumnIndexes.add(index);
              }
            });
            const dataRows = rows.map((row) =>
              headers.map((key) => row[key] ?? null),
            );
            csvRows = includeHeader ? [headers, ...dataRows] : dataRows;
            jsonPayload = rows;
            const downloaded = downloadXls(csvRows, {
              fileName: target.data.fileSaveOptions?.fileName,
              textColumnIndexes,
            });

            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "success",
              error: undefined,
              preview: JSON.stringify(
                { message: "XLS 저장 완료", fileName: downloaded },
                null,
                2,
              ),
              lastRun: new Date().toISOString(),
            }));
            if (format === "xls") {
              return;
            }
          } else if (sourceNode.data.kind === "api") {
            const apiPayload =
              sourceNode.data.apiResult ?? parseJsonSafe(sourceNode.data.preview ?? "");
            if (apiPayload == null) {
              updateNodeData(nodeId, (prev) => ({
                ...prev,
                status: "error",
                error: "API 응답 데이터가 없어 저장할 수 없습니다.",
                lastRun: new Date().toISOString(),
              }));
              showErrorPopup("API 응답 데이터가 없어 저장할 수 없습니다.", "파일 저장");
              return;
            }
            const tabular = buildTabularFromApi(apiPayload);
            csvRows = includeHeader
              ? [tabular.header, ...tabular.dataRows]
              : tabular.dataRows;
            jsonPayload = normalizeApiPayload(apiPayload);
          } else {
            const preview = sourceNode.data.preview;
            if (!preview) {
              updateNodeData(nodeId, (prev) => ({
                ...prev,
                status: "error",
                error: "입력 노드 데이터를 먼저 실행하세요.",
                lastRun: new Date().toISOString(),
              }));
              showErrorPopup("입력 노드 데이터를 먼저 실행하세요.", "파일 저장");
              return;
            }
            try {
              const parsed = JSON.parse(preview) as unknown;
              if (Array.isArray(parsed) && parsed.length > 0) {
                const headers = Object.keys(parsed[0] as Record<string, unknown>);
                const dataRows = parsed.map((row) =>
                  headers.map((key) =>
                    (row as Record<string, unknown>)[key] ?? null,
                  ),
                );
                csvRows = includeHeader ? [headers, ...dataRows] : dataRows;
                jsonPayload = parsed;
              } else if (parsed && typeof parsed === "object") {
                const headers = Object.keys(parsed as Record<string, unknown>);
                const dataRows = [
                  headers.map(
                    (key) => (parsed as Record<string, unknown>)[key] ?? null,
                  ),
                ];
                csvRows = includeHeader ? [headers, ...dataRows] : dataRows;
                jsonPayload = parsed;
              }
            } catch {
              // fall through to empty data
            }
          }
          if (!csvRows.length) {
            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "error",
              error: "저장할 데이터가 없습니다.",
              lastRun: new Date().toISOString(),
            }));
            showErrorPopup("저장할 데이터가 없습니다.", "파일 저장");
            return;
          }

          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "running",
            error: undefined,
          }));

          let downloaded = "";
          const fileName = target.data.fileSaveOptions?.fileName?.trim() || "data";
          if (format === "json") {
            const payload =
              jsonShape === "object" ? { rows: jsonPayload ?? [] } : jsonPayload ?? [];
            const blob = new Blob(
              [JSON.stringify(payload, null, 2)],
              { type: "application/json;charset=utf-8;" },
            );
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = fileName.endsWith(".json")
              ? fileName
              : `${fileName}.json`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            downloaded = anchor.download;
          } else {
            downloaded = downloadXls(csvRows, {
              fileName,
            });
          }

          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "success",
            error: undefined,
            preview: JSON.stringify(
              {
                message: format === "json" ? "JSON 저장 완료" : "XLS 저장 완료",
                fileName: downloaded,
              },
              null,
              2,
            ),
            lastRun: new Date().toISOString(),
          }));
          return;
        }

        const dbNode = getDbSinkForTarget(nodeId);
        const dbConfig = dbNode?.data.dbConfig;
        const sourceNode = getSourceNodeForTarget(
          nodeId,
          (node) => node.data.kind !== "dbSink",
        );
        const storageOptions = target.data.storageOptions;

        if (!dbConfig || !sourceNode) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "DB 설정 또는 입력 노드가 연결되지 않았습니다.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup(
            "DB 설정 또는 입력 노드가 연결되지 않았습니다.",
            "데이터 저장",
          );
          return;
        }

        if (storageOptions?.apiListMode) {
          if (
            sourceNode.data.kind !== "api" ||
            !sourceNode.data.config.apiListMode
          ) {
            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "error",
              error: "API 목록 실행 노드를 연결하세요.",
              lastRun: new Date().toISOString(),
            }));
            showErrorPopup(
              "API 목록 실행 노드를 연결하세요.",
              "데이터 저장",
            );
            return;
          }

          const apiResults = Array.isArray(sourceNode.data.apiResult)
            ? sourceNode.data.apiResult
            : null;
          if (!apiResults) {
            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "error",
              error: "API 실행 결과가 없습니다.",
              lastRun: new Date().toISOString(),
            }));
            showErrorPopup("API 실행 결과가 없습니다.", "데이터 저장");
            return;
          }

          const mappings = storageOptions.groupTableMappings ?? {};
          const truncatedTables = new Set<string>();
          const tableColumnsCache = new Map<string, string[]>();
          const results: Array<{
            groupId: number;
            ok: boolean;
            table?: string;
            error?: string;
          }> = [];

          for (const result of apiResults) {
            if (!result?.ok) {
              results.push({
                groupId: result?.groupId ?? 0,
                ok: false,
                error: result?.error ?? "API 실행 실패",
              });
              continue;
            }
            const groupKey = String(result.groupId ?? "");
            const mapping = mappings[groupKey];
            if (!mapping?.schema || !mapping?.table) {
              results.push({
                groupId: result.groupId,
                ok: false,
                error: "TEMP 테이블 매핑이 필요합니다.",
              });
              continue;
            }

            const apiPayload = result.data;
            if (apiPayload == null) {
              results.push({
                groupId: result.groupId,
                ok: false,
                error: "API 응답 데이터가 없습니다.",
              });
              continue;
            }
            const tabular = buildTabularFromApi(apiPayload);
            const header = tabular.header;
            const dataRows = tabular.dataRows;
            if (!header.length || !dataRows.length) {
              results.push({
                groupId: result.groupId,
                ok: false,
                error: "저장할 데이터가 없습니다.",
              });
              continue;
            }

            const tableKey = `${mapping.schema}.${mapping.table}`;
            let tableColumns = tableColumnsCache.get(tableKey);
            if (!tableColumns) {
              try {
                const response = await fetch("/api/db/columns", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    ...dbConfig,
                    schema: mapping.schema,
                    table: mapping.table,
                  }),
                });
                const payload = (await response.json()) as {
                  ok?: boolean;
                  columns?: Array<{ name: string; dataType: string }>;
                  error?: string;
                };
                if (!response.ok || !payload?.ok) {
                  throw new Error(payload?.error || "컬럼을 불러오지 못했습니다.");
                }
                tableColumns = (payload.columns ?? []).map((column) => column.name);
                tableColumnsCache.set(tableKey, tableColumns);
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : "컬럼을 불러오지 못했습니다.";
                results.push({
                  groupId: result.groupId,
                  ok: false,
                  error: message,
                });
                continue;
              }
            }

            if (!tableColumns.length) {
              results.push({
                groupId: result.groupId,
                ok: false,
                error: "테이블 컬럼 정보를 불러오지 못했습니다.",
              });
              continue;
            }

            const headerIndex = new Map(
              header.map((name, index) => [String(name).toLowerCase(), index]),
            );
            const columnsToInsert = tableColumns.filter((column) =>
              headerIndex.has(column.toLowerCase()),
            );
            if (!columnsToInsert.length) {
              results.push({
                groupId: result.groupId,
                ok: false,
                error: "API 컬럼과 테이블 컬럼이 맞지 않습니다.",
              });
              continue;
            }

            const insertRows = dataRows
              .map((row) =>
                columnsToInsert.map((column) => {
                  const index = headerIndex.get(column.toLowerCase());
                  return index == null ? null : (row[index] ?? null);
                }),
              )
              .filter((row) => row.some((value) => value !== null && value !== ""));
            if (!insertRows.length) {
              results.push({
                groupId: result.groupId,
                ok: false,
                error: "저장할 데이터가 없습니다.",
              });
              continue;
            }

            const truncateKey = tableKey;
            const shouldTruncate =
              storageOptions.truncateBeforeInsert && !truncatedTables.has(truncateKey);
            try {
              await fetchDbInsertBatched(
                dbConfig as Record<string, unknown>,
                {
                  schema: mapping.schema,
                  table: mapping.table,
                  columns: columnsToInsert,
                  truncate: shouldTruncate,
                },
                insertRows,
              );
              if (shouldTruncate) {
                truncatedTables.add(truncateKey);
              }
              results.push({
                groupId: result.groupId,
                ok: true,
                table: truncateKey,
              });
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : "데이터 저장에 실패했습니다.";
              results.push({
                groupId: result.groupId,
                ok: false,
                table: `${mapping.schema}.${mapping.table}`,
                error: message,
              });
            }
          }

          const successCount = results.filter((item) => item.ok).length;
          const failureCount = results.length - successCount;
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: failureCount > 0 ? "error" : "success",
            preview: JSON.stringify(
              { successCount, failureCount, results },
              null,
              2,
            ),
            error:
              failureCount > 0
                ? `실패 ${failureCount}건이 있습니다.`
                : undefined,
            lastRun: new Date().toISOString(),
          }));
          if (failureCount > 0) {
            showErrorPopup("일부 데이터 저장에 실패했습니다.", "데이터 저장");
          }
          return;
        }

        const tableName = storageOptions?.tableName;
        if (!tableName) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "저장할 테이블을 선택하세요.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("저장할 테이블을 선택하세요.", "데이터 저장");
          return;
        }

        let header: string[] = [];
        let dataRows: Array<Array<unknown>> = [];
        if (sourceNode.data.kind === "excel") {
          const sheetName =
            sourceNode.data.excelOptions?.sheetName ||
            sourceNode.data.excelSheets?.[0];
          const rows = sheetName
            ? sourceNode.data.excelRowsBySheet?.[sheetName]
            : undefined;
          if (!rows || !rows.length) {
            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "error",
              error: "엑셀 데이터를 먼저 실행하세요.",
              lastRun: new Date().toISOString(),
            }));
            showErrorPopup("엑셀 데이터를 먼저 실행하세요.", "데이터 저장");
            return;
          }

          const excelOptions = {
            startRow: 1,
            startCol: 1,
            hasHeader: true,
            ...sourceNode.data.excelOptions,
          };
          const excelPayload = buildExcelInsertData(rows, excelOptions);
          header = excelPayload.header;
          dataRows = excelPayload.dataRows;
        } else if (sourceNode.data.kind === "db") {
          const rows = sourceNode.data.dbQueryRows ?? [];
          if (!rows.length) {
            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "error",
              error: "DB 조회 데이터를 먼저 실행하세요.",
              lastRun: new Date().toISOString(),
            }));
            showErrorPopup("DB 조회 데이터를 먼저 실행하세요.", "데이터 저장");
            return;
          }
          const columnMeta = sourceNode.data.dbQueryColumns ?? [];
          header =
            columnMeta.length > 0
              ? columnMeta.map((column) => column.name)
              : Object.keys(rows[0]);
          dataRows = rows.map((row) =>
            header.map((key) => row[key] ?? null),
          );
        } else if (sourceNode.data.kind === "api") {
          const apiPayload =
            sourceNode.data.apiResult ?? parseJsonSafe(sourceNode.data.preview ?? "");
          if (apiPayload == null) {
            updateNodeData(nodeId, (prev) => ({
              ...prev,
              status: "error",
              error: "API 응답 데이터가 없어 저장할 수 없습니다.",
              lastRun: new Date().toISOString(),
            }));
            showErrorPopup("API 응답 데이터가 없어 저장할 수 없습니다.", "데이터 저장");
            return;
          }
          const tabular = buildTabularFromApi(apiPayload);
          header = tabular.header;
          dataRows = tabular.dataRows;
        } else {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "지원되지 않는 입력 노드입니다.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("지원되지 않는 입력 노드입니다.", "데이터 저장");
          return;
        }
        if (!header.length || !dataRows.length) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "입력 데이터를 확인할 수 없습니다.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("입력 데이터를 확인할 수 없습니다.", "데이터 저장");
          return;
        }
        const mappings = storageOptions?.columnMappings ?? {};
        const mappedColumns = Object.keys(mappings).filter(
          (column) => mappings[column],
        );
        if (!mappedColumns.length) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "컬럼 매핑을 완료하세요.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("컬럼 매핑을 완료하세요.", "데이터 저장");
          return;
        }

        const sourceIndices = mappedColumns.map((column) =>
          header.indexOf(mappings[column]),
        );
        if (sourceIndices.some((index) => index < 0)) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "입력 컬럼 매핑이 올바르지 않습니다.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup(
            "입력 컬럼 매핑이 올바르지 않습니다.",
            "데이터 저장",
          );
          return;
        }

        const insertRows = dataRows
          .map((row) => sourceIndices.map((index) => row[index] ?? null))
          .filter((row) => row.some((value) => value !== null && value !== ""));
        if (!insertRows.length) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "저장할 데이터가 없습니다.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("저장할 데이터가 없습니다.", "데이터 저장");
          return;
        }

        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "running",
          error: undefined,
        }));

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          DB_INSERT_FETCH_TIMEOUT_MS,
        );
        try {
          const insertedTotal = await fetchDbInsertBatched(
            dbConfig as Record<string, unknown>,
            {
              schema: storageOptions?.schema ?? "public",
              table: tableName,
              columns: mappedColumns,
              truncate: storageOptions?.truncateBeforeInsert ?? false,
            },
            insertRows,
            { signal: controller.signal },
          );
          const preview = JSON.stringify(
            {
              message: "데이터 저장 완료",
              inserted: insertedTotal,
            },
            null,
            2,
          );
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "success",
            error: undefined,
            preview,
            lastRun: new Date().toISOString(),
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "데이터 저장에 실패했습니다.";
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: message,
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup(message, "데이터 저장");
        } finally {
          clearTimeout(timeoutId);
        }
        return;
      }

      if (target.data.kind === "dbSink") {
        const dbConfig = target.data.dbConfig;
        if (
          !dbConfig?.url ||
          !dbConfig.database ||
          !dbConfig.user ||
          !dbConfig.password
        ) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "DB 설정 정보를 모두 입력하세요.",
            lastRun: new Date().toISOString(),
            preview: "",
          }));
          showErrorPopup("DB 설정 정보를 모두 입력하세요.", "DB 설정");
          return;
        }

        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "running",
          error: undefined,
        }));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        try {
          const response = await fetch("/api/db/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(dbConfig),
            signal: controller.signal,
          });
          const payload = (await response.json()) as {
            ok?: boolean;
            durationMs?: number;
            error?: string;
          };
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error || "DB 연결에 실패했습니다.");
          }

          const preview = JSON.stringify(
            {
              message: "DB 연결 성공",
              durationMs: payload.durationMs,
            },
            null,
            2,
          );

          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "success",
            error: undefined,
            preview,
            lastRun: new Date().toISOString(),
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "DB 연결에 실패했습니다.";
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: message,
            preview: "",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup(message, "DB 설정");
        } finally {
          clearTimeout(timeoutId);
        }
        return;
      }

      if (target.data.kind === "excel") {
        const sheetName =
          target.data.excelOptions?.sheetName ||
          target.data.excelSheets?.[0];
        if (!sheetName) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "선택할 시트가 없습니다. 파일을 다시 업로드하세요.",
            lastRun: new Date().toISOString(),
            preview: "",
            excelPreview: undefined,
          }));
          showErrorPopup(
            "선택할 시트가 없습니다. 파일을 다시 업로드하세요.",
            "엑셀 실행 실패",
          );
          return;
        }
        const rows =
          target.data.excelRowsBySheet
            ? target.data.excelRowsBySheet[sheetName]
            : undefined;
        if (!rows || !rows.length) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "엑셀 파일을 업로드하고 다시 실행하세요.",
            lastRun: new Date().toISOString(),
            preview: "",
            excelPreview: undefined,
          }));
          showErrorPopup(
            "엑셀 파일을 업로드하고 다시 실행하세요.",
            "엑셀 실행 실패",
          );
          return;
        }
        try {
          const excelOptions = {
            startRow: 1,
            startCol: 1,
            hasHeader: true,
            ...target.data.excelOptions,
          };
          const previewPayload = buildExcelPreview(
            rows,
            excelOptions,
            sheetName,
          );
          const preview = JSON.stringify(previewPayload, null, 2);
        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "success",
          preview,
          excelPreview: previewPayload,
          error: undefined,
          lastRun: new Date().toISOString(),
        }));
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "엑셀 미리보기를 생성하지 못했습니다.";
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: message,
            lastRun: new Date().toISOString(),
            preview: "",
            excelPreview: undefined,
          }));
          showErrorPopup(message, "엑셀 실행 실패");
        }
        return;
      }

      if (target.data.kind === "db") {
        const dbConfig = getDbSinkForTarget(nodeId)?.data.dbConfig;
        const queryOptions = target.data.dbQueryOptions;
        if (!dbConfig) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "DB 설정 노드를 연결하세요.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("DB 설정 노드를 연결하세요.", "DB 조회");
          return;
        }
        if (!queryOptions) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "조회 설정이 없습니다.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("조회 설정이 없습니다.", "DB 조회");
          return;
        }

        if (
          queryOptions.mode === "table" &&
          (!queryOptions.tableName || !queryOptions.schema)
        ) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "조회할 테이블을 선택하세요.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("조회할 테이블을 선택하세요.", "DB 조회");
          return;
        }

        if (queryOptions.mode === "sql" && !queryOptions.sql?.trim()) {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: "SQL을 입력하세요.",
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup("SQL을 입력하세요.", "DB 조회");
          return;
        }

        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "running",
          error: undefined,
        }));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        try {
          const response = await fetch("/api/db/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...dbConfig,
              schema: queryOptions.schema ?? "public",
              table: queryOptions.tableName,
              sql: queryOptions.mode === "sql" ? queryOptions.sql : undefined,
            }),
            signal: controller.signal,
          });
          const payload = (await response.json()) as {
            ok?: boolean;
            rows?: unknown[];
            columns?: Array<{ name: string; dataType: string }>;
            error?: string;
          };
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error || "데이터 조회에 실패했습니다.");
          }
          const rows = (payload.rows ?? []) as Array<Record<string, unknown>>;
          const preview = JSON.stringify(rows, null, 2);
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "success",
            error: undefined,
            preview,
            dbQueryRows: rows,
            dbQueryColumns: payload.columns,
            lastRun: new Date().toISOString(),
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "데이터 조회에 실패했습니다.";
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: message,
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup(message, "DB 조회");
        } finally {
          clearTimeout(timeoutId);
        }
        return;
      }

      if (target.data.kind === "api") {
        const apiConfig = target.data.config;
        if (apiConfig.apiListMode) {
          // 목록 실행 모드는 개별 필드 검증을 건너뜁니다.
        } else {
        const provider = apiConfig.apiProvider ?? "custom";
        const missingFields: string[] = [];
        const formatErrors: string[] = [];
        if (provider === "custom") {
          if (!apiConfig.endpoint?.trim()) missingFields.push("Endpoint URL");
        } else if (provider === "bok") {
          if (!apiConfig.apiKey?.trim()) missingFields.push("API Key");
          if (!apiConfig.apiStatCode?.trim()) missingFields.push("STAT_CODE");
          if (!apiConfig.apiPeriod?.trim()) missingFields.push("기간 구분");
          if (!apiConfig.apiStart?.trim()) missingFields.push("시작");
          if (!apiConfig.apiEnd?.trim()) missingFields.push("종료");
          const period = apiConfig.apiPeriod?.trim() ?? "";
          const periodPatternMap: Record<string, RegExp> = {
            Q: /^\d{4}Q[1-4]$/,
            D: /^\d{8}$/,
            M: /^\d{6}$/,
            A: /^\d{4}$/,
          };
          const pattern = periodPatternMap[period];
          if (!pattern) {
            formatErrors.push("기간 구분 형식이 올바르지 않습니다.");
          } else {
            if (apiConfig.apiStart && !pattern.test(apiConfig.apiStart)) {
              formatErrors.push("시작 값 형식이 올바르지 않습니다.");
            }
            if (apiConfig.apiEnd && !pattern.test(apiConfig.apiEnd)) {
              formatErrors.push("종료 값 형식이 올바르지 않습니다.");
            }
          }
        } else if (provider === "kosis") {
          if (!apiConfig.apiKey?.trim()) missingFields.push("API Key");
          if (!apiConfig.apiUserStatsId?.trim())
            missingFields.push("userStatsId");
          if (!apiConfig.apiPrdSe?.trim()) missingFields.push("prdSe");
          if (!apiConfig.apiStartPrdDe?.trim())
            missingFields.push("startPrdDe");
          if (!apiConfig.apiEndPrdDe?.trim())
            missingFields.push("endPrdDe");
        } else if (provider === "dataGoKr") {
          if (!apiConfig.apiOrgCode?.trim()) missingFields.push("기관코드");
          if (!apiConfig.apiName?.trim()) missingFields.push("API명");
          if (!apiConfig.apiFunctionName?.trim()) missingFields.push("상세 기능명");
          if (!apiConfig.apiKey?.trim()) missingFields.push("API Key");
          if (!apiConfig.apiStrtYymm?.trim()) missingFields.push("시작");
          if (!apiConfig.apiEndYymm?.trim()) missingFields.push("종료");
        }
        if (missingFields.length > 0 || formatErrors.length > 0) {
          const message =
            missingFields.length > 0
              ? `필수 값이 비어있습니다: ${missingFields.join(", ")}`
              : formatErrors.join(" ");
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: message,
            lastRun: new Date().toISOString(),
            preview: "",
          }));
          showErrorPopup(message, "API 수집");
          return;
        }
        }
      }

      updateNodeData(nodeId, (prev) => ({
        ...prev,
        status: "running",
        error: undefined,
      }));

      if (target.data.kind === "api" && target.data.config.apiListMode) {
        try {
          const refreshResponse = await fetch("/api/ingestion/api-config", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updateTarget: "refreshPeriods" }),
          });
          const refreshPayload = (await refreshResponse.json()) as {
            ok?: boolean;
            error?: string;
          };
          if (!refreshResponse.ok || !refreshPayload.ok) {
            throw new Error(refreshPayload.error || "기간 값 갱신에 실패했습니다.");
          }

          const listResponse = await fetch("/api/ingestion/api-config");
          const listPayload = (await listResponse.json()) as {
            ok?: boolean;
            sources?: ApiSource[];
            error?: string;
          };
          if (!listResponse.ok || !listPayload.ok) {
            throw new Error(listPayload.error || "API 목록을 불러오지 못했습니다.");
          }

          const sources = listPayload.sources ?? [];
          const timeout = target.data.config.timeout ?? 5000;
          const results: Array<{
            sourceId: number;
            groupId: number;
            ok: boolean;
            error?: string;
            data?: unknown;
          }> = [];

          for (const source of sources) {
            if (!source.enabled) continue;
            for (const group of source.groups) {
              if (!group.params || group.params.length === 0) continue;
              const url = buildApiUrlFromGroup(source, group);
              const requestUrl = `/api/collect?url=${encodeURIComponent(
                url,
              )}&timeout=${timeout}`;
              try {
                const response = await fetch(requestUrl);
                const contentType = response.headers.get("content-type") ?? "";
                const payload = contentType.includes("application/json")
                  ? await response.json()
                  : await response.text();
                if (!response.ok) {
                  const errorMessage =
                    typeof payload === "string"
                      ? payload
                      : payload?.error
                        ? typeof payload.error === "string"
                          ? payload.error
                          : JSON.stringify(payload.error)
                        : JSON.stringify(payload ?? {});
                  throw new Error(errorMessage || "수집에 실패했습니다.");
                }
                const apiResult = (payload?.data ?? payload) as unknown;
                results.push({
                  sourceId: source.id,
                  groupId: group.id,
                  ok: true,
                  data: apiResult,
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "수집에 실패했습니다.";
                results.push({
                  sourceId: source.id,
                  groupId: group.id,
                  ok: false,
                  error: message,
                });
              }
            }
          }

          const successCount = results.filter((item) => item.ok).length;
          const failureCount = results.length - successCount;
          const preview = JSON.stringify(
            { successCount, failureCount, results },
            null,
            2,
          );
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: failureCount > 0 ? "error" : "success",
            preview,
            apiResult: results,
            error:
              failureCount > 0
                ? `실패 ${failureCount}건이 있습니다.`
                : undefined,
            lastRun: new Date().toISOString(),
          }));
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "알 수 없는 이유로 실패했습니다.";
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            status: "error",
            error: message,
            lastRun: new Date().toISOString(),
          }));
          showErrorPopup(message, "API 목록 실행 실패");
        }
        return;
      }

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), target.data.config.timeout || 0);
      const endpoint =
        target.data.config.endpoint || defaultEndpointByKind[target.data.kind];
      const resolvedEndpoint = buildApiEndpoint(endpoint, target.data.config);

      try {
        const isRelative = resolvedEndpoint.startsWith("/");
        const requestUrl = isRelative
          ? resolvedEndpoint
          : `/api/collect?url=${encodeURIComponent(
              resolvedEndpoint,
            )}&timeout=${target.data.config.timeout}`;
        const response = await fetch(requestUrl, { signal: controller.signal });
        const contentType = response.headers.get("content-type") ?? "";
        const payload = contentType.includes("application/json")
          ? await response.json()
          : await response.text();
        if (!response.ok) {
          const errorMessage =
            typeof payload === "string"
              ? payload
              : payload?.error
                ? typeof payload.error === "string"
                  ? payload.error
                  : JSON.stringify(payload.error)
                : JSON.stringify(payload ?? {});
          throw new Error(errorMessage || "수집에 실패했습니다.");
        }

        const apiResult = (payload?.data ?? payload) as unknown;
        const preview = JSON.stringify(apiResult, null, 2);
        const trimmed = preview.length > 300 ? `${preview.slice(0, 300)}...` : preview;

        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "success",
          preview: trimmed,
          apiResult,
          error: undefined,
          lastRun: new Date().toISOString(),
        }));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "알 수 없는 이유로 실패했습니다.";
        updateNodeData(nodeId, (prev) => ({
          ...prev,
          status: "error",
          error: message,
          lastRun: new Date().toISOString(),
        }));
        showErrorPopup(message, "수집 실행 실패");
      } finally {
        clearTimeout(timeoutId);
      }
    },
    [showErrorPopup, updateNodeData],
  );

  const runNode = useCallback(
    async (
      nodeId: string,
      options?: { force?: boolean; executed?: Set<string> },
    ) => {
      const executed = options?.executed ?? new Set<string>();
      const waitForNodeSettled = async (
        targetId: string,
        timeoutMs = 1500,
      ) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const current = nodesRef.current.find((node) => node.id === targetId);
          if (!current) return null;
          if (current.data.status !== "running") return current;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return nodesRef.current.find((node) => node.id === targetId) ?? null;
      };
      const runWithDependencies = async (
        targetId: string,
        visiting: Set<string>,
      ): Promise<boolean> => {
        if (executed.has(targetId)) return true;
        if (visiting.has(targetId)) return true;
        visiting.add(targetId);
        const nodesSnapshot = nodesRef.current;
        const edgesSnapshot = edgesRef.current;
        const target = nodesSnapshot.find((node) => node.id === targetId);
        if (!target) return false;
        const incoming = edgesSnapshot.filter((edge) => edge.target === targetId);
        for (const edge of incoming) {
          const ok = await runWithDependencies(edge.source, visiting);
          if (!ok) return false;
        }
        const latestTarget = nodesRef.current.find(
          (node) => node.id === targetId,
        );
        const shouldRun =
          options?.force || latestTarget?.data.status !== "success";
        if (shouldRun) {
          await executeNode(targetId);
        }
        const settled = await waitForNodeSettled(targetId);
        visiting.delete(targetId);
        executed.add(targetId);
        return settled?.data.status === "success";
      };
      await runWithDependencies(nodeId, new Set<string>());
    },
    [executeNode],
  );

  const handleRunAll = useCallback(async () => {
    setRunningAll(true);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const adjacency = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const node of nodes) {
      adjacency.set(node.id, []);
      indegree.set(node.id, 0);
    }
    for (const edge of edges) {
      if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
      adjacency.get(edge.source)?.push(edge.target);
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
    const queue: string[] = [];
    for (const [nodeId, count] of indegree.entries()) {
      if (count === 0) queue.push(nodeId);
    }
    const ordered: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      ordered.push(current);
      for (const next of adjacency.get(current) ?? []) {
        const nextCount = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, nextCount);
        if (nextCount === 0) queue.push(next);
      }
    }
    if (ordered.length !== nodes.length) {
      const remaining = nodes
        .filter((node) => !ordered.includes(node.id))
        .sort((a, b) => {
          if (a.position.x !== b.position.x) {
            return a.position.x - b.position.x;
          }
          return a.position.y - b.position.y;
        })
        .map((node) => node.id);
      ordered.push(...remaining);
    }
    const maxPasses = Math.max(2, ordered.length);
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const before = new Map(
        nodesRef.current.map((node) => [
          node.id,
          { status: node.data.status, lastRun: node.data.lastRun },
        ]),
      );
      for (const nodeId of ordered) {
        await runNode(nodeId, { force: pass === 0 });
      }
      const progressed = nodesRef.current.some((node) => {
        const snapshot = before.get(node.id);
        if (!snapshot) return true;
        return (
          snapshot.status !== node.data.status ||
          snapshot.lastRun !== node.data.lastRun
        );
      });
      if (!progressed) break;
    }
    setRunningAll(false);
  }, [edges, nodes, runNode]);

  const handleAddIngestionNode = useCallback(
    (kind: IngestionKind, position?: { x: number; y: number }) => {
      let nextPosition = position;
      if (!nextPosition && canvasRef.current) {
        const bounds = canvasRef.current.getBoundingClientRect();
        const viewport = reactFlow.getViewport();
        nextPosition = {
          x: (-viewport.x + bounds.width / 2) / viewport.zoom,
          y: (-viewport.y + bounds.height / 2) / viewport.zoom,
        };
      }

      const id = `node-${idRef.current}`;
      idRef.current += 1;
      const fallback = {
        x: 240 + nodes.length * 30,
        y: 180 + nodes.length * 20,
      };
      setNodes((prev) => [
        ...prev,
        createIngestionNode(id, kind, nextPosition ?? fallback),
      ]);
      setSelectedNodeId(id);
    },
    [nodes.length, reactFlow, setNodes],
  );

  const handleAddDataStorageNode = useCallback(
    (kind: StorageKind, position?: { x: number; y: number }) => {
      let nextPosition = position;
      if (!nextPosition && canvasRef.current) {
        const bounds = canvasRef.current.getBoundingClientRect();
        const viewport = reactFlow.getViewport();
        nextPosition = {
          x: (-viewport.x + bounds.width / 2) / viewport.zoom,
          y: (-viewport.y + bounds.height / 2) / viewport.zoom,
        };
      }

      const id = `node-${idRef.current}`;
      idRef.current += 1;
      const fallback = {
        x: 300 + nodes.length * 30,
        y: 260 + nodes.length * 20,
      };
      setNodes((prev) => [
        ...prev,
        createDataStorageNode(id, kind, nextPosition ?? fallback),
      ]);
      setSelectedNodeId(id);
    },
    [nodes.length, reactFlow, setNodes],
  );

  const handleAddDbSinkNode = useCallback(
    (position?: { x: number; y: number }) => {
      let nextPosition = position;
      if (!nextPosition && canvasRef.current) {
        const bounds = canvasRef.current.getBoundingClientRect();
        const viewport = reactFlow.getViewport();
        nextPosition = {
          x: (-viewport.x + bounds.width / 2) / viewport.zoom,
          y: (-viewport.y + bounds.height / 2) / viewport.zoom,
        };
      }

      const id = `node-${idRef.current}`;
      idRef.current += 1;
      const fallback = {
        x: 260 + nodes.length * 30,
        y: 220 + nodes.length * 20,
      };
      setNodes((prev) => [
        ...prev,
        createDbSinkNode(id, nextPosition ?? fallback),
      ]);
      setSelectedNodeId(id);
    },
    [nodes.length, reactFlow, setNodes],
  );

  const handleSave = useCallback(() => {
    if (typeof window === "undefined") return;
    const serializableNodes = nodes.map((node) => ({
      ...node,
      data: { ...node.data },
    }));
    const payload: WorkflowState = {
      nodes: serializableNodes,
      edges,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [edges, nodes]);

  const handleLoad = useCallback(() => {
    if (typeof window === "undefined") return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as WorkflowState;
      if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        const normalizedNodes = parsed.nodes.map((node) => {
          if (!node.data.kind) {
            return {
              ...node,
              data: {
                ...node.data,
                kind: "api" as IngestionKind,
                label: node.data.label || ingestionLabels.api,
              },
            };
          }
          return node;
        });
        setNodes(normalizedNodes);
        setEdges(parsed.edges as Edge[]);
        setSelectedNodeId(normalizedNodes[0]?.id ?? null);
        idRef.current = normalizedNodes.length + 1;
      }
    } catch (error) {
      console.error("저장된 워크플로우를 불러오는 중 오류 발생", error);
    }
  }, [setEdges, setNodes]);

  const handleReset = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    idRef.current = 1;
  }, [setEdges, setNodes]);
  const handleSelectWorkflowTab = useCallback(
    (tabId: string) => {
      const target = workflowTabs.find((tab) => tab.id === tabId);
      if (!target) return;
      setActiveWorkflowTabId(tabId);
      setNodes(target.nodes);
      setEdges(target.edges);
      setSelectedNodeId(target.selectedNodeId);
      setConfigNodeId(target.configNodeId);
    },
    [setEdges, setNodes, workflowTabs],
  );
  const handleAddWorkflowTab = useCallback(() => {
    const nextId = `tab-${Date.now()}`;
    const existingNames = new Set([
      ...workflowTabs.map((tab) => tab.name),
      ...savedWorkflows.map((item) => item.name),
    ]);
    let index = workflowTabs.length + 1;
    let candidate = `워크플로우 ${index}`;
    while (existingNames.has(candidate)) {
      index += 1;
      candidate = `워크플로우 ${index}`;
    }
    const name = candidate;
    const entry: WorkflowTab = {
      id: nextId,
      name,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      configNodeId: null,
    };
    setWorkflowTabs((prev) => [...prev, entry]);
    setActiveWorkflowTabId(nextId);
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setConfigNodeId(null);
  }, [savedWorkflows, setEdges, setNodes, workflowTabs]);
  const normalizeStateForCompare = useCallback((state: WorkflowState) => {
    const nodes = [...state.nodes]
      .map((node) => ({
        ...node,
        data: {
          ...node.data,
          status: "idle" as const,
          error: undefined,
          preview: "",
          apiResult: undefined,
          lastRun: undefined,
          excelPreview: undefined,
          dbQueryRows: undefined,
          dbQueryColumns: undefined,
        },
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const edges = [...state.edges].sort((a, b) => a.id.localeCompare(b.id));
    return { nodes, edges };
  }, []);
  const isWorkflowStateEqual = useCallback(
    (left: WorkflowState, right: WorkflowState) => {
      const leftNormalized = normalizeStateForCompare(left);
      const rightNormalized = normalizeStateForCompare(right);
      return JSON.stringify(leftNormalized) === JSON.stringify(rightNormalized);
    },
    [normalizeStateForCompare],
  );
  const closeWorkflowTabNow = useCallback(
    (tabId: string) => {
      const next = workflowTabs.filter((tab) => tab.id !== tabId);
      setWorkflowTabs(next);
      if (activeWorkflowTabId === tabId) {
        const fallback = next[0];
        setActiveWorkflowTabId(fallback.id);
        setNodes(fallback.nodes);
        setEdges(fallback.edges);
        setSelectedNodeId(fallback.selectedNodeId);
        setConfigNodeId(fallback.configNodeId);
      }
    },
    [activeWorkflowTabId, setEdges, setNodes, workflowTabs],
  );
  const handleCloseWorkflowTab = useCallback(
    (tabId: string) => {
      if (workflowTabs.length <= 1) {
        showErrorPopup("최소 1개 탭은 유지해야 합니다.", "탭 닫기");
        return;
      }
      const target = workflowTabs.find((tab) => tab.id === tabId);
      if (!target) return;
      if (target.savedId) {
        const saved = savedWorkflows.find((entry) => entry.id === target.savedId);
        const currentState: WorkflowState = {
          nodes: activeWorkflowTabId === tabId ? nodes : target.nodes,
          edges: activeWorkflowTabId === tabId ? edges : target.edges,
        };
        if (saved && !isWorkflowStateEqual(currentState, saved.state)) {
          setCloseTabPrompt({ tabId: target.id, name: target.name });
          return;
        }
      }
      closeWorkflowTabNow(tabId);
    },
    [
      activeWorkflowTabId,
      closeWorkflowTabNow,
      edges,
      isWorkflowStateEqual,
      nodes,
      savedWorkflows,
      setEdges,
      setNodes,
      showErrorPopup,
      workflowTabs,
    ],
  );
  const handleConfirmCloseWorkflowTab = useCallback(() => {
    if (!closeTabPrompt) return;
    closeWorkflowTabNow(closeTabPrompt.tabId);
    setCloseTabPrompt(null);
  }, [closeTabPrompt, closeWorkflowTabNow]);
  const handleResetRun = useCallback(() => {
    setNodes((prev) => {
      const next = prev.map((node) => ({
        ...node,
        data: {
          ...node.data,
          status: "idle" as const,
          error: undefined,
          preview: "",
          apiResult: undefined,
          lastRun: undefined,
          excelPreview: undefined,
          dbQueryRows: undefined,
          dbQueryColumns: undefined,
        },
      }));
      nodesRef.current = next;
      return next;
    });
  }, [setNodes]);
  const persistSavedWorkflows = useCallback((next: SavedWorkflow[]) => {
    setSavedWorkflows(next);
    localStorage.setItem(SAVED_LIST_KEY, JSON.stringify(next));
  }, []);
  const updateSavedWorkflows = useCallback(
    (updater: (prev: SavedWorkflow[]) => SavedWorkflow[]) => {
      setSavedWorkflows((prev) => {
        const next = updater(prev);
        localStorage.setItem(SAVED_LIST_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );
  const saveWorkflowWithName = useCallback(
    (rawName: string, savedId?: string) => {
      const name = rawName.trim();
      if (!name) {
        showErrorPopup("이름을 입력하세요.", "저장하기");
        return;
      }
      const activeTab = workflowTabs.find(
        (tab) => tab.id === activeWorkflowTabId,
      );
      const activeSavedId = savedId ?? activeTab?.savedId;
      if (
        savedWorkflows.some(
          (item) => item.name === name && item.id !== activeSavedId,
        )
      ) {
        showErrorPopup("같은 이름이 이미 존재합니다.", "저장하기");
        return;
      }
      const savedAt = new Date().toISOString();
      if (activeSavedId) {
        const next = savedWorkflows.map((item) =>
          item.id === activeSavedId
            ? { ...item, name, savedAt, state: { nodes, edges } }
            : item,
        );
        persistSavedWorkflows(next);
      } else {
        const entry: SavedWorkflow = {
          id: `wf-${Date.now()}`,
          name,
          savedAt,
          state: { nodes, edges },
        };
        const next = [entry, ...savedWorkflows].slice(0, 50);
        persistSavedWorkflows(next);
        if (activeWorkflowTabId) {
          setWorkflowTabs((prev) =>
            prev.map((tab) =>
              tab.id === activeWorkflowTabId
                ? { ...tab, name, savedId: entry.id }
                : tab,
            ),
          );
        }
      }
      if (activeWorkflowTabId) {
        setWorkflowTabs((prev) =>
          prev.map((tab) =>
            tab.id === activeWorkflowTabId ? { ...tab, name } : tab,
          ),
        );
      }
      setSavePromptOpen(false);
      setSavePromptName("");
      setSuccessPopup({
        title: "저장 완료",
        message: "워크플로우가 저장되었습니다.",
      });
    },
    [
      activeWorkflowTabId,
      edges,
      nodes,
      persistSavedWorkflows,
      savedWorkflows,
      showErrorPopup,
      workflowTabs,
    ],
  );
  const handleSaveAndCloseWorkflowTab = useCallback(() => {
    if (!closeTabPrompt) return;
    const target = workflowTabs.find((tab) => tab.id === closeTabPrompt.tabId);
    if (target?.savedId) {
      saveWorkflowWithName(target.name, target.savedId);
    }
    closeWorkflowTabNow(closeTabPrompt.tabId);
    setCloseTabPrompt(null);
  }, [closeTabPrompt, closeWorkflowTabNow, saveWorkflowWithName, workflowTabs]);
  const handleConfirmSave = useCallback(() => {
    const name = savePromptName.trim();
    if (!name) {
      showErrorPopup("이름을 입력하세요.", "저장하기");
      return;
    }
    saveWorkflowWithName(name);
  }, [savePromptName, saveWorkflowWithName, showErrorPopup]);
  const handleSaveWorkflow = useCallback(() => {
    const activeTab = workflowTabs.find((tab) => tab.id === activeWorkflowTabId);
    if (activeTab?.savedId) {
      saveWorkflowWithName(activeTab.name, activeTab.savedId);
      return;
    }
    const baseName = activeTab?.name ?? "워크플로우";
    const existingNames = new Set(savedWorkflows.map((item) => item.name));
    let candidate = baseName;
    let index = 1;
    while (existingNames.has(candidate)) {
      index += 1;
      candidate = `워크플로우 ${index}`;
    }
    setSavePromptName(candidate);
    setSavePromptOpen(true);
  }, [activeWorkflowTabId, saveWorkflowWithName, savedWorkflows, workflowTabs]);
  const handleLoadWorkflow = useCallback(
    (entry: SavedWorkflow) => {
      const existingTab = workflowTabs.find((tab) => tab.name === entry.name);
      if (existingTab) {
        handleSelectWorkflowTab(existingTab.id);
        setActiveTab("workflow");
        return;
      }
      const tabId = `tab-${Date.now()}`;
      const newTab: WorkflowTab = {
        id: tabId,
        name: entry.name,
        nodes: entry.state.nodes,
        edges: entry.state.edges,
        selectedNodeId: null,
        configNodeId: null,
        savedId: entry.id,
      };
      setWorkflowTabs((prev) => [...prev, newTab]);
      setActiveWorkflowTabId(tabId);
      setNodes(entry.state.nodes);
      setEdges(entry.state.edges);
      setSelectedNodeId(null);
      setConfigNodeId(null);
      setActiveTab("workflow");
      nodesRef.current = entry.state.nodes;
      edgesRef.current = entry.state.edges;
    },
    [handleSelectWorkflowTab, setEdges, setNodes, workflowTabs],
  );
  const handleDeleteWorkflow = useCallback(
    (entryId: string) => {
      const target = savedWorkflows.find((entry) => entry.id === entryId);
      if (!target) return;
      setDeletePrompt(target);
    },
    [savedWorkflows],
  );
  const handleConfirmDeleteWorkflow = useCallback(() => {
    if (!deletePrompt) return;
    const next = savedWorkflows.filter((entry) => entry.id !== deletePrompt.id);
    persistSavedWorkflows(next);
    if (editingWorkflowId === deletePrompt.id) {
      setEditingWorkflowId(null);
      setEditingWorkflowName("");
    }
    setDeletePrompt(null);
  }, [deletePrompt, editingWorkflowId, persistSavedWorkflows, savedWorkflows]);
  const handleOpenSchedule = useCallback((entry: SavedWorkflow) => {
    setSchedulePrompt({ id: entry.id, name: entry.name });
    setScheduleForm(
      entry.schedule ? { ...entry.schedule } : createDefaultSchedule(),
    );
  }, []);
  const syncSchedulesFromServer = useCallback(async () => {
    try {
      const response = await fetch("/api/schedules");
      const payload = (await response.json()) as {
        ok?: boolean;
        schedules?: Array<{
          id: string;
          schedule: WorkflowSchedule;
          lastRunAt?: string;
          lastStatus?: "success" | "failure" | "running";
          lastError?: string;
          history?: Array<{
            ranAt: string;
            status: "success" | "failure";
            error?: string;
          }>;
        }>;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "스케줄 목록을 불러오지 못했습니다.");
      }
      const map = new Map(
        (payload.schedules ?? []).map((item) => [item.id, item]),
      );
      updateSavedWorkflows((prev) =>
        prev.map((entry) => {
          const scheduleEntry = map.get(entry.id);
          if (!scheduleEntry) {
            return { ...entry, schedule: undefined };
          }
          return {
            ...entry,
            schedule: {
              ...scheduleEntry.schedule,
              lastRunAt: scheduleEntry.lastRunAt,
              lastStatus: scheduleEntry.lastStatus,
              lastError: scheduleEntry.lastError,
              history: scheduleEntry.history,
            },
          };
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "스케줄 목록을 불러오지 못했습니다.";
      showErrorPopup(message, "스케줄");
    }
  }, [showErrorPopup, updateSavedWorkflows]);
  const handleSaveSchedule = useCallback(async () => {
    if (!schedulePrompt) return;
    const sanitized: WorkflowSchedule = {
      ...scheduleForm,
      intervalMinutes: Math.max(1, Math.floor(scheduleForm.intervalMinutes || 1)),
      cron: scheduleForm.cron.trim() || "0 * * * *",
    };
    const target = savedWorkflows.find(
      (entry) => entry.id === schedulePrompt.id,
    );
    if (!target) {
      showErrorPopup("저장된 워크플로우를 찾지 못했습니다.", "스케줄");
      return;
    }
    const next = savedWorkflows.map((entry) =>
      entry.id === schedulePrompt.id ? { ...entry, schedule: sanitized } : entry,
    );
    persistSavedWorkflows(next);
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: target.id,
          name: target.name,
          workflow: target.state,
          schedule: sanitized,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "스케줄 저장에 실패했습니다.");
      }
      await syncSchedulesFromServer();
      setSuccessPopup({
        title: "스케줄 저장",
        message: "스케줄 설정이 저장되었습니다.",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "스케줄 저장에 실패했습니다.";
      showErrorPopup(message, "스케줄");
    } finally {
      setSchedulePrompt(null);
    }
  }, [
    persistSavedWorkflows,
    savedWorkflows,
    scheduleForm,
    schedulePrompt,
    showErrorPopup,
    syncSchedulesFromServer,
  ]);
  const handleClearSchedule = useCallback(async () => {
    if (!schedulePrompt) return;
    const next = savedWorkflows.map((entry) =>
      entry.id === schedulePrompt.id ? { ...entry, schedule: undefined } : entry,
    );
    persistSavedWorkflows(next);
    try {
      const response = await fetch(`/api/schedules?id=${schedulePrompt.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "스케줄 해제에 실패했습니다.");
      }
      await syncSchedulesFromServer();
      setSuccessPopup({
        title: "스케줄 해제",
        message: "스케줄이 제거되었습니다.",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "스케줄 해제에 실패했습니다.";
      showErrorPopup(message, "스케줄");
    } finally {
      setSchedulePrompt(null);
    }
  }, [
    persistSavedWorkflows,
    savedWorkflows,
    schedulePrompt,
    showErrorPopup,
    syncSchedulesFromServer,
  ]);
  const handleRenameWorkflow = useCallback(
    (entryId: string, name: string) => {
      const next = savedWorkflows.map((entry) =>
        entry.id === entryId
          ? { ...entry, name: name.trim() || entry.name }
          : entry,
      );
      persistSavedWorkflows(next);
    },
    [persistSavedWorkflows, savedWorkflows],
  );

  useEffect(() => {
    if (!deletePrompt && !successPopup) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDeletePrompt(null);
        setSuccessPopup(null);
      }
      if (event.key === "Enter") {
        if (deletePrompt) {
          handleConfirmDeleteWorkflow();
        } else if (successPopup) {
          setSuccessPopup(null);
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [deletePrompt, handleConfirmDeleteWorkflow, successPopup]);
  useEffect(() => {
    if (!savedWorkflowsLoaded) return;
    if (activeTab !== "saved") return;
    void syncSchedulesFromServer();
  }, [activeTab, savedWorkflowsLoaded, savedView, syncSchedulesFromServer]);
  const handleShowSavedList = useCallback(() => {
    setActiveTab("saved");
    setSavedView("list");
    savedListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const handleExportJson = useCallback((entry: SavedWorkflow) => {
    const payload: WorkflowState = entry.state;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-");
    anchor.href = url;
    anchor.download = `${entry.name}-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);
  const handleImportJson = useCallback((entryId?: string) => {
    setImportTargetId(entryId ? entryId : null);
    importInputRef.current?.click();
  }, []);
  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as WorkflowState;
        if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error("워크플로우 JSON 형식이 올바르지 않습니다.");
        }
        if (importTargetId != null) {
          const target = savedWorkflows.find((entry) => entry.id === importTargetId);
          if (!target) {
            throw new Error("저장된 워크플로우를 찾지 못했습니다.");
          }
          const updated: SavedWorkflow = {
            ...target,
            savedAt: new Date().toISOString(),
            state: { nodes: parsed.nodes, edges: parsed.edges },
          };
          const next = savedWorkflows.map((entry) =>
            entry.id === importTargetId ? updated : entry,
          );
          persistSavedWorkflows(next);
          setSuccessPopup({
            title: "가져오기 완료",
            message: `"${updated.name}"이(가) 업데이트되었습니다.`,
          });
        } else {
          const baseName = file.name.replace(/\.[^.]+$/, "") || "가져온 워크플로우";
          const tabId = `tab-${Date.now()}`;
          const newTab: WorkflowTab = {
            id: tabId,
            name: baseName,
            nodes: parsed.nodes,
            edges: parsed.edges,
            selectedNodeId: null,
            configNodeId: null,
          };
          setWorkflowTabs((prev) => [...prev, newTab]);
          setActiveWorkflowTabId(tabId);
          setNodes(parsed.nodes);
          setEdges(parsed.edges);
          setSelectedNodeId(null);
          setConfigNodeId(null);
          setActiveTab("workflow");
          nodesRef.current = parsed.nodes;
          edgesRef.current = parsed.edges;
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "JSON 파일을 불러오지 못했습니다.";
        showErrorPopup(message, "JSON 가져오기");
      } finally {
        setImportTargetId(null);
      }
    },
    [
      importTargetId,
      persistSavedWorkflows,
      savedWorkflows,
      showErrorPopup,
    ],
  );

  return (
    <WorkflowProvider
      value={{
        onRunNode: runNode,
          onSelectNode: handleSelectNode,
          onDeleteNode: handleDeleteNode,
          onOpenNodeMenu: (nodeId, position) => {
            setSelectedNodeId(nodeId);
            setNodeMenu({ nodeId, ...position });
          },
      }}
    >
      <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 via-slate-50 to-slate-100">
        <div className="flex min-h-screen w-full flex-col gap-4 px-6 py-6">
          <div className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                  Workflow Studio
                </p>
                <h1 className="mt-2 text-2xl font-semibold text-slate-900">
                  데이터 파이프라인 워크플로우
                </h1>
                <p className="mt-2 text-sm text-slate-600">
                  수집 → 특성값 → 품질 단계를 노드 기반으로 구성하고 자동
                  점검을 연결하세요.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/"
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                >
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    >
                      <path d="M3 10.5 12 3l9 7.5" />
                      <path d="M5.5 9.5V21h13V9.5" />
                    </svg>
                  </span>
                  홈
                </Link>
              </div>
            </div>
          </div>

          <Toolbar
            onRunAll={handleRunAll}
            onExport={handleSaveWorkflow}
            onImport={handleShowSavedList}
            onImportJson={() => handleImportJson()}
            onReset={handleReset}
            onResetRun={handleResetRun}
            running={runningAll}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveTab("workflow")}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "workflow"
                  ? "border-slate-300 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              워크플로우
            </button>
            <button
              onClick={() => setActiveTab("saved")}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "saved"
                  ? "border-slate-300 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              저장된 워크플로우
            </button>
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={handleImportFile}
          />
          {activeTab === "saved" ? (
            <div
              ref={savedListRef}
              className="rounded-3xl border border-slate-200 bg-white/90 px-4 py-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                    Saved Workflows
                  </p>
                  <p className="text-sm font-semibold text-slate-900">
                    저장된 워크플로우 목록
                  </p>
                </div>
                <span className="text-xs text-slate-400">
                  총 {savedWorkflows.length}개
                </span>
              </div>
              <div className="mt-3 flex justify-center">
                <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600">
                  <button
                    onClick={() => setSavedView("list")}
                    className={`rounded-full px-3 py-1 transition ${
                      savedView === "list"
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    목록
                  </button>
                  <button
                    onClick={() => setSavedView("history")}
                    className={`rounded-full px-3 py-1 transition ${
                      savedView === "history"
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    스케줄 이력
                  </button>
                </div>
              </div>
              {savedWorkflows.length === 0 ? (
                <p className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                  저장된 워크플로우가 없습니다. “저장하기”를 눌러 추가하세요.
                </p>
              ) : savedView === "list" ? (
                <div className="mt-3 space-y-2">
                  {savedWorkflows.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3"
                    >
                      <div>
                        {editingWorkflowId === entry.id ? (
                          <input
                            value={editingWorkflowName}
                            onChange={(event) =>
                              setEditingWorkflowName(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                handleRenameWorkflow(
                                  entry.id,
                                  editingWorkflowName,
                                );
                                setEditingWorkflowId(null);
                                setEditingWorkflowName("");
                              }
                              if (event.key === "Escape") {
                                setEditingWorkflowId(null);
                                setEditingWorkflowName("");
                              }
                            }}
                            className="w-full rounded-lg border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-800"
                          />
                        ) : (
                          <p className="text-sm font-semibold text-slate-800">
                            {entry.name}
                          </p>
                        )}
                        <p className="text-xs text-slate-400">
                          {new Date(entry.savedAt).toLocaleString()}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {formatScheduleSummary(entry.schedule)} ·{" "}
                          {formatScheduleLastRun(entry.schedule)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {editingWorkflowId === entry.id ? (
                          <>
                            <button
                              onClick={() => {
                                handleRenameWorkflow(
                                  entry.id,
                                  editingWorkflowName,
                                );
                                setEditingWorkflowId(null);
                                setEditingWorkflowName("");
                              }}
                              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                            >
                              저장
                            </button>
                            <button
                              onClick={() => {
                                setEditingWorkflowId(null);
                                setEditingWorkflowName("");
                              }}
                              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-50"
                            >
                              취소
                            </button>
                          </>
                        ) : null}
                        <button
                          onClick={() => handleLoadWorkflow(entry)}
                          className="rounded-full bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                        >
                          선택
                        </button>
                        {editingWorkflowId === entry.id ? null : (
                          <button
                            onClick={() => {
                              setEditingWorkflowId(entry.id);
                              setEditingWorkflowName(entry.name);
                            }}
                            className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            이름 변경
                          </button>
                        )}
                        <button
                          onClick={() => handleOpenSchedule(entry)}
                          className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                        >
                          스케줄
                        </button>
                        <button
                          onClick={() => handleExportJson(entry)}
                          className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                        >
                          JSON 내보내기
                        </button>
                        <button
                          onClick={() => handleDeleteWorkflow(entry.id)}
                          className="rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-100"
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  {savedWorkflows
                    .flatMap((entry) =>
                      (entry.schedule?.history ?? []).map((item) => ({
                        workflowId: entry.id,
                        name: entry.name,
                        ...item,
                      })),
                    )
                    .sort((a, b) => {
                      const aTime = new Date(a.ranAt).getTime();
                      const bTime = new Date(b.ranAt).getTime();
                      return bTime - aTime;
                    })
                    .slice(0, 30)
                    .map((item) => {
                      const date = new Date(item.ranAt);
                      const timeLabel = Number.isNaN(date.getTime())
                        ? item.ranAt
                        : date.toLocaleString();
                      return (
                        <div
                          key={`${item.workflowId}-${item.ranAt}-${item.status}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600"
                        >
                          <div className="font-semibold text-slate-700">
                            {item.name}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {timeLabel}
                          </div>
                          <div className="text-[11px]">
                            <span
                              className={
                                item.status === "success"
                                  ? "text-emerald-600"
                                  : "text-rose-500"
                              }
                            >
                              {item.status === "success" ? "성공" : "실패"}
                            </span>
                            {item.error ? (
                              <span className="ml-2 text-rose-500">
                                {item.error}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  {savedWorkflows.every(
                    (entry) => !(entry.schedule?.history ?? []).length,
                  ) ? (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                      실행 이력이 없습니다.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 shadow-sm">
                {workflowTabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      activeWorkflowTabId === tab.id
                        ? "border-slate-300 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <button
                      onClick={() => handleSelectWorkflowTab(tab.id)}
                      className="text-left"
                    >
                      {tab.name}
                    </button>
                    <button
                      onClick={() => handleCloseWorkflowTab(tab.id)}
                      className="ml-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-600"
                      aria-label="탭 닫기"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={handleAddWorkflowTab}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  + 새 탭
                </button>
              </div>
              <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
              <div className="min-w-0">
                <NodeSidebar
                  onAddNode={(type, kind) => {
                    if (type === "dataCollector" && kind) {
                      handleAddIngestionNode(kind as IngestionKind);
                    }
                    if (type === "dbSink") {
                      handleAddDbSinkNode();
                    }
                    if (type === "dataStorage" && kind) {
                      handleAddDataStorageNode(kind as StorageKind);
                    }
                  }}
                />
              </div>

              <div className="min-w-0">
                <WorkflowCanvas
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onEdgeUpdate={handleEdgeUpdate}
                  onDeleteEdge={handleDeleteEdge}
                  onSelectNode={handleSelectNode}
                  onNodeDoubleClick={(nodeId) => {
                    setSelectedNodeId(nodeId);
                    setConfigNodeId(nodeId);
                  }}
                  onDropNode={(type, position) => {
                    if (type.startsWith("dataCollector")) {
                      const [, rawKind] = type.split("|");
                      const kind = rawKind as IngestionKind | undefined;
                      if (kind) {
                        handleAddIngestionNode(kind, position);
                      }
                    }
                    if (type.startsWith("dataStorage")) {
                      const [, rawKind] = type.split("|");
                      const kind = rawKind as StorageKind | undefined;
                      if (kind) {
                        handleAddDataStorageNode(kind, position);
                      }
                    }
                    if (type === "dbSink") {
                      handleAddDbSinkNode(position);
                    }
                  }}
                  onPaneClick={() => {
                    handleSelectNode(null);
                    setConfigNodeId(null);
                  }}
                  onCanvasRef={(node) => {
                    canvasRef.current = node;
                  }}
                  selectedNode={selectedNode}
                  isOutputOpen={isOutputOpen}
                  onToggleOutput={() => setIsOutputOpen((prev) => !prev)}
                />
              </div>
            </div>
            </div>
          )}
        </div>
      </div>
      {schedulePrompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">스케줄 설정</p>
                <p className="mt-1 text-xs text-slate-500">
                  {schedulePrompt.name}
                </p>
              </div>
              <button
                onClick={() => setSchedulePrompt(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input
                  type="checkbox"
                  checked={scheduleForm.enabled}
                  onChange={(event) =>
                    setScheduleForm((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
                스케줄 활성화
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-slate-600">방식</span>
                <select
                  value={scheduleForm.mode}
                  onChange={(event) =>
                    setScheduleForm((prev) => ({
                      ...prev,
                      mode: event.target.value as WorkflowSchedule["mode"],
                    }))
                  }
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                >
                  <option value="interval">간격</option>
                  <option value="cron">크론</option>
                </select>
              </div>
              {scheduleForm.mode === "interval" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-600">간격</span>
                  <input
                    type="number"
                    min={1}
                    value={scheduleForm.intervalMinutes}
                    onChange={(event) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        intervalMinutes: Number(event.target.value),
                      }))
                    }
                    className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
                  />
                  <span className="text-xs text-slate-500">분마다 실행</span>
                </div>
              ) : (
                <div className="space-y-1">
                  <span className="text-xs font-semibold text-slate-600">
                    크론 표현식
                  </span>
                  <input
                    value={scheduleForm.cron}
                    onChange={(event) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        cron: event.target.value,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700"
                    placeholder="0 * * * *"
                  />
                </div>
              )}
              <p className="text-[11px] text-slate-400">
                예: 간격 60분, 크론 0 * * * *
              </p>
              {scheduleTarget?.schedule?.lastRunAt ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                  <p>{formatScheduleLastRun(scheduleTarget.schedule)}</p>
                  {scheduleTarget.schedule.lastError ? (
                    <p className="mt-1 text-rose-500">
                      {scheduleTarget.schedule.lastError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {scheduleTarget?.schedule?.history?.length ? (
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">
                      최근 실행 이력
                    </p>
                    <span className="text-[10px] text-slate-400">
                      최신 {Math.min(10, scheduleTarget.schedule.history.length)}건
                    </span>
                  </div>
                  <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                    {scheduleTarget.schedule.history.slice(0, 10).map((item) => {
                      const date = new Date(item.ranAt);
                      const timeLabel = Number.isNaN(date.getTime())
                        ? item.ranAt
                        : date.toLocaleString();
                      return (
                        <div
                          key={`${item.ranAt}-${item.status}`}
                          className="flex items-start justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1"
                        >
                          <div className="text-[11px] text-slate-700">
                            {timeLabel}
                          </div>
                          <div className="text-[10px]">
                            <span
                              className={
                                item.status === "success"
                                  ? "text-emerald-600"
                                  : "text-rose-500"
                              }
                            >
                              {item.status === "success" ? "성공" : "실패"}
                            </span>
                            {item.error ? (
                              <span className="ml-2 text-rose-500">
                                {item.error}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {scheduleTarget?.schedule ? (
                <button
                  onClick={handleClearSchedule}
                  className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-100"
                >
                  스케줄 해제
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setSchedulePrompt(null)}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  취소
                </button>
                <button
                  onClick={handleSaveSchedule}
                  className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  저장
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {savePromptOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">저장하기</p>
                <p className="mt-1 text-xs text-slate-500">
                  워크플로우 이름을 입력하세요.
                </p>
              </div>
              <button
                onClick={() => {
                  setSavePromptOpen(false);
                  setSavePromptName("");
                }}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <input
              value={savePromptName}
              onChange={(event) => setSavePromptName(event.target.value)}
              className="mt-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800"
              placeholder="워크플로우 이름"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setSavePromptOpen(false);
                  setSavePromptName("");
                }}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={handleConfirmSave}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {successPopup ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  {successPopup.title}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {successPopup.message}
                </p>
              </div>
              <button
                onClick={() => setSuccessPopup(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setSuccessPopup(null)}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {deletePrompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">삭제 확인</p>
                <p className="mt-1 text-xs text-slate-500">
                  "{deletePrompt.name}"을(를) 삭제할까요?
                </p>
              </div>
              <button
                onClick={() => setDeletePrompt(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeletePrompt(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={handleConfirmDeleteWorkflow}
                className="rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {closeTabPrompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">변경사항 안내</p>
                <p className="mt-1 text-xs text-slate-500">
                  "{closeTabPrompt.name}"을(를) 저장하지 않으면 변경사항이 반영되지
                  않습니다. 닫을까요?
                </p>
              </div>
              <button
                onClick={() => setCloseTabPrompt(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setCloseTabPrompt(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                onClick={handleConfirmCloseWorkflowTab}
                className="rounded-full border border-slate-200 bg-slate-900/10 px-4 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-900/15"
              >
                닫기
              </button>
              <button
                onClick={handleSaveAndCloseWorkflowTab}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                저장 후 닫기
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {nodeMenu && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setNodeMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setNodeMenu(null);
          }}
        >
          <div
            className="absolute z-50 w-40 rounded-2xl border border-slate-200 bg-white p-2 text-sm shadow-lg"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="w-full rounded-xl px-3 py-2 text-left text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              onClick={() => {
                setConfigNodeId(nodeMenu.nodeId);
                setNodeMenu(null);
              }}
            >
              설정
            </button>
            <button
              className="w-full rounded-xl px-3 py-2 text-left text-xs font-semibold text-rose-600 transition hover:bg-rose-50"
              onClick={() => {
                handleDeleteNode(nodeMenu.nodeId);
                setNodeMenu(null);
              }}
            >
              삭제
            </button>
          </div>
        </div>
      )}
      <NodeConfigModal
        node={configNode}
        connectedDbNode={connectedDbNode}
        connectedDbNodeForQuery={connectedDbNodeForQuery}
        connectedSourceNodeForDbSave={connectedSourceNodeForDbSave}
        connectedSourceNodeForFileSave={connectedSourceNodeForFileSave}
        sourceColumnsForDbSave={sourceColumnsForDbSaveMemo}
        onClose={() => setConfigNodeId(null)}
        onChangeConfig={handleChangeConfig}
        onRun={runNode}
        onUploadExcel={handleExcelUpload}
        onRemoveExcelFile={(nodeId) => {
          updateNodeData(nodeId, (prev) => ({
            ...prev,
            fileName: undefined,
            excelRowsBySheet: undefined,
            excelSheets: undefined,
            excelPreview: undefined,
            preview: "",
            error: undefined,
            status: "idle",
            lastRun: undefined,
          }));
        }}
        onChangeDbConfig={handleChangeDbConfig}
        onChangeExcelOptions={handleExcelOptionsChange}
        onChangeStorageOptions={handleChangeStorageOptions}
        onApplyAutoMapping={handleApplyAutoMapping}
        onResetMapping={handleResetMapping}
        onChangeFileSaveOptions={handleChangeFileSaveOptions}
        onFetchDbTables={handleFetchDbTablesAction}
        onFetchDbTablesBySchema={handleFetchDbTablesBySchema}
        onFetchDbSchemas={handleFetchDbSchemas}
        onFetchDbColumns={handleFetchDbColumns}
        onFetchDbQueryTables={handleFetchDbQueryTables}
        onFetchDbQuerySchemas={handleFetchDbQuerySchemas}
        onChangeDbQueryOptions={handleChangeDbQueryOptions}
      />
      {errorPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                  {errorPopup.title}
                </p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {errorPopup.message}
                </p>
              </div>
              <button
                onClick={() => setErrorPopup(null)}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>
            <div className="mt-4 text-right">
              <button
                onClick={() => setErrorPopup(null)}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </WorkflowProvider>
  );
}

export default function WorkflowPage() {
  return (
    <ReactFlowProvider>
      <WorkflowPageInner />
    </ReactFlowProvider>
  );
}
