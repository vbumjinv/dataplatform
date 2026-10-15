export type WorkerId =
  | "data_readiness"
  | "dataset_engineering"
  | "analytics"
  | "prediction"
  | "viz_report";

export type CatalogKind =
  | "source"
  | "group"
  | "dataset"
  | "mapping"
  | "transform"
  | "pipeline"
  | "model"
  | "tool"
  | "chart";

export type CatalogRef = {
  kind: CatalogKind;
  id: string;
  name?: string;
};

export type WorkerRequest = {
  sessionId: string;
  goal: string;
  context?: {
    messages?: Array<{ role: string; content: string }>;
    assets?: CatalogRef[];
    priorResults?: unknown[];
  };
  dbSettingId?: number | null;
  workerId: WorkerId;
};

export type PendingAction = {
  token: string;
  type: string;
  args: Record<string, unknown>;
  summary: string;
  workerId: WorkerId;
};

export type NeedInputQuestion = {
  id: string;
  prompt: string;
  inputType?: "text" | "date" | "choice";
  choices?: string[];
  required?: boolean;
};

export type WorkerResponse =
  | { mode: "answer"; text: string; data?: unknown }
  | { mode: "proposal"; pendingAction: PendingAction }
  | { mode: "needs_input"; questions: NeedInputQuestion[]; text?: string }
  | { mode: "error"; error: string; retryable: boolean; code?: string };

export type ConfirmRequest = {
  sessionId: string;
  token: string;
  decision: "confirm" | "cancel";
  dbSettingId?: number | null;
};

export type ConfirmResponse = {
  ok: boolean;
  status: "executed" | "cancelled" | "failed";
  message: string;
  result?: unknown;
};

export const WORKER_CONTRACT_VERSION = "1.0" as const;
export const DATA_READINESS_WORKER_ID: WorkerId = "data_readiness";
export const DATASET_ENGINEERING_WORKER_ID: WorkerId = "dataset_engineering";
