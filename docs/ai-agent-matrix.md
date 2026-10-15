# AI 에이전트 책임 매트릭스

> 전문 Agent 별 **판단 / 엔진 요청 / 금지** 와 현재 구현 상태.  
> 이행 중 혼재는 명시하고, 최종 분리를 목표로 한다.

관련: [ai-platform-layers.md](./ai-platform-layers.md) · [ai-engine-allowlist.md](./ai-engine-allowlist.md) · [ai-worker-contract.md](./ai-worker-contract.md)

상태: **구현됨** · **부분** · **설계만** · **없음** · **1차 제외**

---

## 0. 1차 구현 범위

| 구분 | WorkerId |
|---|---|
| **1차 포함** | `data_readiness`, `dataset_engineering` |
| **1차 제외** | `analytics`, `prediction`, `viz_report` |

제외 에이전트는 매트릭스·계층 문서에 남겨 두되, Orchestrator·워커 어댑터·카탈로그(`model`/`chart`) 연동은 **하지 않는다**.  
예측·시각화 요청이 오면 Orchestrator 가 `unknown`/안내 응답만 한다.

---

## 1. 총괄

| WorkerId | 마스터 단계 | 핵심 판단 | 주요 엔진 | 상태 |
|---|---|---|---|---|
| `data_readiness` | 수집 | 대상·준비상태·수집 제안 | ingestion, create-target-table, api-load | **부분** (`runDataReadinessWorker`) — **1차** |
| `dataset_engineering` | 전처리·데이터셋 | 매핑·가공 설계 | map-mst, data-transform | **부분** (`runDatasetEngineeringWorker`) — **1차** |
| `analytics` | 분석 | 방법 선택·해석 | analysis, series, (향후 SQL) | **없음** — **1차 제외** |
| `prediction` | 예측 | 모델 선택·실행 요청·해석 | ai-forecast* | **부분** — **1차 제외** (엔진·기존 UI만 유지) |
| `viz_report` | 시각화·리포트 | 차트/서술 구성 | charts, llm 서술 | **없음** — **1차 제외** |

---

## 2. Data Readiness (`data_readiness`)

### 한다
- 기관·통계 식별 (`search_statistic`)
- 파라미터 규격 조립 (`build_collection_params`) — 추측 금지
- 소스/그룹 등록·키 수정·그룹 설정 수정 제안
- 기관 안의 개별 API(`api_param_group`) 파라미터, 적재 테이블, merge SQL, 스케줄, 기간 파라미터 수정 제안
- 샘플 확인, `_LRD` 생성 제안, 적재 실행 제안
- 준비상태·실패 원인 설명 (로그/미리보기 기반)

### 하지 않는다
- 매핑·가공·파이프라인의 **최종 책임** (Dataset Engineering 워커 담당)
- 예측·대시보드 생성
- allowlist 밖 적재
- 기존 데이터 수집/시각화 **메뉴 코드 수정**

### 현재 도구 → 최종 소속

| 도구 | 최종 Agent | 이행 |
|---|---|---|
| search / build_params / list_sources / describe_source_config / list_db_meta / preview_api | Data Readiness | 유지 |
| propose_org_* / source / staging / collection_run | Data Readiness | 유지 |
| list_mappings / propose_mapping* | Dataset Eng | **이관 완료** (`dataset_engineering` workerId) |
| preview_transform / propose_transform* | Dataset Eng | **이관 완료** (`dataset_engineering` workerId) |

### 갭 (설계 후 도구 추가 후보)
- 적재 cancel
- PDF 추출·적재 (Phase 2)
- 수집 현황 요약 (ingestion-status)

---

## 3. Dataset Engineering (`dataset_engineering`)

### 한다
- 적재 테이블 → 시계열 매핑 설계 (날짜/값/freq/where)
- 가공 유형·설정 선택, preview 후 생성·실행 제안
- 수집+매핑+가공 **파이프라인** 정의·실행 제안
- (향후) SQL/Python ETL 생성 → 엔진 실행 요청 — Feature/Trusted Zone 은 카탈로그 이후

### 하지 않는다
- 외부 API 기관 등록·원천 적재 (Data Readiness)
- 모델 학습

### 상태
- 엔진: **있음** (기존 map-mst / data-transform — 미수정)
- Agent: **분리됨** — `runDatasetEngineeringWorker` + `/data-agent` 파사드에서 도구 소유 `workerId` 부여
- 파이프라인 propose 도구는 아직 없음 (다음 보강 후보)

---

## 4. Analytics (`analytics`)

### 한다
- 분석 방법 선택, 통계/상관 등 엔진 요청, 요인·결과 해석

### 하지 않는다
- 원천 수집, 임의 스키마 파괴적 DDL

### 상태
- **없음** — Text-to-SQL·analysis API 상세는 설계서 Phase 3 전개 시

### Stub 계약
- Request/Response 는 워커 계약과 동일
- 초기 `answer`: “Analytics Agent 미구현. 기존 시각화·분석 메뉴를 이용해 주세요.”

---

## 5. Prediction (`prediction`)

### 한다
- 예측 목표 해석, 시리즈/모델 후보 선택, 실행 요청, 성능·신뢰도 설명

### 하지 않는다
- 학습 알고리즘을 LLM 이 대체 계산
- 수집 파이프라인 구성

### 상태
- **부분** — `ai-forecast-agent` 를 워커 계약으로 감싸는 어댑터 필요
- 엔진 API 는 allowlist §5 에 점진 등록

---

## 6. Visualization & Report (`viz_report`)

### 한다
- 차트/대시보드 스펙 선택·생성 요청, 리포트 요약 서술, 사용자 응답 구성

### 하지 않는다
- 원천 적재, 모델 학습

### 상태
- **없음** — 설계서 Phase 1(리포트 서술) Quick Win 후보
- 초기는 예측/매핑 결과 위 **서술만** `answer` 로 제공 가능

---

## 7. Orchestrator 와의 관계

- Agent 끼리 **직접 호출 금지**. 항상 Orchestrator → Worker.
- 한 Plan step = 한 Worker 호출 (결과 mode 에 따라 다음 step 또는 HITL).
- 책임이 겹치면 **매트릭스를 먼저 수정**하고 도구를 옮긴다.

---

## 8. 분리 로드맵 (구현 시)

1. [x] Data Readiness 를 워커 계약으로 정규화  
2. [x] Dataset Eng 워커 신설 + 매핑·가공 도구 소유권 이관 — **1차 완료**  
3. 파이프라인 propose 도구 보강 (선택)  
4. ~~Prediction 어댑터~~ → **2차 이후**  
5. ~~VizReport / Analytics~~ → **2차 이후**  

코드 변경 전에 이 표의 “최종 Agent” 열을 업데이트한다.  
**주의:** 기존 데이터 수집·시각화 메뉴 및 엔진 라우트는 수정하지 않는다. AI 계층만 엔진 API를 호출한다.
