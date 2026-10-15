# AI 메타데이터 · 카탈로그 스키마 (Phase 0 최소)

> Orchestrator **Asset Discovery** 와 Agent 가 id 를 추측하지 않도록 하는 **읽기 중심** 카탈로그.  
> Feature Store / Trusted Zone 풀스펙은 범위 밖. 식별·검색·권한에 필요한 최소 필드만.

관련: [ai-platform-layers.md](./ai-platform-layers.md) · [ai-orchestrator-fsm.md](./ai-orchestrator-fsm.md)

---

## 1. 목표

- “어떤 데이터셋·매핑·파이프라인·모델이 있는가”를 **한 API** 로 탐색
- 출처는 **기존 테이블** (신규 마스터 테이블은 최소화; 뷰 또는 집계 API 권장)
- 쓰기는 당분간 엔진 UI / 기존 CRUD 가 수행. 카탈로그는 **반영(read model)**

---

## 2. 공통 레코드

```ts
type CatalogItem = {
  kind: CatalogKind;
  id: string;              // 안정적 문자열 (예: "source:12", "map:34")
  name: string;
  description?: string | null;
  tags?: string[];
  provider?: string | null; // bok, kosis, ...
  status?: string | null;   // active, disabled, ...
  updatedAt?: string | null; // ISO
  links?: { rel: string; id: string; kind: CatalogKind }[];
  raw?: Record<string, unknown>; // 디버그용 요약만, 비밀 제외
};

type CatalogKind =
  | "source"
  | "group"
  | "dataset"      // 논리 데이터셋 = 보통 group + target table
  | "mapping"
  | "transform"
  | "pipeline"
  | "model"
  | "tool"
  | "chart";
```

검색 API (예정):

```
GET /api/ai-catalog?kind=mapping&q=금리&dbSettingId=
GET /api/ai-catalog/:id
```

응답: `{ ok: true, items: CatalogItem[] }`

---

## 3. Kind 별 출처 매핑

| kind | 출처 | id 규칙 | 주요 필드 |
|---|---|---|---|
| `source` | `dp.api_source` | `source:{id}` | name, provider, base_url (api_key **제외**) |
| `group` | `dp.api_param_group` | `group:{id}` | name, source_id, target_table, schedule |
| `dataset` | group + target table 합성 | `dataset:group:{id}` | name, table, provider, sourceId, groupId |
| `mapping` | `dp.viz_map_mst` | `map:{map_id}` | series_name, source_table, date/value col, freq |
| `transform` | `dp.api_transform` | `transform:{id}` | name, type, source_map_id |
| `pipeline` | pipeline 테이블/API | `pipeline:{id}` | name, steps 요약 |
| `model` | forecast 모델 레지스트리(기존 위치 확인 후) | `model:{id}` | name, target series, metrics 요약 |
| `tool` | 정적 레지스트리(코드 상수) | `tool:{name}` | Agent 도구 이름·설명 |
| `chart` | visualization charts | `chart:{id}` | title, type |

`dataset` 은 물리 신규 테이블이 아니라 **논리 뷰**다. Orchestrator Plan 에는 `dataset` 또는 `mapping` 을 우선 올린다.

---

## 4. Orchestrator 사용 방식

1. Intent 이후 `discovering` 단계에서 `q` + kind 힌트로 검색  
2. 상위 N개를 `WorkerRequest.context.assets` 에 넣어 위임  
3. Worker 는 assets 의 id 를 파싱해 엔진 API 에 사용 (추측 금지)

예시:

```json
{
  "kind": "mapping",
  "id": "map:42",
  "name": "예금은행 수신금리"
}
```

---

## 5. 보안

- `api_key`, 토큰, 비밀번호 **카탈로그 응답 금지**
- 관리자 세션과 동일한 권한 게이트
- `raw` 에는 컬럼명·주기 등 비민감 메타만

---

## 6. 구현 순서 (설계 확정 후) — 1차

1. [x] `source` · `group` · `mapping` · `transform` 읽기 API  
2. [x] `pipeline`  
3. [x] 정적 `tool` 목록 (수집·전처리 도구만)  
4. [x] 검색(`q`) · kind 필터 · 페이징  

구현: `GET /api/ai-catalog`

**1차에서 하지 않음:** `model`, `chart` 카탈로그 연동 (예측·시각화 2차).

마이그레이션: **가능하면 VIEW + API**. 불가 시에만 `dp.ai_catalog_*` 캐시 테이블.

---

## 7. 미포함 (다음 단계)

- Feature Store, 데이터셋 버전 핀, 스키마 진화 이력  
- 비정형 문서 원문 카탈로그  
- 자동 lineage UI 전체  

본 스키마에 `links[]` 로 약한 lineage 만 표현한다 (group→mapping→transform).
