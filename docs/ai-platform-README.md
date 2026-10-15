# AI 플랫폼 설계 문서 인덱스

마스터 설계서 기준으로 **설계 우선** 산출물. 구현은 Go/No-Go 통과 후.

| 문서 | 내용 | Design Phase |
|---|---|---|
| [ai-platform-layers.md](./ai-platform-layers.md) | 계층·경계·금지 | D1 |
| [ai-engine-allowlist.md](./ai-engine-allowlist.md) | 엔진 API allowlist | D2 |
| [ai-worker-contract.md](./ai-worker-contract.md) | 워커 입출력·HITL | D3 |
| [ai-agent-matrix.md](./ai-agent-matrix.md) | 에이전트 책임·이관 | D4 |
| [ai-catalog-schema.md](./ai-catalog-schema.md) | 카탈로그 최소 스키마 | D5 |
| [ai-orchestrator-fsm.md](./ai-orchestrator-fsm.md) | 오케스트레이터 상태머신 | D6 |
| [ai-data-agent.md](./ai-data-agent.md) | 현재 Data Readiness 구현 정리 | (현행) |
| [Whole_Architecture.png](./Whole_Architecture.png) | 전체 아키텍처 도 | (참조) |

## Go/No-Go (설계 완료 체크)

- [x] D1 계층·금지 명시
- [x] D2 allowlist 초안
- [x] D3 워커 계약
- [x] D4 에이전트 매트릭스 (혼재·이관 명시)
- [x] D5 카탈로그 스키마
- [x] D6 상태머신

## 1차 구현 범위 (확정)

**포함:** 데이터 수집(Data Readiness) + 전처리·데이터셋(Dataset Engineering: 매핑·가공·파이프라인)

**제외(나중):** Prediction · Visualization & Report · Analytics  
→ 의도 분류 시 해당 요청은 “아직 지원하지 않음 / 기존 메뉴 이용”으로 안내. 워커 stub·어댑터는 만들지 않음.

### 구현 순서

1. [x] Data Readiness 를 워커 계약(`answer|proposal|needs_input`)으로 정규화  
2. [x] Dataset Engineering 책임을 분리(또는 data-agent 내 도구 경계를 계약상 명확화) — 매핑·가공  
3. [x] 카탈로그 최소 읽기: `source` / `group` / `mapping` / `transform` / `pipeline` / `tool`  
4. [x] Orchestrator 골격: intent ∈ { `collection`, `dataset`, `mixed`(수집→전처리), `unknown` } 만  
5. [x] 통합 UI — 수집·전처리 전용 (`/ai-assistant`)
6. [x] 상태 기반 수집 워크플로 1차 — API 선택·draft sample·등록·테이블 설정·적재

예측·시각화 엔진/메뉴는 그대로 두되, AI 오케스트레이션 경로에는 연결하지 않는다.

### 구현 메모

- `web/app/api/ai-orchestrator/_lib/worker-contract.ts` 에 워커 계약 타입을 추가했다.
- `/api/data-agent/chat` 은 기존 응답 호환을 유지하면서 `workerId`, `contractVersion`, `workerResponse` 를 함께 반환한다.
- `/api/data-agent/confirm` 은 기존 응답 호환을 유지하면서 `confirmResponse` 를 함께 반환한다.
- 수집 도구 ↔ `data_readiness`, 매핑·가공 도구 ↔ `dataset_engineering` 로 분리했다.
  - `runDataReadinessWorker` / `runDatasetEngineeringWorker` 는 각자 도구만 노출.
  - `/data-agent` UI 는 `runDataAgentSessionWorker` 파사드로 둘 다 사용(사용자 UX 유지).
  - 기존 `/ingestion`, `/visualization` 메뉴·엔진 API 코드는 수정하지 않았다.
- `/api/ai-catalog` 읽기 API 를 추가했다.
  - 1차 kind: `source`, `group`, `dataset`, `mapping`, `transform`, `pipeline`, `tool`
  - `q`, `kind`, `limit`, `dbSettingId` 지원
  - `model`, `chart` 는 예측·시각화 2차 범위라 제외
- `/api/ai-orchestrator/chat` · `/api/ai-orchestrator/confirm` 골격을 추가했다.
  - 실무형 1차 라우팅: 점수 + 최근 대화 맥락 + 애매하면 되묻기
  - 지원 intent: `collection`, `dataset`, `mixed`, `unknown`
  - 예측·시각화·분석 요청은 1차 제외 안내
  - 수집/전처리 워커 위임 및 proposal/confirm 지원
  - `기간`, `시작일`, `종료일`, `방금 만든 항목` 같은 후속 질문은 최근 `workerId` / plan intent 를 우선
- `/ai-assistant` 최소 UI 를 추가했다.
  - 기존 좌측 메뉴는 수정하지 않음(직접 URL 접근)
  - 오케스트레이터 chat/confirm 테스트용
  - 실행 proposal 승인/취소 카드 지원
  - 수집 단계 진행 상태와 revision 표시
  - 새로고침 시 `/api/ai-orchestrator/session`에서 메시지·pending action·활성 workflow 복원
- 수집 장기 작업은 `dp.ai_collection_workflow`에 전용 JSONB 상태로 저장한다.
  - 세션당 활성 workflow 1개
  - optimistic revision 검증으로 중복 확인/동시 갱신 방지
  - API 키는 workflow 상태에 저장하지 않으며 응답에서도 민감 파라미터를 마스킹
- `/api/data-agent/preview-draft`는 API 그룹 등록 전에 샘플을 확인한다.
  - 기존 기관의 서버측 인증정보만 사용
  - `bok`·`kosis`·`fred`의 HTTPS host allowlist 적용
  - 실제 적재와 같은 URL 조립·응답 파싱 헬퍼 재사용
- 배포 전 `web/db/migrations/20260729_ai_collection_workflow.sql` 적용이 필요하다.
- `list_sources` 조회 결과에 그룹별 파라미터 요약을 포함했다.
  - 기간/주기 확인용
  - API 키·토큰 등 민감 파라미터 값은 `[REDACTED]`
