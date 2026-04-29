'use client';

import { useEffect, useState } from "react";

import type { DataCollectorConfig, DataCollectorNode } from "../types";

interface NodeConfigModalProps {
  node?: DataCollectorNode;
  connectedDbNode?: DataCollectorNode | null;
  connectedSourceNodeForDbSave?: DataCollectorNode | null;
  connectedSourceNodeForFileSave?: DataCollectorNode | null;
  sourceColumnsForDbSave?: string[];
  connectedDbNodeForQuery?: DataCollectorNode | null;
  onClose: () => void;
  onChangeConfig: (nodeId: string, config: Partial<DataCollectorConfig>) => void;
  onRun: (nodeId: string) => void;
  onUploadExcel: (nodeId: string, file: File) => void;
  onRemoveExcelFile: (nodeId: string) => void;
  onChangeDbConfig: (
    nodeId: string,
    config: {
      url?: string;
      database?: string;
      user?: string;
      password?: string;
      dbType?: "postgres";
    },
  ) => void;
  onChangeStorageOptions: (
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
  ) => void;
  onApplyAutoMapping: (nodeId: string) => void;
  onResetMapping: (nodeId: string) => void;
  onChangeFileSaveOptions: (
    nodeId: string,
    options: {
      format?: "xls" | "json";
      jsonShape?: "array" | "object";
      fileName?: string;
      includeHeader?: boolean;
    },
  ) => void;
  onFetchDbTables: (nodeId: string, dbNodeId: string) => void;
  onFetchDbSchemas: (nodeId: string, dbNodeId: string) => void;
  onFetchDbColumns: (nodeId: string, dbNodeId: string, tableName: string) => void;
  onFetchDbQuerySchemas: (nodeId: string, dbNodeId: string) => void;
  onFetchDbQueryTables: (nodeId: string, dbNodeId: string) => void;
  onFetchDbTablesBySchema: (
    nodeId: string,
    dbNodeId: string,
    schema: string,
    groupId: number,
  ) => void;
  onChangeDbQueryOptions: (
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
  ) => void;
  onChangeExcelOptions: (
    nodeId: string,
    options: {
      sheetName?: string;
      startRow?: number;
      startCol?: number;
      hasHeader?: boolean;
    },
  ) => void;
}

type ApiParamGroup = {
  id: number;
  name: string | null;
};

type ApiSource = {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  groups: ApiParamGroup[];
};

const formatDate = (value?: string) => {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const parseXmlRows = (value: string) => {
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

const normalizeApiPayload = (payload: unknown) => {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const xmlRows = parseXmlRows(payload);
    if (xmlRows) return xmlRows;
    const trimmed = payload.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = parseJsonSafe(trimmed);
      if (parsed) return parsed;
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

const parseJsonSafe = (value?: string) => {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
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

const buildCustomEndpoint = (config: DataCollectorConfig) => {
  if (!config.endpoint) return "";
  const isRelative = config.endpoint.startsWith("/");
  const url = new URL(config.endpoint, isRelative ? window.location.origin : undefined);
  const params = new URLSearchParams(config.queryParams ?? "");
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
  if (config.apiKey && config.apiKeyParam) {
    params.set(config.apiKeyParam, normalizeQueryValue(config.apiKey));
  }
  for (const [key, value] of params.entries()) {
    if (value) url.searchParams.set(key, value);
  }
  return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
};

export function NodeConfigModal({
  node,
  connectedDbNode,
  connectedSourceNodeForDbSave,
  connectedSourceNodeForFileSave,
  sourceColumnsForDbSave,
  connectedDbNodeForQuery,
  onClose,
  onChangeConfig,
  onRun,
  onUploadExcel,
  onRemoveExcelFile,
  onChangeDbConfig,
  onChangeStorageOptions,
  onApplyAutoMapping,
  onResetMapping,
  onChangeFileSaveOptions,
  onFetchDbTables,
  onFetchDbSchemas,
  onFetchDbColumns,
  onFetchDbQuerySchemas,
  onFetchDbQueryTables,
  onFetchDbTablesBySchema,
  onChangeDbQueryOptions,
  onChangeExcelOptions,
}: NodeConfigModalProps) {
  const [apiListState, setApiListState] = useState<{
    status: "idle" | "loading" | "success" | "error";
    message: string;
    sources: ApiSource[];
  }>({ status: "idle", message: "", sources: [] });
  const [apiListRefreshKey, setApiListRefreshKey] = useState(0);
  const nodeKind = node?.data?.kind;
  const nodeStorageOptions = node?.data?.storageOptions;
  const isApiListMode = node?.data?.config?.apiListMode ?? false;
  const isApiKind = nodeKind === "api";

  useEffect(() => {
    const shouldFetch =
      (isApiListMode && isApiKind) ||
      (nodeKind === "dbSave" && (nodeStorageOptions?.apiListMode ?? false));
    if (!shouldFetch) return;
    let cancelled = false;
    const fetchList = async () => {
      setApiListState({ status: "loading", message: "", sources: [] });
      try {
        const response = await fetch("/api/ingestion/api-config");
        const payload = (await response.json()) as {
          ok?: boolean;
          sources?: ApiSource[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "목록을 불러오지 못했습니다.");
        }
        if (!cancelled) {
          setApiListState({
            status: "success",
            message: "",
            sources: payload.sources ?? [],
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "목록을 불러오지 못했습니다.";
        if (!cancelled) {
          setApiListState({ status: "error", message, sources: [] });
        }
      }
    };
    void fetchList();
    return () => {
      cancelled = true;
    };
  }, [
    apiListRefreshKey,
    isApiKind,
    isApiListMode,
    nodeKind,
    nodeStorageOptions?.apiListMode,
  ]);

  if (!node) return null;

  const {
    config,
    status,
    lastRun,
    error,
    preview,
    apiResult,
    fileName,
    kind,
    excelPreview,
    excelOptions,
    excelSheets,
    dbConfig,
    storageOptions,
    dbQueryOptions,
  } = node.data;
  const apiProvider = config.apiProvider ?? "custom";
  const providerEndpoint =
    apiProvider === "custom" ? config.endpoint : buildProviderEndpoint(config);
  const customResolvedEndpoint =
    apiProvider === "custom" ? buildCustomEndpoint(config) : "";
  const apiPeriod = config.apiPeriod ?? "M";
  const periodFormatHint =
    apiPeriod === "Q"
      ? "YYYYQn (예: 1980Q1)"
      : apiPeriod === "D"
        ? "YYYYMMDD (예: 20250101)"
        : apiPeriod === "A"
          ? "YYYY (예: 1960)"
          : "YYYYMM (예: 202501)";
  const kosisPeriodHint =
    (config.apiPrdSe ?? "Y") === "M"
      ? "YYYYMM (예: 202501)"
      : "YYYY (예: 1985)";


  const safeExcelOptions = {
    startRow: excelOptions?.startRow ?? 1,
    startCol: excelOptions?.startCol ?? 1,
    sheetName: excelOptions?.sheetName ?? "",
    hasHeader: excelOptions?.hasHeader ?? true,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
      <div className="w-full max-w-xl h-[80vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
              Node Settings
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-900">
              {node.data.label} 설정
            </h2>
            <p className="mt-1 text-xs text-slate-500">노드 ID: {node.id}</p>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            닫기
          </button>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {kind === "excel" ? (
            <div className="space-y-2 sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600">
                엑셀 파일 업로드
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800">
                  파일 선택
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        onUploadExcel(node.id, file);
                      }
                    }}
                  />
                </label>
                <span className="text-xs text-slate-500">
                  {fileName ? `선택됨: ${fileName}` : "업로드할 파일을 선택하세요."}
                </span>
                {fileName ? (
                  <button
                    type="button"
                    onClick={() => onRemoveExcelFile(node.id)}
                    className="cursor-pointer rounded-full border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                엑셀 파일(.xlsx, .xls) 또는 CSV를 업로드하면 상위 5행이
                미리보기로 표시됩니다.
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-xs text-slate-600">
                  데이터 시작 행
                  <input
                    type="number"
                    min={1}
                    value={safeExcelOptions.startRow}
                    onChange={(event) =>
                      onChangeExcelOptions(node.id, {
                        startRow: Number.parseInt(event.target.value, 10) || 1,
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  데이터 시작 열
                  <input
                    type="number"
                    min={1}
                    value={safeExcelOptions.startCol}
                    onChange={(event) =>
                      onChangeExcelOptions(node.id, {
                        startCol: Number.parseInt(event.target.value, 10) || 1,
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  시트 선택
                  <select
                    value={safeExcelOptions.sheetName}
                    onChange={(event) =>
                      onChangeExcelOptions(node.id, {
                        sheetName: event.target.value || undefined,
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                    disabled={!excelSheets?.length}
                  >
                    <option value="">
                      {excelSheets?.length ? "시트 선택" : "업로드 후 선택"}
                    </option>
                    {excelSheets?.map((sheet) => (
                      <option key={sheet} value={sheet}>
                        {sheet}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={safeExcelOptions.hasHeader}
                  onChange={(event) =>
                    onChangeExcelOptions(node.id, {
                      hasHeader: event.target.checked,
                    })
                  }
                />
                첫 행을 헤더로 인식
              </label>
            </div>
          ) : kind === "db" ? (
            <div className="space-y-3 sm:col-span-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                연결된 DB:{" "}
                <span className="font-semibold text-slate-800">
                  {connectedDbNodeForQuery?.data.label ?? "연결 없음"}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-600">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name={`db-query-mode-${node.id}`}
                    checked={(dbQueryOptions?.mode ?? "table") === "table"}
                    onChange={() =>
                      onChangeDbQueryOptions(node.id, { mode: "table" })
                    }
                  />
                  테이블 선택
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name={`db-query-mode-${node.id}`}
                    checked={(dbQueryOptions?.mode ?? "table") === "sql"}
                    onChange={() =>
                      onChangeDbQueryOptions(node.id, { mode: "sql" })
                    }
                  />
                  SQL 직접 입력
                </label>
              </div>
              {(dbQueryOptions?.mode ?? "table") === "table" ? (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex-1 space-y-1 text-xs text-slate-600">
                      스키마
                      <select
                        value={dbQueryOptions?.schema ?? "public"}
                        onChange={(event) =>
                          onChangeDbQueryOptions(node.id, {
                            schema: event.target.value,
                          })
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                        disabled={!dbQueryOptions?.schemas?.length}
                      >
                        <option value="">
                          {dbQueryOptions?.schemas?.length
                            ? "스키마 선택"
                            : "스키마 없음"}
                        </option>
                        {dbQueryOptions?.schemas?.map((schema) => (
                          <option key={schema} value={schema}>
                            {schema}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        if (connectedDbNodeForQuery) {
                          onFetchDbQuerySchemas(
                            node.id,
                            connectedDbNodeForQuery.id,
                          );
                        }
                      }}
                      className="cursor-pointer rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      disabled={
                        !connectedDbNodeForQuery || dbQueryOptions?.schemasLoading
                      }
                    >
                      스키마 불러오기
                    </button>
                    {dbQueryOptions?.schemasError ? (
                      <span className="text-xs text-rose-500">
                        {dbQueryOptions.schemasError}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex-1 space-y-1 text-xs text-slate-600">
                      조회할 테이블
                      <select
                        value={dbQueryOptions?.tableName ?? ""}
                        onChange={(event) =>
                          onChangeDbQueryOptions(node.id, {
                            tableName: event.target.value || "",
                          })
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                        disabled={!dbQueryOptions?.tables?.length}
                      >
                        <option value="">
                          {dbQueryOptions?.tables?.length
                            ? "테이블 선택"
                            : "테이블 없음"}
                        </option>
                        {dbQueryOptions?.tables?.map((table) => (
                          <option key={table} value={table}>
                            {table}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        if (connectedDbNodeForQuery) {
                          onFetchDbQueryTables(
                            node.id,
                            connectedDbNodeForQuery.id,
                          );
                        }
                      }}
                      className="cursor-pointer rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      disabled={
                        !connectedDbNodeForQuery || dbQueryOptions?.tablesLoading
                      }
                    >
                      테이블 불러오기
                    </button>
                    {dbQueryOptions?.tablesError ? (
                      <span className="text-xs text-rose-500">
                        {dbQueryOptions.tablesError}
                      </span>
                    ) : null}
                  </div>
                </>
              ) : (
                <label className="space-y-1 text-xs text-slate-600">
                  SQL (SELECT만 허용)
                  <textarea
                    value={dbQueryOptions?.sql ?? ""}
                    onChange={(event) =>
                      onChangeDbQueryOptions(node.id, {
                        sql: event.target.value,
                      })
                    }
                    className="h-28 w-full resize-none rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                    placeholder="select * from public.table limit 10"
                  />
                </label>
              )}
            </div>
          ) : kind === "dbSave" ? (
            <div className="space-y-3 sm:col-span-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                연결된 DB:{" "}
                <span className="font-semibold text-slate-800">
                  {connectedDbNode?.data.label ?? "연결 없음"}
                </span>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={storageOptions?.apiListMode ?? false}
                  onChange={(event) =>
                    onChangeStorageOptions(node.id, {
                      apiListMode: event.target.checked,
                    })
                  }
                />
                API 설정 목록 전체 실행
              </label>
              {storageOptions?.apiListMode ? (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-700">
                      API 그룹 ↔ TEMP 테이블 매핑
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (connectedDbNode) {
                          onFetchDbSchemas(node.id, connectedDbNode.id);
                        }
                      }}
                      className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      disabled={!connectedDbNode || storageOptions?.schemasLoading}
                    >
                      스키마 불러오기
                    </button>
                  </div>
                  {storageOptions?.schemasError ? (
                    <div className="text-[11px] text-rose-500">
                      {storageOptions.schemasError}
                    </div>
                  ) : null}
                  {apiListState.status === "loading" ? (
                    <p className="text-slate-500">목록을 불러오는 중...</p>
                  ) : apiListState.status === "error" ? (
                    <p className="text-rose-500">{apiListState.message}</p>
                  ) : apiListState.sources.length === 0 ? (
                    <p className="text-slate-500">등록된 API 설정이 없습니다.</p>
                  ) : (
                    <div className="space-y-2">
                      {apiListState.sources.map((source) =>
                        source.groups.map((group) => {
                          const groupKey = String(group.id);
                          const groupMapping =
                            storageOptions?.groupTableMappings?.[groupKey] ?? {};
                          const groupTables =
                            storageOptions?.groupTableOptions?.[groupKey];
                          return (
                            <div
                              key={group.id}
                              className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[1.2fr_0.8fr_0.8fr]"
                            >
                              <div>
                                <p className="text-xs font-semibold text-slate-700">
                                  {source.name}
                                </p>
                                <p className="text-[11px] text-slate-500">
                                  {group.name || "그룹"}
                                </p>
                              </div>
                              <label className="space-y-1 text-[11px] text-slate-600">
                                스키마
                                <select
                                  value={groupMapping.schema ?? ""}
                                  onChange={(event) => {
                                    const schema = event.target.value;
                                    onChangeStorageOptions(node.id, {
                                      groupTableMappings: {
                                        ...(storageOptions?.groupTableMappings ?? {}),
                                        [groupKey]: {
                                          ...groupMapping,
                                          schema,
                                          table: "",
                                        },
                                      },
                                    });
                                    if (connectedDbNode && schema) {
                                      onFetchDbTablesBySchema(
                                        node.id,
                                        connectedDbNode.id,
                                        schema,
                                        group.id,
                                      );
                                    }
                                  }}
                                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-[11px] text-slate-800"
                                  disabled={!storageOptions?.schemas?.length}
                                >
                                  <option value="">
                                    {storageOptions?.schemas?.length
                                      ? "스키마 선택"
                                      : "스키마 없음"}
                                  </option>
                                  {storageOptions?.schemas?.map((schema) => (
                                    <option key={schema} value={schema}>
                                      {schema}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="space-y-1 text-[11px] text-slate-600">
                                TEMP 테이블
                                <select
                                  value={groupMapping.table ?? ""}
                                  onChange={(event) => {
                                    const table = event.target.value;
                                    onChangeStorageOptions(node.id, {
                                      groupTableMappings: {
                                        ...(storageOptions?.groupTableMappings ?? {}),
                                        [groupKey]: {
                                          ...groupMapping,
                                          table,
                                        },
                                      },
                                    });
                                  }}
                                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-[11px] text-slate-800"
                                  disabled={!groupTables?.tables?.length}
                                >
                                  <option value="">
                                    {groupTables?.tables?.length
                                      ? "테이블 선택"
                                      : "테이블 없음"}
                                  </option>
                                  {groupTables?.tables?.map((table) => (
                                    <option key={table} value={table}>
                                      {table}
                                    </option>
                                  ))}
                                </select>
                                {groupTables?.error ? (
                                  <span className="text-[11px] text-rose-500">
                                    {groupTables.error}
                                  </span>
                                ) : null}
                              </label>
                            </div>
                          );
                        }),
                      )}
                    </div>
                  )}
                </div>
              ) : null}
              {!storageOptions?.apiListMode ? (
                <>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 space-y-1 text-xs text-slate-600">
                  스키마
                  <select
                    value={storageOptions?.schema ?? "public"}
                    onChange={(event) =>
                      onChangeStorageOptions(node.id, {
                        schema: event.target.value,
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                    disabled={!storageOptions?.schemas?.length}
                  >
                    <option value="">
                      {storageOptions?.schemas?.length
                        ? "스키마 선택"
                        : "스키마 없음"}
                    </option>
                    {storageOptions?.schemas?.map((schema) => (
                      <option key={schema} value={schema}>
                        {schema}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (connectedDbNode) {
                      onFetchDbSchemas(node.id, connectedDbNode.id);
                    }
                  }}
                  className="cursor-pointer rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  disabled={!connectedDbNode || storageOptions?.schemasLoading}
                >
                  스키마 불러오기
                </button>
                {storageOptions?.schemasError ? (
                  <span className="text-xs text-rose-500">
                    {storageOptions.schemasError}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 space-y-1 text-xs text-slate-600">
                  저장할 테이블
                  <select
                    value={storageOptions?.tableName ?? ""}
                    onChange={(event) => {
                      const tableName = event.target.value || "";
                      onChangeStorageOptions(node.id, {
                        tableName,
                        columns: [],
                        columnsError: undefined,
                        columnMappings: {},
                      });
                      if (connectedDbNode && tableName) {
                        onFetchDbColumns(node.id, connectedDbNode.id, tableName);
                      }
                    }}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                    disabled={!storageOptions?.tables?.length}
                  >
                    <option value="">
                      {storageOptions?.tables?.length
                        ? "테이블 선택"
                        : "테이블 없음"}
                    </option>
                    {storageOptions?.tables?.map((table) => (
                      <option key={table} value={table}>
                        {table}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (connectedDbNode) {
                      onFetchDbTables(node.id, connectedDbNode.id);
                    }
                  }}
                  className="cursor-pointer rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  disabled={!connectedDbNode || storageOptions?.tablesLoading}
                >
                  테이블 불러오기
                </button>
                {storageOptions?.tablesError ? (
                  <span className="text-xs text-rose-500">
                    {storageOptions.tablesError}
                  </span>
                ) : null}
              </div>
                </>
              ) : null}
              <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={storageOptions?.truncateBeforeInsert ?? false}
                  onChange={(event) =>
                    onChangeStorageOptions(node.id, {
                      truncateBeforeInsert: event.target.checked,
                    })
                  }
                />
                기존 데이터 비우기 (TRUNCATE)
              </label>
              {!storageOptions?.apiListMode ? (
                <>
                  {storageOptions?.columnsError ? (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
                      {storageOptions.columnsError}
                    </div>
                  ) : null}
                  {storageOptions?.columns?.length ? (
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-700">
                      컬럼 매핑
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onApplyAutoMapping(node.id)}
                        className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                        disabled={!sourceColumnsForDbSave?.length}
                      >
                        자동 매핑 적용
                      </button>
                      <button
                        type="button"
                        onClick={() => onResetMapping(node.id)}
                        className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-500 transition hover:bg-slate-50"
                      >
                        초기화
                      </button>
                    </div>
                  <span className="text-[10px] text-slate-400">
                    입력: {connectedSourceNodeForDbSave?.data.label ?? "연결 없음"}
                  </span>
                  </div>
                {!sourceColumnsForDbSave?.length ? (
                    <div className="mt-2 rounded-lg bg-slate-50 px-2 py-2 text-[11px] text-slate-500">
                    입력 노드를 실행한 뒤 컬럼 매핑이 가능합니다.
                    </div>
                  ) : (
                    <div className="mt-2 max-h-40 space-y-2 overflow-auto">
                      {storageOptions.columns.map((column) => (
                        <div
                          key={column.name}
                          className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1"
                        >
                          <div className="flex flex-col">
                            <span className="text-slate-800">
                              {column.name}
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {column.dataType}
                            </span>
                          </div>
                          <select
                            value={
                              storageOptions?.columnMappings?.[column.name] ??
                              ""
                            }
                            onChange={(event) =>
                              onChangeStorageOptions(node.id, {
                                columnMappings: {
                                  ...(storageOptions?.columnMappings ?? {}),
                                  [column.name]: event.target.value,
                                },
                              })
                            }
                            className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-700"
                          >
                            <option value="">입력 컬럼 선택</option>
                            {sourceColumnsForDbSave.map((columnName) => (
                              <option key={columnName} value={columnName}>
                                {columnName}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : kind === "fileSave" ? (
            <div className="space-y-3 sm:col-span-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                연결된 입력:{" "}
                <span className="font-semibold text-slate-800">
                  {connectedSourceNodeForFileSave?.data.label ?? "연결 없음"}
                </span>
              </div>
              <label className="space-y-1 text-xs text-slate-600">
                저장 형식
                <select
                  value={node.data.fileSaveOptions?.format ?? "xls"}
                  onChange={(event) =>
                    onChangeFileSaveOptions(node.id, {
                      format: event.target.value as "xls" | "json",
                    })
                  }
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                >
                  <option value="xls">XLS</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              {node.data.fileSaveOptions?.format === "json" ? (
                <label className="space-y-1 text-xs text-slate-600">
                  JSON 형태
                  <select
                    value={node.data.fileSaveOptions?.jsonShape ?? "array"}
                    onChange={(event) =>
                      onChangeFileSaveOptions(node.id, {
                        jsonShape: event.target.value as "array" | "object",
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                  >
                    <option value="array">배열</option>
                    <option value="object">객체 (rows 포함)</option>
                  </select>
                </label>
              ) : null}
              <label className="space-y-1 text-xs text-slate-600">
                파일 이름
                <input
                  value={node.data.fileSaveOptions?.fileName ?? ""}
                  onChange={(event) =>
                    onChangeFileSaveOptions(node.id, {
                      fileName: event.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-800"
                  placeholder="data"
                />
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={node.data.fileSaveOptions?.includeHeader ?? true}
                  onChange={(event) =>
                    onChangeFileSaveOptions(node.id, {
                      includeHeader: event.target.checked,
                    })
                  }
                />
                첫 행을 헤더로 포함
              </label>
              <p className="text-xs text-slate-500">
                실행 시 선택한 형식으로 다운로드됩니다.
              </p>
            </div>
          ) : kind === "dbSink" ? (
            <>
              <label className="space-y-1 text-sm text-slate-800">
                <span className="text-xs text-slate-600">DB 종류</span>
                <select
                  value={dbConfig?.dbType ?? "postgres"}
                  onChange={(e) =>
                    onChangeDbConfig(node.id, {
                      dbType: e.target.value as "postgres",
                    })
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                >
                  <option value="postgres">Postgres</option>
                </select>
              </label>
              <label className="space-y-1 text-sm text-slate-800 sm:col-span-2">
                <span className="text-xs text-slate-600">DB 접속 URL</span>
                <input
                  value={dbConfig?.url ?? ""}
                  onChange={(e) =>
                    onChangeDbConfig(node.id, { url: e.target.value })
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                  placeholder="postgres://host:5432"
                />
              </label>
              <label className="space-y-1 text-sm text-slate-800">
                <span className="text-xs text-slate-600">DB 이름</span>
                <input
                  value={dbConfig?.database ?? ""}
                  onChange={(e) =>
                    onChangeDbConfig(node.id, { database: e.target.value })
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                  placeholder="database"
                />
              </label>
              <label className="space-y-1 text-sm text-slate-800">
                <span className="text-xs text-slate-600">User</span>
                <input
                  value={dbConfig?.user ?? ""}
                  onChange={(e) =>
                    onChangeDbConfig(node.id, { user: e.target.value })
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                  placeholder="user"
                />
              </label>
              <label className="space-y-1 text-sm text-slate-800 sm:col-span-2">
                <span className="text-xs text-slate-600">Password</span>
                <input
                  type="password"
                  value={dbConfig?.password ?? ""}
                  onChange={(e) =>
                    onChangeDbConfig(node.id, { password: e.target.value })
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                  placeholder="password"
                />
              </label>
              <p className="text-xs text-slate-500 sm:col-span-2">
                TODO: 실제 DB 설정/연결 테스트는 서버 연동으로 구현합니다.
              </p>
            </>
          ) : (
            <>
              {node.data.kind === "api" ? (
                <>
                  <label className="flex items-center gap-2 text-sm text-slate-800 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={config.apiListMode ?? false}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiListMode: e.target.checked })
                      }
                    />
                    <span className="text-xs text-slate-600">
                      목록 실행
                    </span>
                  </label>
                  {config.apiListMode ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 sm:col-span-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-700">
                          실행 대상 목록
                        </span>
                        <button
                          onClick={() => setApiListRefreshKey((prev) => prev + 1)}
                          className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          새로고침
                        </button>
                      </div>
                      {apiListState.status === "loading" ? (
                        <p className="mt-2 text-slate-500">불러오는 중...</p>
                      ) : apiListState.status === "error" ? (
                        <p className="mt-2 text-rose-500">
                          {apiListState.message}
                        </p>
                      ) : apiListState.sources.length === 0 ? (
                        <p className="mt-2 text-slate-500">
                          등록된 API 설정이 없습니다.
                        </p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {apiListState.sources.map((source) => (
                            <div
                              key={source.id}
                              className="rounded-xl border border-slate-200 bg-white p-3"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold text-slate-800">
                                    {source.name}
                                  </p>
                                  <p className="text-[11px] text-slate-500">
                                    {source.base_url}
                                  </p>
                                </div>
                                <span className="text-[11px] text-slate-400">
                                  {source.provider}
                                </span>
                              </div>
                              {source.groups.length > 0 ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {source.groups.map((group) => (
                                    <span
                                      key={group.id}
                                      className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                                    >
                                      {group.name || "그룹"}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <p className="mt-2 text-[11px] text-slate-400">
                                  그룹 없음
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                  {config.apiListMode ? null : (
                    <label className="space-y-1 text-sm text-slate-800 sm:col-span-2">
                      <span className="text-xs text-slate-600">기관 선택</span>
                  <select
                    value={apiProvider ?? ""}
                    onChange={(e) => {
                      const nextProvider =
                        e.target.value as DataCollectorConfig["apiProvider"] | "";
                      if (!nextProvider) {
                        onChangeConfig(node.id, { apiProvider: undefined });
                        return;
                      }
                      const prevProvider = apiProvider;
                      const providerKeyMap = {
                        bok: "bok",
                        kosis: "kosis",
                        dataGoKr: "dataGoKr",
                      } as const;
                      const prevKey =
                        prevProvider &&
                        prevProvider !== "custom" &&
                        providerKeyMap[prevProvider]
                          ? providerKeyMap[prevProvider]
                          : null;
                      const nextKey =
                        nextProvider &&
                        nextProvider !== "custom" &&
                        providerKeyMap[nextProvider]
                          ? providerKeyMap[nextProvider]
                          : null;
                      const providerConfigs = { ...(config.apiProviderConfigs ?? {}) };
                      if (prevKey) {
                        providerConfigs[prevKey] = {
                          apiKey: config.apiKey ?? "",
                          apiFormat: config.apiFormat,
                          apiLang: config.apiLang,
                          apiStatCode: config.apiStatCode,
                          apiPeriod: config.apiPeriod,
                          apiStart: config.apiStart,
                          apiEnd: config.apiEnd,
                          apiUserStatsId: config.apiUserStatsId,
                          apiPrdSe: config.apiPrdSe,
                          apiStartPrdDe: config.apiStartPrdDe,
                          apiEndPrdDe: config.apiEndPrdDe,
                          apiStrtYymm: config.apiStrtYymm,
                          apiEndYymm: config.apiEndYymm,
                          apiOrgCode: config.apiOrgCode,
                          apiName: config.apiName,
                          apiFunctionName: config.apiFunctionName,
                        };
                      }
                      const nextStoredConfig =
                        nextKey && providerConfigs[nextKey]
                          ? providerConfigs[nextKey]
                          : undefined;
                      if (nextProvider === "bok") {
                        onChangeConfig(node.id, {
                          apiProvider: nextProvider,
                          apiProviderConfigs: providerConfigs,
                          apiKey: nextStoredConfig?.apiKey ?? "",
                          apiFormat: nextStoredConfig?.apiFormat ?? "json",
                          apiLang: nextStoredConfig?.apiLang ?? "kr",
                          apiStatCode: nextStoredConfig?.apiStatCode ?? "",
                          apiPeriod: nextStoredConfig?.apiPeriod ?? "M",
                          apiStart: nextStoredConfig?.apiStart ?? "",
                          apiEnd: nextStoredConfig?.apiEnd ?? "",
                        });
                        return;
                      }
                      if (nextProvider === "kosis") {
                        onChangeConfig(node.id, {
                          apiProvider: nextProvider,
                          apiProviderConfigs: providerConfigs,
                          apiKey: nextStoredConfig?.apiKey ?? "",
                          apiUserStatsId: nextStoredConfig?.apiUserStatsId ?? "",
                          apiPrdSe: nextStoredConfig?.apiPrdSe ?? "Y",
                          apiStartPrdDe: nextStoredConfig?.apiStartPrdDe ?? "",
                          apiEndPrdDe: nextStoredConfig?.apiEndPrdDe ?? "",
                        });
                        return;
                      }
                      if (nextProvider === "dataGoKr") {
                        onChangeConfig(node.id, {
                          apiProvider: nextProvider,
                          apiProviderConfigs: providerConfigs,
                          apiKey: nextStoredConfig?.apiKey ?? "",
                          apiStrtYymm: nextStoredConfig?.apiStrtYymm ?? "",
                          apiEndYymm: nextStoredConfig?.apiEndYymm ?? "",
                          apiOrgCode: nextStoredConfig?.apiOrgCode ?? "",
                          apiName: nextStoredConfig?.apiName ?? "",
                          apiFunctionName: nextStoredConfig?.apiFunctionName ?? "",
                        });
                        return;
                      }
                      onChangeConfig(node.id, {
                        apiProvider: nextProvider,
                        apiProviderConfigs: providerConfigs,
                        apiKey: "",
                      });
                    }}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                  >
                    <option value="custom">직접 입력</option>
                    <option value="bok">한국은행</option>
                    <option value="kosis">통계청</option>
                    <option value="dataGoKr">공공데이터포탈</option>
                  </select>
                    </label>
                  )}
                </>
              ) : null}
              {!config.apiListMode ? (
                <>
                  <label className="space-y-1 text-sm text-slate-800 sm:col-span-2">
                    <span className="text-xs text-slate-600">Endpoint URL</span>
                    <input
                      value={providerEndpoint}
                      readOnly={node.data.kind === "api" && apiProvider !== "custom"}
                      onChange={(e) =>
                        onChangeConfig(node.id, { endpoint: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 disabled:bg-slate-50"
                      placeholder="https://example.com/api"
                    />
                  </label>

                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">Method</span>
                    <select
                      value={config.method}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          method: e.target.value as DataCollectorConfig["method"],
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                    >
                      <option value="GET">GET</option>
                    </select>
                  </label>

                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">Timeout (ms)</span>
                    <input
                      type="number"
                      min={0}
                      value={config.timeout}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          timeout: Number.parseInt(e.target.value, 10) || 0,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="5000"
                    />
                  </label>
                </>
              ) : null}
              {!config.apiListMode && node.data.kind === "api" && apiProvider === "custom" ? (
                <>
                  <label className="space-y-1 text-sm text-slate-800 sm:col-span-2">
                    <span className="text-xs text-slate-600">Query Params</span>
                    <input
                      value={config.queryParams ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { queryParams: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="key=value&key2=value2"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">API Key Param</span>
                    <input
                      value={config.apiKeyParam ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiKeyParam: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="serviceKey"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">API Key</span>
                    <input
                      value={config.apiKey ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiKey: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="발급받은 키 입력"
                    />
                  </label>
                  <p className="text-xs text-slate-500 sm:col-span-2">
                    직접 입력 URL에 필요한 파라미터를 구성하세요.
                  </p>
                  {customResolvedEndpoint ? (
                    <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                      <span className="block text-[10px] font-semibold text-slate-500">
                        최종 URL
                      </span>
                      <span className="break-all">{customResolvedEndpoint}</span>
                    </div>
                  ) : null}
                </>
              ) : null}
              {!config.apiListMode && node.data.kind === "api" && apiProvider === "bok" ? (
                <>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">API Key</span>
                    <input
                      value={config.apiKey ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiKey: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="발급받은 키 입력"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">Format</span>
                    <select
                      value={config.apiFormat ?? "json"}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiFormat: e.target.value as "json" | "xml",
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                    >
                      <option value="json">json</option>
                      <option value="xml">xml</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">STAT_CODE</span>
                    <input
                      value={config.apiStatCode ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiStatCode: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="예: 513Y001"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">기간 구분</span>
                    <select
                      value={apiPeriod}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiPeriod: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                    >
                      <option value="D">일</option>
                      <option value="M">월</option>
                      <option value="Q">분기</option>
                      <option value="A">연</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">시작</span>
                    <input
                      value={config.apiStart ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiStart: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder={periodFormatHint}
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">종료</span>
                    <input
                      value={config.apiEnd ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiEnd: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder={periodFormatHint}
                    />
                  </label>
                  <p className="text-xs text-slate-500 sm:col-span-2">
                    기간 형식: {periodFormatHint}
                  </p>
                </>
              ) : null}
              {!config.apiListMode && node.data.kind === "api" && apiProvider === "kosis" ? (
                <>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">API Key</span>
                    <input
                      value={config.apiKey ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiKey: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="발급받은 키 입력"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">format</span>
                    <select
                      value={config.apiFormat ?? "json"}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiFormat: e.target.value as "json",
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                    >
                      <option value="json">json</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm text-slate-800 sm:col-span-2">
                    <span className="text-xs text-slate-600">
                      userStatsId(사용자 등록 통계표)
                    </span>
                    <input
                      value={config.apiUserStatsId ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiUserStatsId: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="openapisample/101/DT_1BPA001/2/1/20230531134034"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">
                      prdSe(기간 구분)
                    </span>
                    <select
                      value={config.apiPrdSe ?? "Y"}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiPrdSe: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                    >
                      <option value="Y">연</option>
                      <option value="M">월</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">
                      startPrdDe(시작)
                    </span>
                    <input
                      value={config.apiStartPrdDe ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiStartPrdDe: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder={
                        (config.apiPrdSe ?? "Y") === "M"
                          ? "YYYYMM (예: 202501)"
                          : "YYYY (예: 1985)"
                      }
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">
                      endPrdDe(종료)
                    </span>
                    <input
                      value={config.apiEndPrdDe ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiEndPrdDe: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder={
                        (config.apiPrdSe ?? "Y") === "M"
                          ? "YYYYMM (예: 202512)"
                          : "YYYY (예: 2030)"
                      }
                    />
                  </label>
                  <p className="text-xs text-slate-500 sm:col-span-2">
                    기간 형식: {kosisPeriodHint}
                  </p>
                </>
              ) : null}
              {!config.apiListMode && node.data.kind === "api" && apiProvider === "dataGoKr" ? (
                <>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">기관코드</span>
                    <input
                      value={config.apiOrgCode ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiOrgCode: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="예: 1220000"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">API명</span>
                    <input
                      value={config.apiName ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiName: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="예: Newtrade"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">상세 기능명</span>
                    <input
                      value={config.apiFunctionName ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiFunctionName: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="예: getNewtradeList"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">API Key</span>
                    <input
                      value={config.apiKey ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, { apiKey: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="발급받은 키 입력"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">시작</span>
                    <input
                      value={config.apiStrtYymm ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiStrtYymm: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="202507"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-800">
                    <span className="text-xs text-slate-600">종료</span>
                    <input
                      value={config.apiEndYymm ?? ""}
                      onChange={(e) =>
                        onChangeConfig(node.id, {
                          apiEndYymm: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                      placeholder="202601"
                    />
                  </label>
                </>
              ) : null}
            </>
          )}
        </div>

        <div className="mt-4 rounded-2xl bg-slate-50 p-4 text-xs text-slate-600">
          <div className="flex justify-between">
            <span className="font-medium text-slate-700">상태</span>
            <span>{status}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="font-medium text-slate-700">마지막 실행</span>
            <span>{formatDate(lastRun)}</span>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-700">
          {error ? (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">
              {error}
            </div>
          ) : kind === "excel" ? (
            <div className="space-y-2">
              <div className="text-xs text-slate-500">
                {excelPreview?.sheet
                  ? `시트: ${excelPreview.sheet}`
                  : "미리보기 없음"}
              </div>
              <div className="max-h-56 overflow-auto rounded-lg border border-slate-200">
                {excelPreview?.rows?.length ? (
                  <table className="w-full border-collapse text-[11px]">
                    {excelPreview.header ? (
                      <thead className="bg-slate-100 text-slate-700">
                        <tr>
                          {excelPreview.header.map((cell, cellIndex) => (
                            <th
                              key={`header-${cellIndex}`}
                              className="whitespace-nowrap border border-slate-200 px-2 py-1 text-left font-semibold"
                            >
                              {cell ?? ""}
                            </th>
                          ))}
                        </tr>
                      </thead>
                    ) : null}
                    <tbody>
                      {excelPreview.rows.map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`} className="bg-white">
                          {row.map((cell, cellIndex) => (
                            <td
                              key={`cell-${rowIndex}-${cellIndex}`}
                              className="whitespace-nowrap border border-slate-200 px-2 py-1"
                            >
                              {cell ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="px-3 py-3 text-slate-400">
                    업로드한 엑셀 데이터가 없습니다.
                  </div>
                )}
              </div>
            </div>
          ) : kind === "db" ? (
            (() => {
              const dbRows = node.data.dbQueryRows ?? [];
              const dbKeys = dbRows.length ? Object.keys(dbRows[0]) : [];
              return (
                <div className="space-y-2">
                  <div className="text-xs text-slate-500">
                    {dbRows.length
                      ? `조회 결과 ${dbRows.length}건`
                      : "조회 결과 없음"}
                  </div>
                  <div className="max-h-56 overflow-auto rounded-lg border border-slate-200">
                    {dbRows.length ? (
                      <table className="w-full border-collapse text-[11px]">
                        <thead className="bg-slate-100 text-slate-700">
                          <tr>
                            {dbKeys.map((key) => (
                              <th
                                key={key}
                                className="whitespace-nowrap border border-slate-200 px-2 py-1 text-left font-semibold"
                              >
                                {key}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {dbRows.map((row, rowIndex) => (
                            <tr key={`row-${rowIndex}`} className="bg-white">
                              {dbKeys.map((key) => (
                                <td
                                  key={`${rowIndex}-${key}`}
                                  className="whitespace-nowrap border border-slate-200 px-2 py-1"
                                >
                                  {row[key] == null ? "" : String(row[key])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="px-3 py-3 text-slate-400">
                        조회된 데이터가 없습니다.
                      </div>
                    )}
                  </div>
                </div>
              );
            })()
          ) : kind === "api" ? (
            (() => {
              const table = buildTabularFromApi(
                apiResult ?? parseJsonSafe(preview),
              );
              if (table.header.length === 0 || table.dataRows.length === 0) {
                return (
                  <div className="max-h-40 overflow-auto rounded-lg bg-slate-50 px-3 py-2">
                    {preview ? (
                      <pre className="whitespace-pre-wrap text-[11px] leading-4">
                        {preview}
                      </pre>
                    ) : (
                      <span className="text-slate-400">응답 미리보기 없음</span>
                    )}
                  </div>
                );
              }
              return (
                <div className="max-h-56 overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="bg-slate-100 text-slate-700">
                      <tr>
                        {table.header.map((key) => (
                          <th
                            key={`api-header-${key}`}
                            className="whitespace-nowrap border border-slate-200 px-2 py-1 text-left font-semibold"
                          >
                            {key}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.dataRows.map((row, rowIndex) => (
                        <tr key={`api-row-${rowIndex}`} className="bg-white">
                          {row.map((cell, cellIndex) => (
                            <td
                              key={`api-cell-${rowIndex}-${cellIndex}`}
                              className="whitespace-nowrap border border-slate-200 px-2 py-1"
                            >
                              {cell == null ? "" : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()
          ) : (
            <div className="max-h-40 overflow-auto rounded-lg bg-slate-50 px-3 py-2">
              {preview ? (
                <pre className="whitespace-pre-wrap text-[11px] leading-4">
                  {preview}
                </pre>
              ) : (
                <span className="text-slate-400">응답 미리보기 없음</span>
              )}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between">
          <p className="text-xs text-slate-500">
            더블 클릭으로 언제든 설정을 수정할 수 있어요.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onRun(node.id)}
              className="cursor-pointer rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              disabled={status === "running"}
            >
              {status === "running" ? "실행 중..." : "이 노드 실행"}
            </button>
            <button
              onClick={onClose}
              className="cursor-pointer rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              확인
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

