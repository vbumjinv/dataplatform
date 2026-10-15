# AI 플랫폼 계층·경계

> 마스터 설계서 · Whole_Architecture 와 현재 Dataplatform 을 맞춘 **계층 고정 문서**.  
> 구현 전에 합의하는 경계. 위반 시 설계 변경으로 취급한다.

관련: AI 마스터 설계서(`f:\02. 빅데이터\01. 경제지표\3차\AI 마스터 설계서.docx`) · [Whole_Architecture.png](./Whole_Architecture.png) · [ai-data-agent.md](./ai-data-agent.md) · [인덱스](./ai-platform-README.md)

---

## 1. 목표

데이터 수집–전처리–분석·예측–시각화를 **기존 실행 엔진**이 수행하고, AI는 **계획·선택·해석·요청**만 담당한다.  
AI가 적재·학습·렌더를 직접 대체하지 않는다.

---

## 2. 계층 구조

```
┌─────────────────────────────────────────┐
│  Presentation                            │
│  /ai-assistant (통합) · /data-agent      │
│  /ingestion · 시각화·예측 UI (엔진 조작면) │
├─────────────────────────────────────────┤
│  AI Orchestrator                         │
│  의도 → 계획 → 자산탐색 → 위임 → 결과통합   │
├─────────────────────────────────────────┤
│  AI Agents (워커 계약 준수)                │
│  Data Readiness · Dataset Engineering    │
│  Analytics · Prediction · Viz & Report   │
├─────────────────────────────────────────┤
│  Metadata & Registry                     │
│  Dataset · Pipeline · Model · Tool · Viz │
├─────────────────────────────────────────┤
│  Execution Engines (기존 플랫폼)          │
│  ingestion · map-mst · data-transform    │
│  pipeline · ai-forecast · 시각화 렌더     │
├─────────────────────────────────────────┤
│  Platform Foundation                     │
│  PostgreSQL · 스케줄러 · 권한 · 로그      │
└─────────────────────────────────────────┘
```

| 계층 | 책임 | 비책임(금지) |
|---|---|---|
| **Presentation** | 대화·승인 카드·엔진 UI | 비즈니스 실행 로직 |
| **Orchestrator** | 의도·계획·위임 순서·결과 통합 | 수집 파라미터 조립, SQL 실행, 모델 학습 |
| **Agents** | 판단·도구 선택·propose 요약·해석 | DB 직접 쓰기, allowlist 밖 API |
| **Registry** | 자산 식별·검색·메타 | 실행 |
| **Engines** | 적재·매핑·가공·예측·렌더·스케줄 | 자연어 의도 해석 |
| **Foundation** | 저장·권한·감사 | — |

---

## 3. 책임 경계 규칙

### 3.1 Orchestrator

- **한다**: Intent 분류, Plan step 배열 생성, Registry 조회, Worker 호출, HITL 대기 조율, 최종 응답 구성
- **하지 않는다**: `build_collection_params` 수준의 도메인 파라미터 조립, `api-load` 직접 호출, 예측 모델 선택 세부 로직

### 3.2 Agents

- **한다**: 도메인 판단, allowlist API를 통한 조회, `proposal` 생성, 결과 해석 문구
- **하지 않는다**: confirm 없이 쓰기/실행, Registry에 없는 id 추측, 다른 에이전트 내부 호출(오케스트레이터만 위임)

### 3.3 Engines

- **한다**: 기존 `/api/ingestion`, `/api/visualization/map-mst`, `/api/data-transform`, `/api/pipeline`, `/api/ai-forecast*` 동작
- **하지 않는다**: LLM 호출, 대화 세션 관리(채팅 저장은 공용 DB를 쓰더라도 앱 마커로 구분)

### 3.4 Registry

- **한다**: 자산 목록·검색·메타 읽기 (및 향후 등록 절차)
- **하지 않는다**: 적재·학습 실행

---

## 4. 현재 자산 매핑

| 마스터 설계 | 현재 코드 | 계층 |
|---|---|---|
| 실행 엔진 — 수집 | `web/app/api/ingestion/*`, `/ingestion` UI | Engine |
| 실행 엔진 — 매핑 | `web/app/api/visualization/map-mst*` | Engine |
| 실행 엔진 — 가공 | `web/app/api/data-transform*` | Engine |
| 실행 엔진 — 파이프라인 | `web/app/api/pipeline*` | Engine |
| 실행 엔진 — 예측 | `web/app/api/ai-forecast*`, `ai-forecast-agent` | Engine (+ Agent 초안) |
| Data Readiness Agent | `web/app/api/data-agent/*` | Agent (초안, 매핑·가공까지 혼재) |
| Orchestrator | 없음 | 설계 후 구현 |
| Registry | 분산 테이블만 존재 | 스키마 설계 후 읽기 API |

---

## 5. 명시적 금지

1. 에이전트/오케스트레이터가 **엔진 allowlist 밖** HTTP·SQL로 상태를 바꾸기  
2. 오케스트레이터가 **수집·매핑 파라미터를 직접 생성**하기 (해당 Agent 위임)  
3. HITL 대상 쓰기를 **자동 승인**으로 우회하기 (관리자 명시 설정 없이)  
4. `/ingestion` UI를 AI로 **대체·삭제**하기 (엔진 조작면으로 유지)  
5. 로컬 LLM 미완성 상태에서 **운영 전제**로 툴콜 전환하기 (계약은 LLM 교체 가능해야 함)

---

## 6. LLM 전략과 계층

| 단계 | Orchestrator / Agent | 비고 |
|---|---|---|
| PoC | OpenAI 등 클라우드 (툴콜) | 마스터 설계서와 동일 |
| 조회·설명 | Ollama 가능 | 현재 data-agent와 동일 패턴 |
| 운영 | 로컬 LLM 수렴 | **워커 계약·allowlist는 모델 독립** |

---

## 7. 관련 설계 문서

| 문서 | 내용 |
|---|---|
| [ai-engine-allowlist.md](./ai-engine-allowlist.md) | 엔진 API allowlist |
| [ai-worker-contract.md](./ai-worker-contract.md) | 워커 입출력 계약 |
| [ai-agent-matrix.md](./ai-agent-matrix.md) | 에이전트별 책임 |
| [ai-catalog-schema.md](./ai-catalog-schema.md) | Registry 스키마 |
| [ai-orchestrator-fsm.md](./ai-orchestrator-fsm.md) | 오케스트레이터 상태머신 |

---

## 8. 변경 절차

계층·금지를 바꿀 때는 이 문서를 먼저 수정하고, allowlist·워커 계약·에이전트 매트릭스를 동기화한 뒤 코드를 변경한다.
