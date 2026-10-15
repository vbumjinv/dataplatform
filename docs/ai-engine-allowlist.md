# AI 엔진 API Allowlist

> AI Agent / Orchestrator 가 **호출해도 되는** 기존 실행 엔진 API 목록.  
> 목록에 없는 쓰기는 금지. 읽기 API도 가능하면 이 표에 등록한다.

관련: [ai-platform-layers.md](./ai-platform-layers.md) · [ai-worker-contract.md](./ai-worker-contract.md)

범례: **R**=읽기(자동 가능) · **W**=쓰기/실행(**HITL proposal 필수**) · **A**=담당 에이전트

---

## 1. 수집 (ingestion)

| API | 메서드 | R/W | A | 용도 |
|---|---|---|---|---|
| `/api/ingestion/api-config` | GET | R | DataReadiness | 소스·그룹 목록 |
| `/api/ingestion/api-config` | POST/PATCH | W | DataReadiness | 기관·그룹·파라미터·키·테이블연결·스케줄 |
| `/api/ingestion/*-stat-search` / `*-stat-list` | GET | R | DataReadiness | 통계/지표 검색 |
| `/api/ingestion/undp-indicator-list` 등 | GET | R | DataReadiness | 메타 목록 |
| `/api/ingestion/yfinance-preview` | GET/POST | R | DataReadiness | yfinance 미리보기 |
| `/api/collect` | (기존) | R | DataReadiness | 연결/응답 미리보기 |
| `/api/data-agent/create-target-table` | POST | W | DataReadiness | `_LRD` 생성·그룹 연결 |
| `/api/ingestion/api-load` | POST | W | DataReadiness | 적재 실행 |
| `/api/ingestion/api-load/cancel` | POST | W | DataReadiness | 적재 중단 |
| `/api/ingestion/db-meta` | POST | R | DataReadiness / DatasetEng | 스키마·테이블·컬럼 메타 |

### PDF (Phase 2 까지는 Agent 제한)

| API | R/W | A | 비고 |
|---|---|---|---|
| `/api/ingestion/pdf-extract` · `pdf-refine` | R/W | DataReadiness (향후) | 스키마 검증 게이트 후 allow |
| `/api/ingestion/pdf-load` | W | DataReadiness (향후) | HITL |
| `/api/ingestion/pdf-itemtrade/*` | R/W | DataReadiness (향후) | HITL · 스케줄 포함 |

**현재 구현 범위**: data-agent 는 API 정형 수집 중심. PDF 는 엔진만 존재, Agent 도구 미노출.

---

## 2. 매핑 (visualization / map)

| API | 메서드 | R/W | A | 용도 |
|---|---|---|---|---|
| `/api/visualization/map-mst` | GET | R | DatasetEng | 매핑 목록 |
| `/api/visualization/map-mst` | POST | W | DatasetEng | 매핑 생성 |
| `/api/visualization/map-mst/[mapId]` | PATCH/DELETE | W | DatasetEng | 수정·삭제 |
| `/api/visualization/map-mst/[mapId]/preview` | GET/POST | R | DatasetEng | 미리보기 |
| `/api/visualization/map-mst/[mapId]/generate` | POST | W | DatasetEng | 시계열 생성·재생성 |
| `/api/visualization/map-mst/[mapId]/cancel` | POST | W | DatasetEng | 취소 |
| `/api/visualization/map-mst/[mapId]/schedule` | POST/PATCH | W | DatasetEng | 매핑 스케줄 |
| `/api/visualization/map-columns` · `map-targets` | GET | R | DatasetEng | 컬럼·대상 메타 |
| `/api/visualization/map-status` | GET | R | DatasetEng / Orch | 상태 조회 |

> **이행 기간**: 현재 `data-agent` 가 매핑 propose 를 포함. 설계상 최종 담당은 **Dataset Engineering**. 분리 전까지는 DataReadiness 가 DatasetEng 도구를 **임시 대행**한다고 표기.

---

## 3. 가공 (data-transform)

| API | 메서드 | R/W | A | 용도 |
|---|---|---|---|---|
| `/api/data-transform` | GET | R | DatasetEng | 가공 정의 목록 |
| `/api/data-transform` | POST | W | DatasetEng | 가공 생성 |
| `/api/data-transform/[id]` | PATCH/DELETE | W | DatasetEng | 수정·삭제 |
| `/api/data-transform/preview` | POST | R | DatasetEng | 미리보기(비저장) |
| `/api/data-transform/[id]/run` | POST | W | DatasetEng | 실행 |
| `/api/data-transform/[id]/runs` | GET | R | DatasetEng | 실행 이력 |

---

## 4. 파이프라인

| API | 메서드 | R/W | A | 용도 |
|---|---|---|---|---|
| `/api/pipeline` | GET/POST | R/W | DatasetEng | 정의 목록·생성 |
| `/api/pipeline/[pipelineId]` | GET/PATCH/DELETE | R/W | DatasetEng | 조회·수정·삭제 |
| `/api/pipeline/[pipelineId]/run` | POST | W | DatasetEng | 즉시 실행 |
| `/api/pipeline/[pipelineId]/progress` | GET | R | DatasetEng | 진행 |
| `/api/pipeline/[pipelineId]/cancel` | POST | W | DatasetEng | 취소 |
| `/api/pipeline/[pipelineId]/runs` | GET | R | DatasetEng | 이력 |
| `/api/visualization/pipeline-status` | GET | R | Orch / DatasetEng | 현황 |

---

## 5. 예측 (forecast)

| API | R/W | A | 용도 |
|---|---|---|---|
| `/api/ai-forecast-agent/chat/stream` · `session` · `run` | R/W | Prediction | 대화·실행 (워커 어댑터로 감쌈) |
| `/api/ai-forecast/run` · `kospi-predict` 등 | W | Prediction | 엔진 직접 실행 시 HITL |
| `/api/ai-forecast/series-list` · `series-data` | R | Prediction / Analytics | 시리즈 조회 |
| `/api/ai-forecast-llm/run` | R/W | Prediction / VizReport | 서술·해석 |

세부 예측 API 는 Prediction Agent 상세 설계 시 이 표에 행을 추가한다. **신규 추가 전엔 Orchestrator 가 직접 호출하지 않는다.**

---

## 6. 시각화·현황 (읽기 위주)

| API | R/W | A | 용도 |
|---|---|---|---|
| `/api/visualization/charts*` | R/W | VizReport | 차트 정의·조회 |
| `/api/visualization/series*` | R | VizReport / Analytics | 시계열 |
| `/api/visualization/analysis*` | R/W | Analytics | 분석 정의 |
| `/api/visualization/ingestion-status` | R | Orch / DataReadiness | 수집 현황 |

차트·대시보드 **생성 W** 는 VizReport Agent 설계·HITL 확정 후 활성화.

---

## 7. AI 내부 (엔진 아님)

| API | 역할 |
|---|---|
| `/api/data-agent/chat` · `confirm` · `session` | Data Readiness 워커 (이행 중) |
| `/api/ai-orchestrator/*` (예정) | Orchestrator |
| `/api/ai-catalog/*` (예정) | Registry 읽기 |

이들은 allowlist “엔진”이 아니라 **AI 계층**이다.

---

## 8. 등록·변경 규칙

1. 새 엔진 API 를 Agent 가 쓰려면 **이 문서에 행 추가** 후 도구 스키마에 연결한다.  
2. W 는 기본 HITL. 예외(자동 스케줄러 등)는 “사람 승인이 아닌 시스템 트리거”로 엔진 측에 두고 Agent 경로와 분리한다.  
3. data-agent `tools.ts` 의 `runReadTool` / `executeAction` 이 호출하는 경로 ⊆ 이 allowlist.

---

## 9. 현재 data-agent 와의 대응

| 도구 | Allowlist 대상 |
|---|---|
| `search_statistic` | `*-stat-search` / `*-stat-list` |
| `build_collection_params` | (로컬 조립, HTTP 없음 — 엔진 규격 미러) |
| `list_sources` / `preview_api` | `api-config` GET · collect/preview |
| `list_mappings` | `map-mst` GET |
| `preview_transform` | `data-transform/preview` |
| `propose_org_*` / `propose_source_registration` | `api-config` POST/PATCH |
| `propose_staging_table` | `create-target-table` |
| `propose_collection_run` | `api-load` |
| `propose_mapping*` | `map-mst` · `generate` |
| `propose_transform*` | `data-transform` · `run` |
