# AI 데이터 에이전트 — 데이터 수집 (현재 적용 정리)

> 자연어 대화로 "데이터 수집(기관→항목→파라미터→샘플→생성→테이블→수집→매핑→가공)"을 수행하는
> 에이전트. 기존 "데이터 수집" 메뉴가 사람이 UI에서 하던 일을, 만들어 둔 기능을 그대로 호출해 대화로 수행한다.
>
> 상태: **로컬 구현 완료 / git 미반영**. 좌측 네비 "DB 설정" 아래 "AI 데이터 에이전트" 메뉴(`/data-agent`).
>
> 상위 설계(오케스트레이션·워커 계약): [ai-platform-README.md](./ai-platform-README.md) — 본 문서는 Data Readiness 현행 구현 정리.

---

## 1. 개요 / 설계 원칙

| 항목 | 내용 |
|---|---|
| LLM 엔진 | **OpenAI gpt-4o-mini**(실행 가능) + **Ollama qwen3:8b**(조회/설명 전용, 전환 가능) |
| 실행 방식 | **계획 제시 후 승인** — 모든 쓰기/실행은 요약 카드 → [확인 실행] 눌러야 동작 |
| 대화 유지 | **세션별 저장(GPT식)** — 왼쪽 세션 목록, 새로고침/이동 후 복원, "새 대화" |
| 인증 | 관리자 쿠키 세션(`admin`)만 사용 가능 |
| 기존 코드 | 대부분 **기존 엔드포인트를 호출만** 함. 기존 UI 마법사/라우트 로직은 미수정 |

핵심 개념: **소스(source) = 기관**(예: 한국은행), **그룹(group) = 데이터셋/통계**(예: 예금은행 수신금리).
하나의 기관(소스) 아래 여러 데이터셋(그룹)을 등록한다.

---

## 2. 전체 수집 흐름 (에이전트가 수행하는 단계)

1. **항목 검색** — `search_statistic(provider, query)` → {code, name, cycle}
2. **기간/식별자 확인** — 시작·종료일(YYYY-MM-DD), (KOSIS는 활용신청 통계표 ID)
3. **파라미터 조립** — `build_collection_params` → 규격에 맞는 params + baseUrl (추측 금지)
4. **소스(기관)+그룹(데이터셋) 등록** — `propose_source_registration`
5. **groupId 확인** — `list_sources`
6. **샘플 확인** — `preview_api` → 추론 컬럼 + 상위 5행 샘플
7. **적재 테이블 생성/연결** — `propose_staging_table` (`*_LRD` 자동 생성 + 그룹 연결)
8. **수집(적재) 실행** — `propose_collection_run`
9. **매핑 생성** — `propose_mapping` (날짜/값 컬럼, dateFormat/freq)
10. **매핑 시계열 생성** — `propose_mapping_run`
11. **(선택) 데이터 가공** — `preview_transform` → `propose_transform` → `propose_transform_run`

> 각 단계는 개별 확인(승인)을 받는다. 한 번에 하나씩 제안.

---

## 3. 도구(Tool) 목록

### 조회 (자동 실행, 확인 불필요)
| 도구 | 기능 |
|---|---|
| `search_statistic(provider, query)` | 기관 통계/지표 검색 (전 9개 기관) |
| `build_collection_params(provider, code, cycle, startDate, endDate, userStatsId?)` | 수집 파라미터 규격 조립 (kosis/bok/fred/custom) |
| `list_sources()` / `list_mappings()` | 등록된 소스·매핑 목록 |
| `describe_source_config(sourceId?, groupId?)` | 기관/그룹 설정 상세(파라미터 role, 테이블, merge SQL, 스케줄) 조회 |
| `list_db_meta(action, schema?, table?)` | DB 스키마/테이블/컬럼 메타 조회 |
| `preview_api(sourceId?, groupId?, sourceName?, groupName?)` | ID 또는 기관명+API명으로 대상 확인 후 API 1회 호출 → 컬럼 + 상위 샘플 행 |
| `generate_staging_table_sql(sourceId?, groupId?, sourceName?, groupName?, schema, table)` | 샘플 컬럼 기반 `_LRD` CREATE TABLE 문 생성(비실행) |
| `preview_transform(sourceMapId, transformType, config)` | 가공 결과 미리보기(저장 안 함) |

### 실행/생성 (propose_* → 사용자 확인 후 실행)
| 도구 | 기능 |
|---|---|
| `propose_org_registration` | 기관 등록(기관명·URL·API키·enabled·키 메타) |
| `propose_org_key_update` | 기존 기관 설정 수정(API 키/URL/enabled/키 메타) |
| `propose_source_registration` | 소스(기관)+그룹(데이터셋)+파라미터 등록 |
| `propose_staging_table` | `_LRD` 적재 테이블 생성 + 그룹 연결 |
| `propose_group_update` | 기존 수집 그룹명·파라미터 전체 수정 |
| `propose_group_target_table` | 기존 수집 그룹 적재 테이블·truncate·merge SQL 설정 |
| `propose_group_schedule` | 기존 수집 그룹 스케줄 수정/비활성화 |
| `propose_refresh_periods` | 특정 기관의 특정 API 기간 파라미터(start/end) 갱신 |
| `propose_collection_run` | 데이터 수집(적재) 실행 |
| `propose_mapping` / `propose_mapping_run` | 매핑 생성 / 시계열 생성·재생성 |
| `propose_transform` / `propose_transform_run` | 가공 생성 / 실행 |

- `mergeSql(target_merge_sql)`은 **단일 SQL 문만 허용**하며, `DROP/TRUNCATE/ALTER/CREATE/GRANT/REVOKE` 포함 SQL은 차단한다.
- 테이블/SQL 설정 전 `list_db_meta(columns)`로 대상 컬럼을 먼저 확인한다.
- API 등록 결과는 `sourceId`와 생성된 `groupId`를 함께 반환·저장하며, 이후 샘플/테이블/적재 작업에서 재사용한다.
- 실제 도구 호출 없이 “잠시만 기다려 주세요”라고 종료하지 않는다. 필요한 조회는 같은 응답의 도구 루프 안에서 완료한다.
- 테이블 CREATE 권한이 없으면 자동 생성은 실패 처리하되, 샘플 컬럼으로 만든 실행 가능한 DDL을 응답에 포함한다.

---

## 4. 기관(provider)별 지원 범위

| 기관 | provider | 검색 | 기관/소스 등록 | 파라미터 자동조립 | 테이블 자동생성 | 수집·매핑·가공 |
|---|---|:--:|:--:|:--:|:--:|:--:|
| 통계청 | kosis | ✅ | ✅ | ✅ | ✅ | ✅ |
| 한국은행 | bok | ✅ | ✅ | ✅ | ✅ | ✅ |
| 미국연준 | fred | ✅ | ✅ | ✅ | ✅ | ✅ |
| 공공데이터포털 | datagokr | ✅ | ✅ | ⚠️(특수 제외) | ✅ | ✅ |
| 커스텀 | custom | – | ✅ | ✅(수동) | ✅ | ✅ |
| 한국거래소 | krx | ✅ | ✅ | ❌ | ❌ | 기존 화면 |
| OECD | oecd | ✅ | ✅ | ❌ | ❌ | 기존 화면 |
| 세계은행 | worldbank | ✅ | ✅ | ❌ | ❌ | 기존 화면 |
| yfinance | yfinance | ✅ | ✅ | ❌ | ❌ | 기존 화면 |
| UN인구 | undp | ✅ | ✅ | ❌ | ❌ | 기존 화면 |

- **검색**: 전 기관. 통계목록 테이블 `dp.api_stat_list_*` 조회(kosis/fred/datagokr는 서버검색, 나머지는 전체목록→필터, undp는 외부 API).
- **파라미터 자동조립·테이블 자동생성**: 표준 JSON 응답 기관(**kosis·bok·fred·custom**, 테이블은 datagokr 포함)만. 그 외는 검색·등록은 되지만 수집/테이블은 기존 "데이터 수집" 화면 이용 안내.

### provider별 조립 규칙 (build_collection_params)
| provider | 통계코드 키 | 주기 키 | 시작/종료 키 | 날짜 형식 |
|---|---|---|---|---|
| kosis | `userStatsId`(query,4) | `prdSe`(5) | `startPrdDe`/`endPrdDe`(6/7) | YYYYMM 등(주기별) |
| bok | `statCode`(path,5) | `period`(6) | `apiStart`/`apiEnd`(7/8) | YYYYMM 등(주기별) |
| fred | `series_id`(query,5) | `frequency`(6) | `observation_start`/`_end`(7/8) | ISO(YYYY-MM-DD) |

정적 파라미터(method/format/lang/file_type 등)는 등록 시 **provider 템플릿에서 자동 병합**된다.

---

## 5. 신규 파일 / 엔드포인트

### 신규 백엔드 (`web/app/api/data-agent/`)
- `chat/route.ts` — 메인 대화(툴 루프 OpenAI / Ollama 조언), 세션·메시지 저장
- `confirm/route.ts` — 대기 중 제안(token) 실행/취소
- `session/route.ts` — 세션 목록·메시지 조회(`app='data-agent'` 마커 필터)
- `create-target-table/route.ts` — `_LRD` 테이블 생성(컬럼·샘플 추론)
- `_lib/tools.ts` — 도구 스키마·조회 실행·승인 실행부 (`DATA_READINESS_TOOLS` / `DATASET_ENGINEERING_TOOLS` 분리)
- `_lib/tool-loop.ts` — OpenAI function-calling 루프 (propose 시 workerId 부여)
- `_lib/worker.ts` — Data Readiness 워커 (수집 도구만)
- `_lib/dataset-worker.ts` — Dataset Engineering 워커 (매핑·가공 도구만)
- `_lib/session-worker.ts` — `/data-agent` 통합 파사드 (두 워커 도구 합본, workerId 구분)
- `_lib/provider-request.ts` — provider별 파라미터 조립(마법사 로직 미러)
- `_lib/llm.ts` · `_lib/auth.ts` · `_lib/internal.ts` · `_lib/system-prompt.ts`

### 공통 AI 계약
- `web/app/api/ai-orchestrator/_lib/worker-contract.ts` — Orchestrator 가 호출할 워커 공통 계약(`answer`/`proposal`/`needs_input`/`error`) 타입

### 신규 UI
- `web/app/(platform)/data-agent/page.tsx` — 채팅 + 세션 사이드바 + 승인 카드

### 기존 파일 편집(최소·추가만)
- `web/app/(platform)/layout.tsx` — 네비에 "AI 데이터 에이전트" 1줄 추가
- `web/app/api/ingestion/load-runner.ts` — **새 export 함수** `createTargetTableFromApiPreview` 추가(+샘플 행 반환). 기존 `executeApiGroupLoad` 등은 미수정.

### 신규 API 엔드포인트
- `POST /api/data-agent/chat`, `POST /api/data-agent/confirm`, `GET /api/data-agent/session`, `POST /api/data-agent/create-target-table`

### 재사용하는 기존 엔드포인트
- `GET /api/ingestion/{provider}-stat-(search|list)` (통계 검색)
- `POST/PATCH /api/ingestion/api-config` (소스·그룹·파라미터, 기관 키) — 템플릿 파라미터 자동 병합
- `POST /api/ingestion/api-load` (수집 실행 → `executeApiGroupLoad`)
- `POST /api/visualization/map-mst` · `/[mapId]/generate` · `/[mapId]/preview` (매핑)
- `POST /api/data-transform` · `/preview` · `/[id]/run` (가공, 입력=map_id)

---

## 6. 계획→승인 프로토콜

- 쓰기/실행 도구는 실제로 실행하지 않고 **PendingAction**(token, type, args, summary)을 만들어 반환.
- 채팅 응답이 `proposal` 모드면 UI가 **[확인 실행]/[취소] 카드**를 표시.
- `POST /api/data-agent/confirm {sessionId, token, decision}` → token 단일사용·재검증 후 실제 실행.
- 상태는 채팅 메시지 `metadata.pendingAction.status`(pending→executed/cancelled/failed)로 관리.
- 현재 응답은 기존 UI 호환 필드(`mode`, `text`, `pendingAction`)를 유지하면서, 워커 계약 필드
  `workerId`, `contractVersion`, `workerResponse` / `confirmResponse` 를 함께 반환한다.
- 매핑·가공 propose 는 `workerId='dataset_engineering'`, 수집 propose 는 `workerId='data_readiness'`.
- **기존 데이터 수집·시각화 메뉴/엔진 라우트는 수정하지 않음.** AI는 기존 API를 호출만 한다.
- 저장은 기존 `dp.ai_forecast_chat_*`(세션/메시지) 테이블 재사용 → **신규 테이블/마이그레이션 없음**.

---

## 7. 건드리는 데이터 모델

| 테이블 | 용도 |
|---|---|
| `dp.api_source` | 기관(소스) — 기관명·provider·base_url·api_key |
| `dp.api_param_group` | 데이터셋(그룹) — 대상 테이블(`*_LRD`)·스케줄 |
| `dp.api_param` | 요청 파라미터 |
| `<schema>.<name>_LRD` | 적재 대상 테이블(자동 생성) |
| `dp.viz_map_mst` / `dp.viz_map_data` | 매핑 정의 / 시계열 |
| `dp.api_transform` | 가공 정의(입력=매핑 map_id) |
| `dp.ai_forecast_chat_*` | 채팅 세션/메시지(공유, `app='data-agent'` 마커) |

---

## 8. 적용된 주요 버그 수정

- **빈 API 키 등록 거부** → 이미 등록된 기관은 센티넬 값으로 검증 통과(기존 키 보존).
- **소스 재사용 로직** → 통계명을 소스 이름에 넣어도 **provider로 기존 기관을 찾아 재사용**(소스=기관, 그룹=데이터셋).
- **전 기관 통계 검색** → `search_statistic` KOSIS 전용 → 9개 기관 확장.
- **세션 유지** → 새로고침/이동 후 대화 복원 + 세션 목록.
- **UI 레이아웃** → flex `min-w-0`로 사이드바/채팅 폭 정상화.

---

## 9. 환경변수 / 실행

- 필요: `OPENAI_API_KEY`(+`OPENAI_MODEL`), `OLLAMA_URL`/`OLLAMA_MODEL`(선택), DB(`DP_DB_*`).
- 로컬 실행: `npm run dev` → 로그인 → 좌측 "AI 데이터 에이전트".

---

## 10. 알려진 한계 / 다음 단계

- **자동 파라미터 조립·테이블 생성은 핵심 기관(kosis·bok·fred·custom)만**. oecd·krx·undp·worldbank·datagokr(특일정보 등)는 검색·등록만 되고 수집/테이블은 기존 화면 이용.
- `provider-request.ts`는 기존 마법사(`UserApiRegistrationModal`)의 파라미터 조립을 **복제(미러)** — 마법사 규격 변경 시 **수동 동기화 필요(drift)**. 향후 마법사를 이 모듈로 리팩터하면 해소.
- 샘플 확인은 "등록 후"에 이뤄짐(마법사는 등록 전) — 잘못 등록 시 되돌리기 필요할 수 있음(등록은 가벼움).
- 향후: 나머지 기관 파라미터 조립 확장, 파이프라인/스케줄 연동, 예측·시각화 단계(전체 아키텍처의 후속).
