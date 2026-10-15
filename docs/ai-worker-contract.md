# AI 워커 계약 (Worker Contract)

> Orchestrator 가 모든 전문 Agent 를 호출할 때 사용하는 **공통 입·출력 규약**.  
> Agent 구현(OpenAI tools, 스트리밍 등)은 달라도 **계약 표면은 동일**해야 한다.

관련: [ai-platform-layers.md](./ai-platform-layers.md) · [ai-orchestrator-fsm.md](./ai-orchestrator-fsm.md)

---

## 1. 목적

- Agent 교체·추가 시 Orchestrator / UI 를 다시 짜지 않는다.
- LLM(클라우드↔로컬) 교체 시에도 응답 모드만 유지되면 된다.
- HITL·재질문·에러를 타입이 있는 결과로 표현한다.

---

## 2. 호출

### 2.1 Request

```ts
type WorkerRequest = {
  sessionId: string;
  goal: string;                 // 사용자 목표 또는 Orchestrator가 넘긴 step goal
  context?: {
    messages?: Array<{ role: string; content: string }>; // 최근 대화 요약/원문
    assets?: CatalogRef[];      // Registry에서 고른 자산
    priorResults?: unknown[];   // 이전 step 결과 요약
  };
  dbSettingId?: number | null;
  workerId: WorkerId;           // 어느 워커인지 (로깅·라우팅)
};

type WorkerId =
  | "data_readiness"
  | "dataset_engineering"
  | "analytics"
  | "prediction"
  | "viz_report";

type CatalogRef = {
  kind: "dataset" | "pipeline" | "model" | "tool" | "mapping" | "source" | "transform";
  id: string;
  name?: string;
};
```

### 2.2 Response (배타적 하나)

```ts
type WorkerResponse =
  | { mode: "answer"; text: string; data?: unknown }
  | { mode: "proposal"; pendingAction: PendingAction }
  | { mode: "needs_input"; questions: NeedInputQuestion[]; text?: string }
  | { mode: "error"; error: string; retryable: boolean; code?: string };

type PendingAction = {
  token: string;                // 일회성, confirm 키
  type: string;                 // executeAction 타입 (예: run_collection)
  args: Record<string, unknown>;
  summary: string;              // UI 카드에 표시
  workerId: WorkerId;
};

type NeedInputQuestion = {
  id: string;
  prompt: string;
  inputType?: "text" | "date" | "choice";
  choices?: string[];
  required?: boolean;
};
```

### 2.3 Confirm (HITL)

Orchestrator 또는 UI 가 동일 세션에서:

```ts
type ConfirmRequest = {
  sessionId: string;
  token: string;
  decision: "confirm" | "cancel";
  dbSettingId?: number | null;
};

type ConfirmResponse = {
  ok: boolean;
  status: "executed" | "cancelled" | "failed";
  message: string;
  result?: unknown;
};
```

규칙:

- `token` 은 **단일 사용**. `pending` 이 아닌 상태면 404/거절.
- 실행은 **해당 Worker 의 execute 경로**만 (Orchestrator 가 엔진 API 직접 호출 금지).
- 성공/실패 메시지를 세션에 assistant 메시지로 남긴다.

---

## 3. 모드 의미

| mode | Orchestrator 동작 | UI |
|---|---|---|
| `answer` | step 완료 또는 최종 통합 재료 | 텍스트 표시 |
| `proposal` | 상태 → `awaiting_confirm` | 승인/취소 카드 |
| `needs_input` | 상태 → `awaiting_user` | 질문 표시, 답 오면 같은 worker 재호출 |
| `error` | retryable 이면 재시도/되묻기, 아니면 step 실패 | 오류 표시 |

---

## 4. 기존 data-agent 와의 매핑

| 현재 | 계약 |
|---|---|
| `POST /api/data-agent/chat` → `mode: "answer"` | `WorkerResponse.mode = "answer"` |
| `mode: "proposal"` + `pendingAction` | `mode: "proposal"` (+ `workerId: "data_readiness"`) |
| (암묵적 재질문 텍스트) | 향후 `needs_input` 으로 구조화 권장 |
| `POST /api/data-agent/confirm` | `ConfirmRequest` |

어댑터 구현 시: 기존 JSON 을 `WorkerResponse` 로 감싸고, UI/Orchestrator 는 계약만 본다.

---

## 5. 세션 메타데이터 (최소)

채팅 메시지 `metadata` (기존 `dp.ai_forecast_chat_*` 재사용):

```json
{
  "app": "ai-orchestrator",
  "workerId": "data_readiness",
  "pendingAction": {
    "token": "...",
    "type": "run_collection",
    "args": {},
    "summary": "...",
    "workerId": "data_readiness",
    "status": "pending"
  }
}
```

`app` 값:

- `data-agent` — 직접 모드 (기존)
- `ai-orchestrator` — 통합 오케스트레이션
- (forecast 기존 마커 유지)

---

## 6. 비기능

- **멱등**: 동일 token confirm 재전송은 두 번째부터 거절.
- **비밀**: API 키·토큰을 `summary`·`answer`·로그 응답에 넣지 않음.
- **크기**: tool/엔진 결과를 Worker 가 요약; Orchestrator 컨텍스트에는 요약만.
- **타임아웃**: Worker 는 엔진 타임아웃을 `error.retryable` 로 전달 가능.

---

## 7. 버전

- `contractVersion: "1.0"` — 본 문서.
- 필드 추가 시 하위 호환; `mode` 값 변경·삭제는 major.
