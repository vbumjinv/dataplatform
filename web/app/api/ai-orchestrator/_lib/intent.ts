import type { WorkerId } from "./worker-contract";

export type OrchestratorIntent =
  | "collection"
  | "dataset"
  | "mixed"
  | "unknown";

export type OrchestratorPlanStep = {
  id: string;
  workerId: WorkerId;
  goal: string;
  status:
    | "pending"
    | "running"
    | "awaiting_confirm"
    | "awaiting_user"
    | "done"
    | "skipped"
    | "failed";
};

export type OrchestratorPlan = {
  intent: OrchestratorIntent;
  summary: string;
  steps: OrchestratorPlanStep[];
};

export type IntentResult = {
  intent: OrchestratorIntent;
  unsupportedArea?: "prediction" | "visualization" | "analytics";
  confidence: number;
  reason: string;
  needsClarification?: boolean;
  clarificationText?: string;
};

export type RoutingContext = {
  lastIntent?: OrchestratorIntent;
  lastWorkerId?: WorkerId;
};

type WeightedPattern = { pattern: RegExp; weight: number };

const score = (text: string, patterns: WeightedPattern[]) =>
  patterns.reduce((sum, item) => sum + (item.pattern.test(text) ? item.weight : 0), 0);

const hasAny = (text: string, patterns: RegExp[]) =>
  patterns.some((pattern) => pattern.test(text));

const COLLECTION_PATTERNS: WeightedPattern[] = [
  { pattern: /수집/, weight: 4 },
  { pattern: /적재/, weight: 4 },
  { pattern: /\bapi\b/i, weight: 3 },
  { pattern: /기관/, weight: 3 },
  { pattern: /소스/, weight: 3 },
  { pattern: /통계/, weight: 2 },
  { pattern: /그룹/, weight: 2 },
  { pattern: /_lrd/i, weight: 2 },
  { pattern: /시작일/, weight: 2 },
  { pattern: /종료일/, weight: 2 },
  { pattern: /데이터\s*(가져|불러|받아)/, weight: 3 },
  { pattern: /테이블\s*(생성|만들|작성)/, weight: 4 },
  { pattern: /(생성문|ddl)/i, weight: 4 },
  // 아래는 겹치는 단어라 낮은 점수만 준다.
  { pattern: /테이블/, weight: 1 },
  { pattern: /등록/, weight: 1 },
  { pattern: /기간/, weight: 1 },
  { pattern: /파라미터/, weight: 1 },
  { pattern: /샘플/, weight: 3 },
  { pattern: /미리보기/, weight: 3 },
  { pattern: /프리뷰/, weight: 3 },
  { pattern: /보여/, weight: 1 },
];

const DATASET_PATTERNS: WeightedPattern[] = [
  { pattern: /전처리/, weight: 4 },
  { pattern: /매핑/, weight: 4 },
  { pattern: /가공/, weight: 4 },
  { pattern: /파이프라인/, weight: 3 },
  { pattern: /시계열/, weight: 3 },
  { pattern: /리샘플/, weight: 3 },
  { pattern: /증감률/, weight: 3 },
  { pattern: /이동평균/, weight: 3 },
  { pattern: /보간/, weight: 3 },
  { pattern: /\btransform\b/i, weight: 3 },
  // 아래는 겹치는 단어라 낮은 점수만 준다.
  { pattern: /테이블/, weight: 1 },
  { pattern: /등록/, weight: 1 },
  { pattern: /기간/, weight: 1 },
  { pattern: /파라미터/, weight: 1 },
];

const PREDICTION_PATTERNS = [/예측/, /모델/, /학습/, /\bforecast\b/i, /\bpredict/i];
const VISUALIZATION_PATTERNS = [/시각화/, /차트/, /대시보드/, /리포트/, /보고서/];
const ANALYTICS_PATTERNS = [/분석/, /상관/, /회귀/, /요인/, /영향도/];
const FOLLOW_UP_PATTERNS = [
  /방금/,
  /그거/,
  /이거/,
  /저거/,
  /이전/,
  /위에/,
  /어떻게/,
  /알려/,
  /확인/,
  /해줘/,
  /보여/,
  /샘플/,
  /미리보기/,
  /프리뷰/,
  /등록한/,
  /수집하려/,
  /수집\s*설정/,
  /^\s*\d+\s*번?\s*$/,
  /\d{4}-\d{2}-\d{2}.*(부터|~|-).*?\d{4}-\d{2}-\d{2}/,
  /(부터|까지)/,
];
const SEQUENTIAL_PATTERNS = [/까지/, /하고/, /한\s*뒤/, /후에/, /다음/, /수집.*(매핑|가공|전처리)/, /(매핑|가공|전처리).*수집/];

const intentFromWorker = (workerId?: WorkerId): OrchestratorIntent | null => {
  if (workerId === "data_readiness") return "collection";
  if (workerId === "dataset_engineering") return "dataset";
  return null;
};

const clarify = (reason: string): IntentResult => ({
  intent: "unknown",
  confidence: 0.2,
  reason,
  needsClarification: true,
  clarificationText:
    "수집 설정을 확인하려는 건가요, 아니면 매핑/가공 같은 전처리 작업인가요?",
});

export const classifyIntent = (
  message: string,
  context: RoutingContext = {},
): IntentResult => {
  const text = message.trim();
  const collectionScore = score(text, COLLECTION_PATTERNS);
  const datasetScore = score(text, DATASET_PATTERNS);
  const hasCollection = collectionScore >= 3;
  const hasDataset = datasetScore >= 3;
  const isFollowUp = hasAny(text, FOLLOW_UP_PATTERNS);
  const contextIntent = intentFromWorker(context.lastWorkerId) ?? context.lastIntent;

  if (hasCollection && hasDataset) {
    if (hasAny(text, SEQUENTIAL_PATTERNS)) {
      return {
        intent: "mixed",
        confidence: 0.85,
        reason: "수집과 전처리 키워드가 함께 있고 순차 실행 표현이 있습니다.",
      };
    }
    if (isFollowUp && contextIntent && contextIntent !== "mixed") {
      return {
        intent: contextIntent,
        confidence: 0.75,
        reason: "겹치는 키워드가 있지만 최근 대화 맥락을 우선했습니다.",
      };
    }
    return clarify("수집/전처리 키워드가 함께 있으나 순차 실행인지 구분하기 어렵습니다.");
  }

  if (hasCollection) {
    return {
      intent: "collection",
      confidence: Math.min(0.95, 0.55 + collectionScore / 10),
      reason: "수집 점수가 전처리보다 높습니다.",
    };
  }
  if (hasDataset) {
    return {
      intent: "dataset",
      confidence: Math.min(0.95, 0.55 + datasetScore / 10),
      reason: "전처리 점수가 수집보다 높습니다.",
    };
  }

  if (isFollowUp && contextIntent && contextIntent !== "unknown") {
    return {
      intent: contextIntent,
      confidence: 0.7,
      reason: "명시 키워드는 약하지만 후속 질문으로 판단해 최근 대화 맥락을 따랐습니다.",
    };
  }

  if (hasAny(text, PREDICTION_PATTERNS)) {
    return {
      intent: "unknown",
      unsupportedArea: "prediction",
      confidence: 0.9,
      reason: "예측 요청은 1차 범위에서 제외되어 있습니다.",
    };
  }
  if (hasAny(text, VISUALIZATION_PATTERNS)) {
    return {
      intent: "unknown",
      unsupportedArea: "visualization",
      confidence: 0.9,
      reason: "시각화 요청은 1차 범위에서 제외되어 있습니다.",
    };
  }
  if (hasAny(text, ANALYTICS_PATTERNS)) {
    return {
      intent: "unknown",
      unsupportedArea: "analytics",
      confidence: 0.9,
      reason: "분석 요청은 1차 범위에서 제외되어 있습니다.",
    };
  }

  return clarify("수집/전처리 판단에 필요한 점수가 부족합니다.");
};

export const createPlan = (
  intent: OrchestratorIntent,
  goal: string,
): OrchestratorPlan => {
  if (intent === "collection") {
    return {
      intent,
      summary: "데이터 수집 작업으로 판단했습니다.",
      steps: [{ id: "collection-1", workerId: "data_readiness", goal, status: "pending" }],
    };
  }
  if (intent === "dataset") {
    return {
      intent,
      summary: "전처리/데이터셋 작업으로 판단했습니다.",
      steps: [{ id: "dataset-1", workerId: "dataset_engineering", goal, status: "pending" }],
    };
  }
  if (intent === "mixed") {
    return {
      intent,
      summary: "수집 후 전처리까지 필요한 복합 작업으로 판단했습니다.",
      steps: [
        { id: "collection-1", workerId: "data_readiness", goal, status: "pending" },
        { id: "dataset-1", workerId: "dataset_engineering", goal, status: "pending" },
      ],
    };
  }
  return {
    intent,
    summary: "1차 오케스트레이터 범위에서 처리할 수 있는 의도를 찾지 못했습니다.",
    steps: [],
  };
};

export const unsupportedMessage = (area?: IntentResult["unsupportedArea"]) => {
  if (area === "prediction") {
    return "예측 AI 연동은 1차 범위에서 제외했습니다. 현재는 데이터 수집과 전처리(매핑·가공)만 지원합니다.";
  }
  if (area === "visualization") {
    return "시각화/리포트 AI 연동은 1차 범위에서 제외했습니다. 현재는 데이터 수집과 전처리(매핑·가공)만 지원합니다.";
  }
  if (area === "analytics") {
    return "분석 AI 연동은 1차 범위에서 제외했습니다. 현재는 데이터 수집과 전처리(매핑·가공)만 지원합니다.";
  }
  return "요청 의도를 수집 또는 전처리로 판단하지 못했습니다. 데이터 수집, 매핑, 가공 중 어떤 작업인지 조금 더 구체적으로 말씀해 주세요.";
};
