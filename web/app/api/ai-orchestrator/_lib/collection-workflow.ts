export const COLLECTION_WORKFLOW_VERSION = "1.0" as const;

export type CollectionStage =
  | "select_api"
  | "collect_required_input"
  | "preview_draft"
  | "register_api"
  | "configure_table"
  | "create_or_bind_table"
  | "run_ingestion"
  | "completed";

export type CollectionWorkflowStatus =
  | "active"
  | "completed"
  | "cancelled"
  | "failed";

export type CollectionParam = {
  key: string;
  value: string;
  location: "path" | "query";
  order: number;
  role?: string | null;
  encodeMode?: string;
};

export type CollectionWorkflowState = {
  version: typeof COLLECTION_WORKFLOW_VERSION;
  provider?: string;
  sourceName?: string;
  sourceId?: number;
  apiCode?: string;
  apiName?: string;
  cycle?: string;
  startDate?: string;
  endDate?: string;
  params?: CollectionParam[];
  preview?: {
    checked: boolean;
    header: string[];
    columns: Array<{ name: string; type: string }>;
    sample: Array<Record<string, unknown>>;
  };
  groupId?: number;
  target?: {
    schema: string;
    table: string;
    truncate: boolean;
    mergeSql?: string | null;
  };
  loadResult?: {
    inserted?: number;
    loadTaskId?: string;
  };
  pending?: {
    token: string;
    actionType: string;
    stage: CollectionStage;
    revision: number;
  };
  lastError?: string;
};

export type CollectionWorkflow = {
  workflowId: string;
  sessionId: string;
  userId: string;
  dbSettingId: number | null;
  stage: CollectionStage;
  status: CollectionWorkflowStatus;
  state: CollectionWorkflowState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

const DATE_RANGE =
  /(\d{4}-\d{2}-\d{2})\s*(?:부터|~|에서|-)\s*(\d{4}-\d{2}-\d{2})/;
const TABLE_NAME = /\b([a-zA-Z_][a-zA-Z0-9_]*_lrd)\b/i;

export const shouldStartCollectionWorkflow = (message: string) =>
  /(?:수집|API).*(?:추가|신규|등록(?!된|되어|돼)|준비|생성|진행|설정해|해\s*줘|해주세요)|(?:추가|신규|등록(?!된|되어|돼)).*(?:API|수집)|수집\s*(?:해\s*줘|해주세요|해서|하려)/i.test(
    message,
  );

export const inferCollectionInput = (
  message: string,
  current: CollectionWorkflowState,
): CollectionWorkflowState => {
  const next = { ...current };
  const dateRange = DATE_RANGE.exec(message);
  if (dateRange) {
    next.startDate = dateRange[1];
    next.endDate = dateRange[2];
  }
  const tableName = TABLE_NAME.exec(message)?.[1];
  if (tableName) {
    next.target = {
      schema: current.target?.schema ?? "dp",
      table: tableName,
      truncate: current.target?.truncate ?? false,
      mergeSql: current.target?.mergeSql ?? null,
    };
  }
  if (/한국은행/.test(message)) {
    next.provider = "bok";
    next.sourceName = "한국은행";
  } else if (/통계청|kosis/i.test(message)) {
    next.provider = "kosis";
    next.sourceName = "통계청";
  } else if (/fred|미국\s*연준/i.test(message)) {
    next.provider = "fred";
    next.sourceName = "FRED";
  }
  if (/기존\s*데이터\s*(삭제|지우)|truncate/i.test(message)) {
    next.target = {
      schema: current.target?.schema ?? "dp",
      table: current.target?.table ?? "",
      truncate: !/(안\s*해|하지\s*마|false)/i.test(message),
      mergeSql: current.target?.mergeSql ?? null,
    };
  }
  return next;
};

export const stageForAction = (
  actionType: string,
): CollectionStage | null => {
  if (actionType === "register_source") return "register_api";
  if (
    actionType === "create_staging_table" ||
    actionType === "update_group_target_table"
  ) {
    return "create_or_bind_table";
  }
  if (actionType === "run_collection") return "run_ingestion";
  return null;
};

export const nextStageAfterAction = (
  actionType: string,
  ok: boolean,
): CollectionStage | null => {
  if (!ok) return null;
  if (actionType === "register_source") return "configure_table";
  if (
    actionType === "create_staging_table" ||
    actionType === "update_group_target_table"
  ) {
    return "run_ingestion";
  }
  if (actionType === "run_collection") return "completed";
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const applyProposalToState = (
  state: CollectionWorkflowState,
  actionType: string,
  args: Record<string, unknown>,
): CollectionWorkflowState => {
  const next = { ...state };
  if (actionType === "register_source") {
    const source = asRecord(args.source);
    next.provider = String(source.provider ?? next.provider ?? "");
    next.sourceName = String(source.name ?? next.sourceName ?? "");
    next.apiName = String(args.groupName ?? next.apiName ?? "");
    if (Array.isArray(args.params)) {
      next.params = args.params as CollectionParam[];
    }
  }
  if (
    actionType === "create_staging_table" ||
    actionType === "update_group_target_table"
  ) {
    next.sourceId = Number(args.sourceId) || next.sourceId;
    next.groupId = Number(args.groupId) || next.groupId;
    next.target = {
      schema: String(args.schema ?? next.target?.schema ?? "dp"),
      table: String(args.table ?? next.target?.table ?? ""),
      truncate:
        typeof args.truncate === "boolean"
          ? args.truncate
          : (next.target?.truncate ?? false),
      mergeSql:
        typeof args.mergeSql === "string"
          ? args.mergeSql
          : (next.target?.mergeSql ?? null),
    };
  }
  if (actionType === "run_collection") {
    next.sourceId = Number(args.sourceId) || next.sourceId;
    next.groupId = Number(args.groupId) || next.groupId;
    if (typeof args.truncate === "boolean" && next.target) {
      next.target = { ...next.target, truncate: args.truncate };
    }
  }
  return next;
};

export const applyExecutionResult = (
  state: CollectionWorkflowState,
  actionType: string,
  result: { ok: boolean; error?: string; data?: unknown },
): CollectionWorkflowState => {
  const next: CollectionWorkflowState = {
    ...state,
    pending: undefined,
    lastError: result.ok ? undefined : result.error,
  };
  if (!result.ok) return next;
  const data = asRecord(result.data);
  if (actionType === "register_source") {
    next.sourceId = Number(data.sourceId) || next.sourceId;
    next.groupId = Number(data.groupId) || next.groupId;
  }
  if (actionType === "run_collection") {
    next.loadResult = {
      inserted: Number(data.inserted) || 0,
      loadTaskId:
        typeof data.loadTaskId === "string" ? data.loadTaskId : undefined,
    };
  }
  return next;
};

export const workflowContextText = (workflow: CollectionWorkflow) =>
  [
    "[현재 수집 워크플로 상태]",
    `workflowId=${workflow.workflowId}`,
    `stage=${workflow.stage}`,
    `revision=${workflow.revision}`,
    `provider=${workflow.state.provider ?? ""}`,
    `sourceId=${workflow.state.sourceId ?? ""}`,
    `groupId=${workflow.state.groupId ?? ""}`,
    `apiName=${workflow.state.apiName ?? ""}`,
    `period=${workflow.state.startDate ?? ""}~${workflow.state.endDate ?? ""}`,
    `target=${workflow.state.target?.schema ?? ""}.${workflow.state.target?.table ?? ""}`,
    "현재 stage와 저장된 ID를 우선 사용하고, 이미 받은 필수값을 다시 질문하지 마세요.",
  ].join("\n");

export const publicWorkflow = (workflow: CollectionWorkflow) => ({
  workflowId: workflow.workflowId,
  stage: workflow.stage,
  status: workflow.status,
  revision: workflow.revision,
  state: {
    ...workflow.state,
    params: workflow.state.params?.map((param) => ({
      ...param,
      value: /key|token|secret|auth/i.test(param.key)
        ? "[REDACTED]"
        : param.value,
    })),
  },
});
