import type { Edge, Node } from "reactflow";

export type NodeStatus = "idle" | "running" | "success" | "error";

export type HttpMethod = "GET";

export type IngestionKind = "excel" | "api" | "db";

export type StorageKind = "dbSave" | "fileSave";

export type NodeKind = IngestionKind | StorageKind | "dbSink";

export type StorageOptions = {
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
};

export type DbQueryOptions = {
  mode?: "table" | "sql";
  schema?: string;
  tableName?: string;
  schemas?: string[];
  schemasLoading?: boolean;
  schemasError?: string;
  tables?: string[];
  tablesLoading?: boolean;
  tablesError?: string;
  sql?: string;
};

export type FileSaveOptions = {
  format?: "xls" | "json";
  jsonShape?: "array" | "object";
  fileName?: string;
  includeHeader?: boolean;
};

export interface DataCollectorConfig {
  endpoint: string;
  method: HttpMethod;
  timeout: number;
  apiKey?: string;
  apiKeyByProvider?: Partial<Record<"bok" | "kosis" | "dataGoKr", string>>;
  apiProviderConfigs?: Partial<
    Record<
      "bok" | "kosis" | "dataGoKr",
      {
        apiKey?: string;
        apiFormat?: "json" | "xml";
        apiLang?: string;
        apiStatCode?: string;
        apiPeriod?: string;
        apiStart?: string;
        apiEnd?: string;
        apiUserStatsId?: string;
        apiPrdSe?: string;
        apiStartPrdDe?: string;
        apiEndPrdDe?: string;
        apiStrtYymm?: string;
        apiEndYymm?: string;
        apiStartParamName?: string;
        apiEndParamName?: string;
        apiOrgCode?: string;
        apiName?: string;
        apiFunctionName?: string;
      }
    >
  >;
  apiKeyParam?: string;
  queryParams?: string;
  apiProvider?: "custom" | "bok" | "kosis" | "dataGoKr";
  apiListMode?: boolean;
  apiFormat?: "json" | "xml";
  apiLang?: string;
  apiStatCode?: string;
  apiPeriod?: string;
  apiStart?: string;
  apiEnd?: string;
  apiUserStatsId?: string;
  apiPrdSe?: string;
  apiStartPrdDe?: string;
  apiEndPrdDe?: string;
  apiStrtYymm?: string;
  apiEndYymm?: string;
  apiStartParamName?: string;
  apiEndParamName?: string;
  apiOrgCode?: string;
  apiName?: string;
  apiFunctionName?: string;
}

export interface DataCollectorData {
  label: string;
  kind: NodeKind;
  status: NodeStatus;
  lastRun?: string;
  preview?: string;
  apiResult?: unknown;
  error?: string;
  fileName?: string;
  dbConfig?: {
    url: string;
    database: string;
    user: string;
    password: string;
    dbType: "postgres";
  };
  storageOptions?: StorageOptions;
  dbQueryOptions?: DbQueryOptions;
  fileSaveOptions?: FileSaveOptions;
  excelOptions?: {
    sheetName?: string;
    startRow: number;
    startCol: number;
    hasHeader: boolean;
  };
  excelSheets?: string[];
  excelRowsBySheet?: Record<
    string,
    Array<Array<string | number | boolean | null>>
  >;
  excelPreview?: {
    sheet: string;
    rows: Array<Array<string | number | boolean | null>>;
    header?: Array<string | number | boolean | null>;
  };
  dbQueryRows?: Array<Record<string, unknown>>;
  dbQueryColumns?: Array<{ name: string; dataType: string }>;
  config: DataCollectorConfig;
}

export type DataCollectorNode = Node<DataCollectorData>;

export interface WorkflowState {
  nodes: DataCollectorNode[];
  edges: Edge[];
}
