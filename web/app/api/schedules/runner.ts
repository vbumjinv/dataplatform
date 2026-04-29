import { Client } from "pg";
import { promises as fs } from "fs";
import path from "path";
import * as XLSX from "xlsx";
import type { Edge } from "reactflow";
import type {
  DataCollectorNode,
  DataCollectorConfig,
  WorkflowState,
} from "@/app/workflow/types";
import { getSchedule } from "./storage";

type TabularData = {
  header: string[];
  dataRows: unknown[][];
};

type NodeRunResult = {
  ok: boolean;
  error?: string;
  tabular?: TabularData;
  apiResult?: unknown;
  dbRows?: Array<Record<string, unknown>>;
  dbColumns?: Array<{ name: string; dataType: string }>;
};

const CONNECT_TIMEOUT_MS = 5000;
const MAX_ROWS = 1000;
const MAX_EXCEL_ROWS = 200;
const MAX_EXCEL_COLS = 50;
const EXPORT_DIR = path.join(process.cwd(), "data", "schedules", "exports");

const normalizeJdbcUrl = (raw: string) => {
  if (raw.startsWith("jdbc:")) return raw.replace(/^jdbc:/, "");
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

const normalizeApiPayload = (payload: unknown) => {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return payload;
      }
    }
    return payload;
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record.ok && record.data != null) return record.data;
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

const buildTabularFromApi = (payload: unknown): TabularData => {
  const normalized = normalizeApiPayload(payload);
  if (normalized == null) return { header: [], dataRows: [] };
  const rows = Array.isArray(normalized) ? normalized : [normalized];
  if (!rows.length) return { header: [], dataRows: [] };
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

const buildExcelTabular = (
  rows: Array<Array<string | number | boolean | null>>,
  options: { startRow: number; startCol: number; hasHeader: boolean },
): TabularData => {
  const startRow = Math.max(1, options.startRow || 1);
  const startCol = Math.max(1, options.startCol || 1);
  const slicedRows = rows
    .slice(startRow - 1, startRow - 1 + MAX_EXCEL_ROWS)
    .map((row) => row.slice(startCol - 1, startCol - 1 + MAX_EXCEL_COLS));
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
    if (config.apiKey) {
      url.searchParams.set("serviceKey", config.apiKey);
    }
    const startParam = config.apiStartParamName ?? "strtYymm";
    if (config.apiStrtYymm) {
      url.searchParams.set(startParam, config.apiStrtYymm);
    }
    const endParam = config.apiEndParamName ?? "endYymm";
    if (config.apiEndYymm) {
      url.searchParams.set(endParam, config.apiEndYymm);
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
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    "http://localhost:3000";
  const isRelative = endpoint.startsWith("/");
  const url = new URL(endpoint, isRelative ? baseUrl : undefined);
  const params = new URLSearchParams(config.queryParams ?? "");
  if (config.apiKey && config.apiKeyParam) {
    params.set(config.apiKeyParam, config.apiKey);
  }
  for (const [key, value] of params.entries()) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
};

const fetchApiData = async (config: DataCollectorConfig) => {
  const endpoint = buildApiEndpoint(config.endpoint, config);
  if (!endpoint) throw new Error("API endpoint가 비어 있습니다.");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout || 8000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const message =
        typeof data === "string"
          ? data
          : (data as { error?: string }).error ?? "API 요청 실패";
      throw new Error(message);
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
};

const queryDb = async (
  dbConfig: NonNullable<DataCollectorNode["data"]["dbConfig"]>,
  options: { schema?: string; table?: string; sql?: string },
) => {
  const connectionString = buildConnectionString(dbConfig);
  if (!connectionString) throw new Error("DB 접속 URL 형식이 올바르지 않습니다.");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    const schema = options.schema?.trim() || "public";
    let rows: Array<Record<string, unknown>>;
    let columns: Array<{ name: string; dataType: string }> | undefined;
    if (options.sql?.trim()) {
      const rawSql = options.sql.trim();
      if (!rawSql.toLowerCase().startsWith("select")) {
        throw new Error("SELECT 쿼리만 실행할 수 있습니다.");
      }
      if (rawSql.includes(";")) {
        throw new Error("단일 SELECT 쿼리만 허용됩니다.");
      }
      const limitedSql = /limit\s+\d+$/i.test(rawSql)
        ? rawSql
        : `${rawSql} limit ${MAX_ROWS}`;
      const result = await client.query(limitedSql);
      rows = result.rows;
    } else {
      if (!options.table) throw new Error("테이블을 선택하세요.");
      const escapedTable = `${escapeIdentifier(schema)}.${escapeIdentifier(
        options.table,
      )}`;
      const result = await client.query(
        `select * from ${escapedTable} limit ${MAX_ROWS}`,
      );
      rows = result.rows;
      const meta = await client.query(
        `
          select column_name, data_type
          from information_schema.columns
          where table_schema = $1
            and table_name = $2
          order by ordinal_position
        `,
        [schema, options.table],
      );
      columns = meta.rows.map((row) => ({
        name: row.column_name as string,
        dataType: row.data_type as string,
      }));
    }
    return { rows, columns };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};

const insertDbRows = async (
  dbConfig: NonNullable<DataCollectorNode["data"]["dbConfig"]>,
  options: {
    schema?: string;
    table: string;
    columns: string[];
    rows: Array<Array<unknown>>;
    truncate?: boolean;
  },
) => {
  const connectionString = buildConnectionString(dbConfig);
  if (!connectionString) throw new Error("DB 접속 URL 형식이 올바르지 않습니다.");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    const schema = options.schema?.trim() || "public";
    const escapedTable = `${escapeIdentifier(schema)}.${escapeIdentifier(
      options.table,
    )}`;
    if (options.truncate) {
      await client.query(`truncate table ${escapedTable}`);
    }
    const columns = options.columns.filter(Boolean);
    const rows = options.rows.slice(0, MAX_ROWS);
    if (!columns.length || !rows.length) {
      throw new Error("저장할 데이터가 없습니다.");
    }
    const escapedColumns = columns.map(escapeIdentifier).join(", ");
    const values: unknown[] = [];
    const placeholders = rows
      .map((row, rowIndex) => {
        const base = rowIndex * columns.length;
        const rowPlaceholders = columns.map((_, colIndex) => {
          values.push(row[colIndex] ?? null);
          return `$${base + colIndex + 1}`;
        });
        return `(${rowPlaceholders.join(", ")})`;
      })
      .join(", ");
    const query = `insert into ${escapedTable} (${escapedColumns}) values ${placeholders}`;
    await client.query(query, values);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};

const ensureExportDir = async () => {
  await fs.mkdir(EXPORT_DIR, { recursive: true });
};

const writeExportJson = async (fileName: string, payload: unknown) => {
  await ensureExportDir();
  const safeName = fileName.endsWith(".json") ? fileName : `${fileName}.json`;
  const target = path.join(EXPORT_DIR, safeName);
  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf-8");
  return target;
};

const writeExportXls = async (fileName: string, rows: Array<Array<unknown>>) => {
  await ensureExportDir();
  const safeName = fileName.endsWith(".xls") ? fileName : `${fileName}.xls`;
  const target = path.join(EXPORT_DIR, safeName);
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Data");
  const buffer = XLSX.write(workbook, { bookType: "xls", type: "buffer" });
  await fs.writeFile(target, buffer);
  return target;
};

const buildTopologicalOrder = (nodes: DataCollectorNode[], edges: Edge[]) => {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  nodes.forEach((node) => {
    incoming.set(node.id, new Set());
    outgoing.set(node.id, new Set());
  });
  edges.forEach((edge) => {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source)) return;
    incoming.get(edge.target)?.add(edge.source);
    outgoing.get(edge.source)?.add(edge.target);
  });
  const order: DataCollectorNode[] = [];
  const queue: string[] = [];
  incoming.forEach((deps, nodeId) => {
    if (deps.size === 0) queue.push(nodeId);
  });
  while (queue.length) {
    const nodeId = queue.shift() as string;
    const node = nodes.find((item) => item.id === nodeId);
    if (node) order.push(node);
    outgoing.get(nodeId)?.forEach((target) => {
      const deps = incoming.get(target);
      if (!deps) return;
      deps.delete(nodeId);
      if (deps.size === 0) queue.push(target);
    });
  }
  return order;
};

const resolveDbSaveInputs = (
  node: DataCollectorNode,
  nodes: DataCollectorNode[],
  edges: Edge[],
) => {
  const incoming = edges.filter((edge) => edge.target === node.id);
  const dbEdge = incoming.find((edge) => {
    const sourceNode = nodes.find((item) => item.id === edge.source);
    return sourceNode?.data.kind === "dbSink";
  });
  const sourceEdge = incoming.find((edge) => {
    const sourceNode = nodes.find((item) => item.id === edge.source);
    return sourceNode?.data.kind !== "dbSink";
  });
  const dbNode = dbEdge
    ? nodes.find((item) => item.id === dbEdge.source)
    : null;
  const sourceNode = sourceEdge
    ? nodes.find((item) => item.id === sourceEdge.source)
    : null;
  return { dbNode, sourceNode };
};

const tabularFromDbRows = (
  rows: Array<Record<string, unknown>>,
  columns?: Array<{ name: string; dataType: string }>,
) => {
  if (!rows.length) return { header: [], dataRows: [] };
  const header = columns?.length ? columns.map((col) => col.name) : Object.keys(rows[0]);
  const dataRows = rows.map((row) => header.map((key) => row[key] ?? null));
  return { header, dataRows };
};

const runNode = async (
  node: DataCollectorNode,
  nodes: DataCollectorNode[],
  edges: Edge[],
  results: Map<string, NodeRunResult>,
): Promise<NodeRunResult> => {
  if (node.data.kind === "dbSink") {
    return { ok: true };
  }
  if (node.data.kind === "excel") {
    const sheetName =
      node.data.excelOptions?.sheetName || node.data.excelSheets?.[0];
    const rows = sheetName ? node.data.excelRowsBySheet?.[sheetName] : undefined;
    if (!rows || !rows.length) {
      return { ok: false, error: "엑셀 데이터를 먼저 실행하세요." };
    }
    const excelOptions = {
      startRow: 1,
      startCol: 1,
      hasHeader: true,
      ...node.data.excelOptions,
    };
    const tabular = buildExcelTabular(rows, excelOptions);
    return { ok: true, tabular };
  }
  if (node.data.kind === "api") {
    const payload = await fetchApiData(node.data.config);
    return {
      ok: true,
      apiResult: payload,
      tabular: buildTabularFromApi(payload),
    };
  }
  if (node.data.kind === "db") {
    if (!node.data.dbConfig) {
      return { ok: false, error: "DB 설정이 없습니다." };
    }
    const options = node.data.dbQueryOptions ?? {};
    const { rows, columns } = await queryDb(node.data.dbConfig, {
      schema: options.schema,
      table: options.tableName,
      sql: options.mode === "sql" ? options.sql : undefined,
    });
    return { ok: true, dbRows: rows, dbColumns: columns };
  }
  if (node.data.kind === "dbSave") {
    const storageOptions = node.data.storageOptions;
    if (!storageOptions?.tableName) {
      return { ok: false, error: "저장할 테이블을 선택하세요." };
    }
    const { dbNode, sourceNode } = resolveDbSaveInputs(node, nodes, edges);
    if (!dbNode?.data.dbConfig) {
      return { ok: false, error: "DB 설정 노드를 연결하세요." };
    }
    if (!sourceNode) {
      return { ok: false, error: "입력 노드를 연결하세요." };
    }
    const sourceResult = results.get(sourceNode.id);
    if (!sourceResult?.ok) {
      return { ok: false, error: sourceResult?.error ?? "입력 노드 실행 실패" };
    }
    let tabular: TabularData | undefined;
    if (sourceNode.data.kind === "api") {
      tabular = sourceResult.tabular ?? buildTabularFromApi(sourceResult.apiResult);
    } else if (sourceNode.data.kind === "db") {
      tabular = tabularFromDbRows(
        sourceResult.dbRows ?? [],
        sourceResult.dbColumns,
      );
    } else if (sourceNode.data.kind === "excel") {
      tabular = sourceResult.tabular;
    } else {
      return { ok: false, error: "지원되지 않는 입력 노드입니다." };
    }
    if (!tabular?.header.length || !tabular.dataRows.length) {
      return { ok: false, error: "입력 데이터를 확인할 수 없습니다." };
    }
    const mappings = storageOptions.columnMappings ?? {};
    const mappedColumns = Object.keys(mappings).filter((column) => mappings[column]);
    if (!mappedColumns.length) {
      return { ok: false, error: "컬럼 매핑을 완료하세요." };
    }
    const sourceIndices = mappedColumns.map((column) =>
      tabular.header.indexOf(mappings[column] ?? ""),
    );
    if (sourceIndices.some((index) => index < 0)) {
      return { ok: false, error: "입력 컬럼 매핑이 올바르지 않습니다." };
    }
    const insertRows = tabular.dataRows
      .map((row) => sourceIndices.map((index) => row[index] ?? null))
      .filter((row) => row.some((value) => value !== null && value !== ""));
    if (!insertRows.length) {
      return { ok: false, error: "저장할 데이터가 없습니다." };
    }
    await insertDbRows(dbNode.data.dbConfig, {
      schema: storageOptions.schema ?? "public",
      table: storageOptions.tableName,
      columns: mappedColumns,
      rows: insertRows,
      truncate: storageOptions.truncateBeforeInsert,
    });
    return { ok: true };
  }
  if (node.data.kind === "fileSave") {
    const sourceNode = resolveDbSaveInputs(node, nodes, edges).sourceNode;
    if (!sourceNode) {
      return { ok: false, error: "입력 노드를 연결하세요." };
    }
    const sourceResult = results.get(sourceNode.id);
    if (!sourceResult?.ok) {
      return { ok: false, error: sourceResult?.error ?? "입력 노드 실행 실패" };
    }
    const includeHeader = node.data.fileSaveOptions?.includeHeader ?? true;
    const format = node.data.fileSaveOptions?.format ?? "xls";
    const jsonShape = node.data.fileSaveOptions?.jsonShape ?? "array";
    let csvRows: Array<Array<unknown>> = [];
    let jsonPayload: unknown = null;

    if (sourceNode.data.kind === "excel") {
      const tabular = sourceResult.tabular;
      if (!tabular || !tabular.header.length) {
        return { ok: false, error: "엑셀 데이터를 먼저 실행하세요." };
      }
      csvRows = includeHeader
        ? [tabular.header, ...tabular.dataRows]
        : tabular.dataRows;
      jsonPayload = includeHeader
        ? tabular.dataRows.map((row) =>
            tabular.header.reduce<Record<string, unknown>>((acc, key, index) => {
              acc[key] = row[index] ?? null;
              return acc;
            }, {}),
          )
        : tabular.dataRows;
    } else if (sourceNode.data.kind === "db") {
      const rows = sourceResult.dbRows ?? [];
      if (!rows.length) {
        return { ok: false, error: "DB 조회 데이터를 먼저 실행하세요." };
      }
      const headers = sourceResult.dbColumns?.length
        ? sourceResult.dbColumns.map((col) => col.name)
        : Object.keys(rows[0]);
      const dataRows = rows.map((row) => headers.map((key) => row[key] ?? null));
      csvRows = includeHeader ? [headers, ...dataRows] : dataRows;
      jsonPayload = rows;
    } else if (sourceNode.data.kind === "api") {
      const apiPayload = sourceResult.apiResult ?? null;
      if (apiPayload == null) {
        return { ok: false, error: "API 응답 데이터가 없어 저장할 수 없습니다." };
      }
      const tabular = sourceResult.tabular ?? buildTabularFromApi(apiPayload);
      csvRows = includeHeader ? [tabular.header, ...tabular.dataRows] : tabular.dataRows;
      jsonPayload = apiPayload;
    } else {
      const tabular = sourceResult.tabular;
      if (tabular?.header.length) {
        csvRows = includeHeader ? [tabular.header, ...tabular.dataRows] : tabular.dataRows;
        jsonPayload = tabular.dataRows;
      }
    }
    if (!csvRows.length) {
      return { ok: false, error: "저장할 데이터가 없습니다." };
    }
    const fileName =
      node.data.fileSaveOptions?.fileName?.trim() || `data-${Date.now()}`;
    if (format === "json") {
      const payload =
        jsonShape === "object" ? { rows: jsonPayload ?? [] } : jsonPayload ?? [];
      await writeExportJson(fileName, payload);
    } else {
      await writeExportXls(fileName, csvRows);
    }
    return { ok: true };
  }
  return { ok: true };
};

const executeWorkflow = async (workflow: WorkflowState) => {
  const results = new Map<string, NodeRunResult>();
  const order = buildTopologicalOrder(workflow.nodes, workflow.edges);
  for (const node of order) {
    const result = await runNode(node, workflow.nodes, workflow.edges, results);
    results.set(node.id, result);
    if (!result.ok) {
      const message = result.error ?? "노드 실행에 실패했습니다.";
      throw new Error(`${node.data.label}: ${message}`);
    }
  }
  return results;
};

export const executeScheduleRun = async (scheduleId: string) => {
  const entry = await getSchedule(scheduleId);
  if (!entry) throw new Error("스케줄을 찾지 못했습니다.");
  await executeWorkflow(entry.workflow);
};
