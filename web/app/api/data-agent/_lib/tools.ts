import {
  DATA_READINESS_WORKER_ID,
  DATASET_ENGINEERING_WORKER_ID,
  type WorkerId,
} from "@/app/api/ai-orchestrator/_lib/worker-contract";
import { internalFetch } from "./internal";
import type { OpenAiTool } from "./llm";
import { buildCollectionParams } from "./provider-request";

export type ToolContext = { request: Request; dbSettingId: number | null };

const dbq = (dbSettingId: number | null, sep: "?" | "&" = "?") =>
  dbSettingId ? `${sep}dbSettingId=${dbSettingId}` : "";

// 기관별 통계목록/검색 엔드포인트 매핑. serverSearch=true 는 q= 서버검색, false 는
// 전체목록을 받아 클라이언트에서 query 로 필터. code/name/extra 는 정규화용 필드명.
const STAT_ENDPOINTS: Record<
  string,
  { base: string; serverSearch: boolean; code: string; name: string; extra: string[] }
> = {
  kosis: {
    base: "/api/ingestion/kosis-stat-search",
    serverSearch: true,
    code: "stat_code",
    name: "stat_name",
    extra: ["stat_id", "cycle", "vw_cd"],
  },
  fred: {
    base: "/api/ingestion/fred-stat-search",
    serverSearch: true,
    code: "stat_code",
    name: "node_name",
    extra: ["cycle"],
  },
  datagokr: {
    base: "/api/ingestion/datagokr-stat-list",
    serverSearch: true,
    code: "stat_code",
    name: "stat_name",
    extra: ["org_name"],
  },
  bok: {
    base: "/api/ingestion/bok-stat-list",
    serverSearch: false,
    code: "stat_code",
    name: "stat_name",
    extra: ["cycle", "org_name"],
  },
  krx: {
    base: "/api/ingestion/krx-stat-list",
    serverSearch: false,
    code: "api_id",
    name: "api_name",
    extra: ["category_name", "cycle"],
  },
  oecd: {
    base: "/api/ingestion/oecd-stat-list",
    serverSearch: false,
    code: "data_key",
    name: "indicator_name",
    extra: ["flow_ref", "ref_area", "category_name"],
  },
  worldbank: {
    base: "/api/ingestion/worldbank-stat-list",
    serverSearch: false,
    code: "indicator_code",
    name: "indicator_name",
    extra: ["country_code", "country_name"],
  },
  yfinance: {
    base: "/api/ingestion/yfinance-stat-list",
    serverSearch: false,
    code: "ticker",
    name: "item_name",
    extra: ["category_name"],
  },
  undp: {
    base: "/api/ingestion/undp-indicator-list",
    serverSearch: false,
    code: "id",
    name: "name",
    extra: ["topic_name"],
  },
};
export const STAT_PROVIDERS = Object.keys(STAT_ENDPOINTS);

// 모델에 노출되는 도구 스키마 (READ + propose_*)
export const AGENT_TOOLS: OpenAiTool[] = [
  {
    type: "function",
    function: {
      name: "list_sources",
      description: "등록된 API 소스와 그룹(수집 설정) 목록을 조회한다.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_source_config",
      description:
        "source/group 설정을 상세 조회한다. 기관 기본정보, 파라미터(role 포함), 테이블 설정(_LRD/merge SQL), 스케줄을 함께 확인할 때 사용한다.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_db_meta",
      description: "DB 메타데이터(스키마/테이블/컬럼)를 조회한다. 테이블 설정/SQL 작성 전에 확인한다.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["schemas", "tables", "columns"] },
          schema: { type: "string" },
          table: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_mappings",
      description: "등록된 시계열 매핑 목록을 조회한다.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_statistic",
      description:
        "기관(provider)의 통계/지표 목록을 검색한다. 반환: {code, name, ...}. 기관 매핑 — 통계청=kosis, 한국은행=bok, 한국거래소=krx, 공공데이터포털=datagokr, 미국연준=fred, OECD=oecd, 세계은행=worldbank, 야후금융/주식=yfinance, UN인구=undp.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: ["kosis", "bok", "krx", "datagokr", "fred", "oecd", "worldbank", "yfinance", "undp"],
          },
          query: { type: "string", description: "검색어(예: 소비자물가지수, 기준금리, GDP)" },
        },
        required: ["provider", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_api",
      description:
        "등록된 기관/API로 API를 1회 호출해 추론된 컬럼(header)과 상위 샘플 행(sample)을 확인한다. sourceId+groupId가 가장 정확하며, ID가 없으면 sourceName/groupName으로 대상을 찾는다.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
          sourceName: { type: "string", description: "기관명(예: 한국은행)" },
          groupName: { type: "string", description: "개별 API명(예: 예금은행 대출금리(잔액 기준))" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_api_draft",
      description:
        "API 그룹을 등록하기 전에 기존 기관(sourceId)의 인증정보와 전달한 동적 params로 1회 호출한다. 샘플 확인 후에만 등록을 제안한다.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer", description: "기존 기관 ID" },
          params: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
                location: { type: "string", enum: ["path", "query"] },
                order: { type: "integer" },
                role: { type: ["string", "null"] },
                encodeMode: { type: "string" },
              },
              required: ["key", "value", "location", "order"],
            },
          },
        },
        required: ["sourceId", "params"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_staging_table_sql",
      description:
        "등록된 API의 샘플 컬럼을 기준으로 _LRD 테이블 CREATE TABLE 문만 생성한다. DB에 실행하거나 저장하지 않는다. 테이블 생성 권한이 없거나 사용자가 생성문/DDL만 요청할 때 사용한다.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
          sourceName: { type: "string", description: "기관명(예: 한국은행)" },
          groupName: { type: "string", description: "개별 API명" },
          schema: { type: "string", default: "dp" },
          table: { type: "string", description: "_LRD로 끝나는 테이블명" },
        },
        required: ["table"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "build_collection_params",
      description:
        "핵심 기관(kosis/bok/fred/custom)의 수집 요청 파라미터를 규격에 맞게 조립한다. 통계코드·주기·날짜로부터 올바른 key/날짜형식을 만들어 반환하므로, 소스 등록 전 반드시 이 도구로 params 를 만들고 그 결과를 propose_source_registration 에 넣는다. (파라미터를 임의로 추측하지 말 것)",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["kosis", "bok", "fred", "custom"] },
          code: { type: "string", description: "search_statistic 결과의 code(통계코드/series_id)" },
          cycle: { type: "string", description: "주기(M/D/Q/A/Y). search 결과의 cycle 사용" },
          startDate: { type: "string", description: "수집 시작일 YYYY-MM-DD" },
          endDate: { type: "string", description: "수집 종료일 YYYY-MM-DD" },
          userStatsId: { type: "string", description: "kosis 전용: 활용신청 통계표 ID(있으면)" },
        },
        required: ["provider", "code", "startDate", "endDate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_transform",
      description:
        "가공(transform) 결과를 저장 없이 미리 계산해 상위 행을 확인한다. 입력은 매핑(map_id).",
      parameters: {
        type: "object",
        properties: {
          sourceMapId: { type: "integer", description: "입력 매핑 map_id" },
          transformType: {
            type: "string",
            enum: ["sql", "resample", "rate", "combine", "interpolate", "movavg", "python"],
          },
          config: { type: "object", description: "가공 타입별 설정" },
        },
        required: ["sourceMapId", "transformType", "config"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_org_registration",
      description:
        "기관(제공기관) 자체를 등록한다. 기관명/provider/baseUrl/apiKey/enabled 및 API 키 메타(apiKeyParamKey/location/order/encodeMode)까지 설정할 수 있으며 수집 그룹은 만들지 않는다. 실제 등록은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "기관 이름" },
          provider: { type: "string", description: "기관 식별자(예: kosis, bok, custom)" },
          baseUrl: { type: "string", description: "기관 API 기본 URL" },
          apiKey: { type: "string", description: "기관 API 키(없으면 빈 문자열)" },
          enabled: { type: "boolean", default: true },
          apiKeyParamKey: { type: "string", description: "예: authKey, serviceKey" },
          apiKeyLocation: { type: "string", enum: ["query", "path"], description: "API 키 위치" },
          apiKeyOrder: { type: "integer", description: "path/query 파라미터 순서" },
          apiKeyEncodeMode: { type: "string", description: "encode | raw" },
          isTemplate: { type: "boolean", default: false },
          summary: { type: "string", description: "등록 계획 한국어 요약" },
        },
        required: ["name", "provider", "baseUrl", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_org_key_update",
      description:
        "기존 기관(소스) 설정을 수정한다. sourceId 는 list_sources/describe_source_config 로 확인한다. name/provider/baseUrl/apiKey/enabled 와 API 키 메타(apiKeyParamKey/location/order/encodeMode)를 수정할 수 있다. 실제 수정은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          name: { type: "string", description: "기존 기관명(list_sources 값)" },
          provider: { type: "string" },
          baseUrl: { type: "string", description: "기존 기본 URL(list_sources 값)" },
          apiKey: { type: "string", description: "새 API 키(미변경 시 기존 값 유지)" },
          enabled: { type: "boolean" },
          apiKeyParamKey: { type: "string" },
          apiKeyLocation: { type: "string", enum: ["query", "path"] },
          apiKeyOrder: { type: "integer" },
          apiKeyEncodeMode: { type: "string" },
          summary: { type: "string", description: "수정 계획 한국어 요약(키 값은 노출 금지)" },
        },
        required: ["sourceId", "name", "provider", "baseUrl", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_source_registration",
      description:
        "새 API 소스+그룹+파라미터 등록을 제안한다. API 키도 여기서 함께 등록한다. 실제 등록은 사용자 확인 후 이루어진다.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "object",
            properties: {
              name: { type: "string" },
              provider: { type: "string", description: "예: kosis, bok, custom" },
              baseUrl: { type: "string" },
              apiKey: { type: "string", description: "제공기관 API 키(없으면 빈 문자열)" },
              enabled: { type: "boolean", default: true },
              apiKeyParamKey: { type: "string", description: "예: authKey, serviceKey" },
              apiKeyLocation: { type: "string", enum: ["query", "path"] },
              apiKeyOrder: { type: "integer" },
              apiKeyEncodeMode: { type: "string", description: "encode | raw" },
            },
            required: ["name", "provider", "baseUrl"],
          },
          groupName: { type: "string" },
          params: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
                location: { type: "string", enum: ["path", "query"] },
                order: { type: "integer" },
                encodeMode: { type: "string", description: "encode | raw 등" },
                role: {
                  type: "string",
                  description: "선택: period_type | start | end",
                },
              },
              required: ["key", "value", "location", "order"],
            },
          },
          summary: { type: "string", description: "등록 계획 한국어 요약" },
        },
        required: ["source", "groupName", "params", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_staging_table",
      description:
        "등록된 소스/그룹의 API 응답 컬럼으로 _LRD 적재 테이블을 생성하고 그룹에 연결하는 것을 제안한다. 실제 생성은 사용자 확인 후 이루어진다. 테이블명은 _LRD 로 끝나야 한다.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
          schema: { type: "string", default: "dp", description: "기본 dp(관례)" },
          table: { type: "string", description: "_LRD 로 끝나는 테이블명" },
          summary: { type: "string", description: "생성 계획 한국어 요약" },
        },
        required: ["sourceId", "groupId", "table", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_group_update",
      description:
        "기존 수집 그룹의 이름과 파라미터 전체를 수정한다. 기존 파라미터가 교체되므로 list_sources 로 현재 params 를 확인한 뒤 전체 params 를 전달한다. 실제 수정은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
          groupName: { type: "string" },
          params: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
                location: { type: "string", enum: ["path", "query"] },
                order: { type: "integer" },
                encodeMode: { type: "string", description: "encode | raw 등" },
                role: { type: "string", description: "period_type | start | end 등" },
              },
              required: ["key", "value", "location", "order"],
            },
          },
          summary: { type: "string", description: "수정 계획 한국어 요약" },
        },
        required: ["sourceId", "groupId", "groupName", "params", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_group_target_table",
      description:
        "기존 수집 그룹의 적재 대상 테이블 설정을 수정한다. _LRD 테이블, truncate 여부, 최종 반영 merge SQL(target_merge_sql)을 설정할 수 있다. 실제 수정은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
          schema: { type: "string", default: "dp" },
          table: { type: "string", description: "_LRD 로 끝나는 테이블명" },
          truncate: { type: "boolean", default: false },
          mergeSql: { type: "string", description: "선택: 최종 반영 SQL" },
          summary: { type: "string", description: "테이블 설정 계획 한국어 요약" },
        },
        required: ["sourceId", "groupId", "table", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_group_schedule",
      description:
        "기존 수집 그룹의 스케줄을 수정한다. interval 또는 cron 을 설정하거나 비활성화한다. 실제 수정은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
          enabled: { type: "boolean" },
          type: { type: "string", enum: ["interval", "cron"], default: "interval" },
          intervalMinutes: { type: "integer", description: "interval 스케줄 분 단위" },
          cronExpr: { type: "string", description: "cron 스케줄 표현식" },
          summary: { type: "string", description: "스케줄 수정 계획 한국어 요약" },
        },
        required: ["sourceId", "groupId", "enabled", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_refresh_periods",
      description:
        "특정 기관(sourceId)의 특정 API(groupId) 기간 파라미터(start/end)를 오늘 기준 상대일 규칙으로 갱신한다. 기관 전체나 전체 그룹이 아니라 API 1개만 대상으로 한다. 실제 수정은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer", description: "기관 sourceId" },
          groupId: { type: "integer", description: "기관 안의 개별 API groupId" },
          summary: { type: "string", description: "특정 API 기간 갱신 계획 한국어 요약" },
        },
        required: ["sourceId", "groupId", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_mapping",
      description:
        "적재 테이블을 시계열로 만드는 새 매핑 정의 생성을 제안한다. 실제 생성은 사용자 확인 후 이루어진다.",
      parameters: {
        type: "object",
        properties: {
          sourceOrg: { type: "string", description: "provider 라벨(예: kosis)" },
          apiName: { type: "string" },
          sourceTable: { type: "string", description: "스키마.테이블 (예: dp.CPI_LRD) — 적재 테이블은 기본 dp 스키마" },
          seriesName: { type: "string" },
          dateColumn: { type: "string" },
          valueColumn: { type: "string" },
          dateFormat: {
            type: "string",
            description: "예: YYYYMM, YYYYMMDD, YYYY, YYYYQM",
          },
          freq: { type: "string", enum: ["D", "M", "Q", "A", "Y"] },
          whereClause: { type: "string" },
          unitName: { type: "string" },
          summary: { type: "string", description: "생성 계획 한국어 요약" },
        },
        required: ["sourceTable", "seriesName", "dateColumn", "valueColumn", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_collection_run",
      description:
        "특정 소스/그룹의 데이터 수집(적재) 실행을 제안한다. 실제 실행은 사용자 확인 후 이루어진다.",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "integer" },
          groupId: { type: "integer" },
          truncate: { type: "boolean", default: false },
          summary: { type: "string", description: "실행 계획 한국어 요약" },
        },
        required: ["sourceId", "groupId", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_mapping_run",
      description:
        "특정 매핑의 시계열 데이터 생성/재생성을 제안한다. 실제 실행은 사용자 확인 후 이루어진다.",
      parameters: {
        type: "object",
        properties: {
          mapId: { type: "integer" },
          mode: { type: "string", enum: ["generate", "regenerate"], default: "generate" },
          summary: { type: "string", description: "실행 계획 한국어 요약" },
        },
        required: ["mapId", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_transform",
      description:
        "매핑(시계열)을 입력으로 새 가공(transform)을 생성 제안한다. 입력은 map_id. 실제 생성은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "가공 이름" },
          sourceMapId: { type: "integer", description: "입력 매핑 map_id" },
          transformType: {
            type: "string",
            enum: ["sql", "resample", "rate", "combine", "interpolate", "movavg", "python"],
          },
          config: {
            type: "object",
            description:
              "타입별 설정. rate{rateType:pop|yoy}, resample{targetUnit,agg}, movavg{window}, combine{secondMapId,op,divToPercent}, interpolate{targetUnit}, sql{sql,outputFreq}, python{code,secondMapId,outputFreq}",
          },
          outputName: { type: "string" },
          outputUnit: { type: "string" },
          outputFreq: { type: "string", description: "D/W/M/Q/Y" },
          summary: { type: "string", description: "생성 계획 한국어 요약" },
        },
        required: ["name", "sourceMapId", "transformType", "config", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_transform_run",
      description: "저장된 가공을 실행해 결과 시계열을 생성한다. 실제 실행은 사용자 확인 후.",
      parameters: {
        type: "object",
        properties: {
          transformId: { type: "integer" },
          summary: { type: "string", description: "실행 계획 한국어 요약" },
        },
        required: ["transformId", "summary"],
      },
    },
  },
];

// propose_* 도구명 → 실행 액션 타입
export const PROPOSE_MAP: Record<string, string> = {
  propose_org_registration: "register_org",
  propose_org_key_update: "update_org",
  propose_source_registration: "register_source",
  propose_staging_table: "create_staging_table",
  propose_group_update: "update_group",
  propose_group_target_table: "update_group_target_table",
  propose_group_schedule: "update_group_schedule",
  propose_refresh_periods: "refresh_periods",
  propose_mapping: "create_mapping",
  propose_collection_run: "run_collection",
  propose_mapping_run: "run_mapping",
  propose_transform: "create_transform",
  propose_transform_run: "run_transform",
};

// 도구 소유 워커 (기존 ingestion/visualization 엔진은 수정하지 않고 AI 계층만 분리)
export const DATA_READINESS_TOOL_NAMES = [
  "list_sources",
  "describe_source_config",
  "list_db_meta",
  "search_statistic",
  "preview_api",
  "preview_api_draft",
  "generate_staging_table_sql",
  "build_collection_params",
  "propose_org_registration",
  "propose_org_key_update",
  "propose_source_registration",
  "propose_staging_table",
  "propose_group_update",
  "propose_group_target_table",
  "propose_group_schedule",
  "propose_refresh_periods",
  "propose_collection_run",
] as const;

export const DATASET_ENGINEERING_TOOL_NAMES = [
  "list_mappings",
  "preview_transform",
  "propose_mapping",
  "propose_mapping_run",
  "propose_transform",
  "propose_transform_run",
] as const;

export const PROPOSE_WORKER_MAP: Record<string, WorkerId> = {
  propose_org_registration: DATA_READINESS_WORKER_ID,
  propose_org_key_update: DATA_READINESS_WORKER_ID,
  propose_source_registration: DATA_READINESS_WORKER_ID,
  propose_staging_table: DATA_READINESS_WORKER_ID,
  propose_collection_run: DATA_READINESS_WORKER_ID,
  propose_group_update: DATA_READINESS_WORKER_ID,
  propose_group_target_table: DATA_READINESS_WORKER_ID,
  propose_group_schedule: DATA_READINESS_WORKER_ID,
  propose_refresh_periods: DATA_READINESS_WORKER_ID,
  propose_mapping: DATASET_ENGINEERING_WORKER_ID,
  propose_mapping_run: DATASET_ENGINEERING_WORKER_ID,
  propose_transform: DATASET_ENGINEERING_WORKER_ID,
  propose_transform_run: DATASET_ENGINEERING_WORKER_ID,
};

export const DATA_READINESS_TOOLS: OpenAiTool[] = AGENT_TOOLS.filter((tool) =>
  (DATA_READINESS_TOOL_NAMES as readonly string[]).includes(tool.function.name),
);

export const DATASET_ENGINEERING_TOOLS: OpenAiTool[] = AGENT_TOOLS.filter((tool) =>
  (DATASET_ENGINEERING_TOOL_NAMES as readonly string[]).includes(tool.function.name),
);

export const workerIdForProposeTool = (
  toolName: string,
  fallback: WorkerId = DATA_READINESS_WORKER_ID,
): WorkerId => PROPOSE_WORKER_MAP[toolName] ?? fallback;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const isSensitiveParam = (key: unknown, role: unknown) => {
  const haystack = `${String(key ?? "")} ${String(role ?? "")}`.toLowerCase();
  return /api.?key|token|secret|password|auth|인증|키/.test(haystack);
};

const summarizeParams = (params: unknown) =>
  ((params as Array<Record<string, unknown>>) ?? []).map((p) => {
    const key = p.param_key ?? p.key;
    const role = p.param_role ?? p.role;
    return {
      key,
      role,
      location: p.param_location ?? p.location,
      order: p.param_order ?? p.order,
      encodeMode: p.encode_mode ?? p.encodeMode ?? "encode",
      value: isSensitiveParam(key, role) ? "[REDACTED]" : (p.param_value ?? p.value),
    };
  });

// api-config POST/PATCH 는 빈 API 키를 거부한다. 이미 등록된 기관(재사용)이거나 키가 필요 없는
// 기관일 때 검증만 통과시키기 위한 센티넬. 기존 소스 재사용 시 payload 의 키는 무시되므로 안전하고,
// api_key_param_key 가 없으면 실제 호출 URL 에도 붙지 않는다. (기존 UI 의 OECD_PUBLIC 등과 동일 패턴)
const SENTINEL_API_KEY = "__REGISTERED__";

// 기존 기관(소스) 찾기 — 이 시스템은 소스=기관, 그룹=데이터셋. LLM 이 소스 이름에 데이터셋명을
// 넣어도 provider 로 기존 기관을 찾도록 한다. 우선순위: (1) provider 일치+키 있음, (2) provider 일치,
// (3) 이름 일치. (기존 GET api-config 재사용)
const findExistingSource = async (
  ctx: ToolContext,
  provider: string,
  name: string,
): Promise<{ id: number; name: string } | null> => {
  const r = await internalFetch(
    ctx.request,
    `/api/ingestion/api-config${dbq(ctx.dbSettingId)}`,
  );
  const sources = (asRecord(r.json).sources as Array<Record<string, unknown>>) ?? [];
  const prov = provider.trim().toLowerCase();
  const nm = name.trim().toLowerCase();
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const found =
    (prov && sources.find((s) => norm(s.provider) === prov && Boolean(s.api_key))) ||
    (prov && sources.find((s) => norm(s.provider) === prov)) ||
    (nm && sources.find((s) => norm(s.name) === nm)) ||
    null;
  return found ? { id: Number(found.id), name: String(found.name ?? "") } : null;
};

const getSourceConfigById = async (
  ctx: ToolContext,
  sourceId: number,
): Promise<Record<string, unknown> | null> => {
  const r = await internalFetch(
    ctx.request,
    `/api/ingestion/api-config${dbq(ctx.dbSettingId)}`,
  );
  const sources = (asRecord(r.json).sources as Array<Record<string, unknown>>) ?? [];
  return (
    sources.find((item) => Number(item.id) === sourceId) ??
    null
  );
};

const hasDangerousSqlKeyword = (sql: string) =>
  /\b(drop|truncate|alter|create|grant|revoke|comment)\b/i.test(sql);

const hasMultiStatement = (sql: string) => {
  const compact = sql.trim();
  if (!compact) return false;
  const statements = compact
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return statements.length > 1;
};

const normalizeLookupText = (value: unknown) =>
  String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");

const quoteSqlIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

const resolvePreviewTarget = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
  options: { allowLatest?: boolean } = {},
): Promise<
  | { sourceId: number; groupId: number; sourceName: string; groupName: string }
  | { error: string }
> => {
  const requestedSourceId = Number(args.sourceId);
  const requestedGroupId = Number(args.groupId);
  const sourceName = normalizeLookupText(args.sourceName);
  const groupName = normalizeLookupText(args.groupName);
  const r = await internalFetch(
    ctx.request,
    `/api/ingestion/api-config${dbq(ctx.dbSettingId)}`,
  );
  if (!r.ok) {
    return { error: `등록된 API 설정 조회 실패 (HTTP ${r.status})` };
  }
  const sources = (asRecord(r.json).sources as Array<Record<string, unknown>>) ?? [];
  const sourceCandidates = sources.filter((source) => {
    if (Number.isFinite(requestedSourceId) && requestedSourceId > 0) {
      return Number(source.id) === requestedSourceId;
    }
    if (sourceName) {
      const name = normalizeLookupText(source.name);
      return name === sourceName || name.includes(sourceName) || sourceName.includes(name);
    }
    return true;
  });

  const matches: Array<{
    sourceId: number;
    groupId: number;
    sourceName: string;
    groupName: string;
    createdAt: string;
  }> = [];
  for (const source of sourceCandidates) {
    for (const group of (source.groups as Array<Record<string, unknown>>) ?? []) {
      if (Number.isFinite(requestedGroupId) && requestedGroupId > 0) {
        if (Number(group.id) !== requestedGroupId) continue;
      } else if (groupName) {
        const name = normalizeLookupText(group.name);
        if (!(name === groupName || name.includes(groupName) || groupName.includes(name))) {
          continue;
        }
      } else if (!options.allowLatest) {
        continue;
      }
      matches.push({
        sourceId: Number(source.id),
        groupId: Number(group.id),
        sourceName: String(source.name ?? ""),
        groupName: String(group.name ?? ""),
        createdAt: String(group.created_at ?? ""),
      });
    }
  }

  if (matches.length === 0) {
    return {
      error:
        "API 대상을 찾지 못했습니다. list_sources로 sourceId와 groupId를 확인하거나 기관명과 API명을 함께 알려주세요.",
    };
  }
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matches[0];
};

// READ 도구 실행 (자동)
export const runReadTool = async (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> => {
  if (name === "list_sources") {
    const r = await internalFetch(
      ctx.request,
      `/api/ingestion/api-config${dbq(ctx.dbSettingId)}`,
    );
    const sources = (asRecord(r.json).sources as Array<Record<string, unknown>>) ?? [];
    // api_key 등 비밀값은 제외하고 요약
    const trimmed = sources.map((s) => ({
      id: s.id,
      name: s.name,
      provider: s.provider,
      base_url: s.base_url,
      hasApiKey: Boolean(s.api_key), // 키 값은 노출하지 않고 존재 여부만
      groups: ((s.groups as Array<Record<string, unknown>>) ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        target_schema: g.target_schema,
        target_table: g.target_table,
        params: summarizeParams(g.params),
      })),
    }));
    return { sources: trimmed };
  }
  if (name === "describe_source_config") {
    const sourceId = Number(args.sourceId);
    const groupId = Number(args.groupId);
    const r = await internalFetch(
      ctx.request,
      `/api/ingestion/api-config${dbq(ctx.dbSettingId)}`,
    );
    const sources = (asRecord(r.json).sources as Array<Record<string, unknown>>) ?? [];
    const sourceFiltered = Number.isFinite(sourceId)
      ? sources.filter((s) => Number(s.id) === sourceId)
      : sources;
    const detailed = sourceFiltered.map((s) => {
      const groups = ((s.groups as Array<Record<string, unknown>>) ?? [])
        .filter((g) => !Number.isFinite(groupId) || Number(g.id) === groupId)
        .map((g) => ({
          id: g.id,
          name: g.name,
          target_schema: g.target_schema,
          target_table: g.target_table,
          target_truncate: Boolean(g.target_truncate),
          target_merge_sql: g.target_merge_sql ?? null,
          schedule_enabled: Boolean(g.schedule_enabled),
          schedule_type: g.schedule_type ?? null,
          schedule_interval_minutes: g.schedule_interval_minutes ?? null,
          schedule_cron_expr: g.schedule_cron_expr ?? null,
          params: summarizeParams(g.params),
        }));
      return {
        id: s.id,
        name: s.name,
        provider: s.provider,
        base_url: s.base_url,
        enabled: Boolean(s.enabled),
        hasApiKey: Boolean(s.api_key),
        apiKeyParamKey: s.api_key_param_key ?? null,
        apiKeyLocation: s.api_key_location ?? null,
        apiKeyOrder: s.api_key_order ?? null,
        apiKeyEncodeMode: s.api_key_encode_mode ?? null,
        groups,
      };
    });
    return { sources: detailed };
  }
  if (name === "list_db_meta") {
    const action = String(args.action ?? "").trim();
    if (!["schemas", "tables", "columns"].includes(action)) {
      return { error: "action 은 schemas | tables | columns 중 하나여야 합니다." };
    }
    const body: Record<string, unknown> = {
      action,
      dbSettingId: ctx.dbSettingId ?? undefined,
    };
    if (typeof args.schema === "string" && args.schema.trim()) {
      body.schema = args.schema.trim();
    }
    if (typeof args.table === "string" && args.table.trim()) {
      body.table = args.table.trim();
    }
    const r = await internalFetch(ctx.request, `/api/ingestion/db-meta`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return r.json;
  }
  if (name === "list_mappings") {
    const r = await internalFetch(
      ctx.request,
      `/api/visualization/map-mst${dbq(ctx.dbSettingId)}`,
    );
    return r.json;
  }
  if (name === "search_statistic") {
    const provider = String(args.provider ?? "").toLowerCase().trim();
    const query = String(args.query ?? "").trim();
    const cfg = STAT_ENDPOINTS[provider];
    if (!cfg) {
      return { error: `지원하지 않는 provider: '${provider}'. 가능: ${STAT_PROVIDERS.join(", ")}` };
    }
    const qs: string[] = [];
    if (cfg.serverSearch && query) qs.push(`q=${encodeURIComponent(query)}`);
    if (provider === "kosis" || provider === "fred") qs.push("limit=30");
    if (ctx.dbSettingId) qs.push(`dbSettingId=${ctx.dbSettingId}`);
    const path = qs.length ? `${cfg.base}?${qs.join("&")}` : cfg.base;
    const r = await internalFetch(ctx.request, path);
    if (!r.ok) {
      return { error: `${provider} 통계목록 조회 실패 (HTTP ${r.status})` };
    }
    let items = (asRecord(r.json).items as Array<Record<string, unknown>>) ?? [];
    // 서버검색 미지원 provider 는 전체목록을 받아 query 로 필터
    if (!cfg.serverSearch && query) {
      const q = query.toLowerCase();
      items = items.filter((it) => {
        const parts = [it[cfg.code], it[cfg.name], ...cfg.extra.map((e) => it[e])];
        return parts.map((v) => String(v ?? "")).join(" ").toLowerCase().includes(q);
      });
    }
    const trimmed = items.slice(0, 20).map((it) => {
      const o: Record<string, unknown> = { code: it[cfg.code], name: it[cfg.name] };
      for (const e of cfg.extra) o[e] = it[e];
      return o;
    });
    return { provider, count: trimmed.length, items: trimmed };
  }
  if (name === "preview_api") {
    const target = await resolvePreviewTarget(args, ctx, { allowLatest: true });
    if ("error" in target) return target;
    const r = await internalFetch(ctx.request, `/api/data-agent/create-target-table`, {
      method: "POST",
      body: JSON.stringify({
        sourceId: target.sourceId,
        groupId: target.groupId,
        table: "PREVIEW_LRD",
        dryRun: true,
        dbSettingId: ctx.dbSettingId ?? undefined,
      }),
    });
    if (!r.ok) {
      const body = asRecord(r.json);
      return {
        error: body.error ?? `샘플 조회 실패 (HTTP ${r.status})`,
        sourceId: target.sourceId,
        groupId: target.groupId,
      };
    }
    return {
      ...asRecord(r.json),
      sourceId: target.sourceId,
      groupId: target.groupId,
      sourceName: target.sourceName,
      groupName: target.groupName,
    };
  }
  if (name === "preview_api_draft") {
    const sourceId = Number(args.sourceId);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return { error: "draft preview에는 기존 기관의 sourceId가 필요합니다." };
    }
    const params = Array.isArray(args.params) ? args.params : [];
    const r = await internalFetch(ctx.request, `/api/data-agent/preview-draft`, {
      method: "POST",
      body: JSON.stringify({
        sourceId,
        params,
        dbSettingId: ctx.dbSettingId ?? undefined,
      }),
    });
    const body = asRecord(r.json);
    if (!r.ok || !body.ok) {
      return {
        error: body.error ?? `draft 샘플 조회 실패 (HTTP ${r.status})`,
        sourceId,
      };
    }
    return { ...body, sourceId };
  }
  if (name === "generate_staging_table_sql") {
    const table = String(args.table ?? "").trim();
    if (!table) {
      return {
        needsInput: true,
        field: "table",
        message: "생성할 테이블명을 알려주세요. 테이블명은 _LRD로 끝나야 합니다.",
      };
    }
    if (!table.toLowerCase().endsWith("_lrd")) {
      return { error: "임시 적재 테이블명은 _LRD로 끝나야 합니다." };
    }
    const target = await resolvePreviewTarget(args, ctx, { allowLatest: true });
    if ("error" in target) return target;
    const schema = String(args.schema ?? "dp").trim() || "dp";
    const preview = await internalFetch(ctx.request, `/api/data-agent/create-target-table`, {
      method: "POST",
      body: JSON.stringify({
        sourceId: target.sourceId,
        groupId: target.groupId,
        schema,
        table,
        dryRun: true,
        dbSettingId: ctx.dbSettingId ?? undefined,
      }),
    });
    const body = asRecord(preview.json);
    if (!preview.ok || !body.ok) {
      return {
        error: body.error ?? `테이블 생성문 준비 실패 (HTTP ${preview.status})`,
        sourceId: target.sourceId,
        groupId: target.groupId,
      };
    }
    const columns = ((body.columns as Array<Record<string, unknown>>) ?? [])
      .map((column) => String(column.name ?? "").trim())
      .filter(Boolean);
    if (columns.length === 0) {
      return { error: "샘플 데이터에서 테이블 컬럼을 확인하지 못했습니다." };
    }
    const columnSql = columns
      .map((column) => `  ${quoteSqlIdentifier(column)} text`)
      .join(",\n");
    const sql =
      `CREATE TABLE IF NOT EXISTS ${quoteSqlIdentifier(schema)}.${quoteSqlIdentifier(table)} (\n` +
      `${columnSql}\n);`;
    return {
      ok: true,
      sourceId: target.sourceId,
      groupId: target.groupId,
      sourceName: target.sourceName,
      groupName: target.groupName,
      schema,
      table,
      columns,
      sql,
    };
  }
  if (name === "build_collection_params") {
    return buildCollectionParams({
      provider: String(args.provider ?? ""),
      code: String(args.code ?? ""),
      cycle: args.cycle ? String(args.cycle) : undefined,
      startDate: String(args.startDate ?? ""),
      endDate: String(args.endDate ?? ""),
      userStatsId: args.userStatsId ? String(args.userStatsId) : undefined,
    });
  }
  if (name === "preview_transform") {
    const r = await internalFetch(ctx.request, `/api/data-transform/preview${dbq(ctx.dbSettingId)}`, {
      method: "POST",
      body: JSON.stringify({
        sourceMapId: args.sourceMapId,
        transformType: args.transformType,
        config: args.config,
        dbSettingId: ctx.dbSettingId ?? undefined,
      }),
    });
    return r.json;
  }
  return { error: `알 수 없는 조회 도구: ${name}` };
};

export type ExecResult = {
  ok: boolean;
  message?: string;
  error?: string;
  data?: unknown;
};

// 승인 후 실제 실행 (기존 엔드포인트 호출)
export const executeAction = async (
  type: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ExecResult> => {
  if (type === "run_collection") {
    const r = await internalFetch(ctx.request, `/api/ingestion/api-load`, {
      method: "POST",
      body: JSON.stringify({
        sourceId: args.sourceId,
        groupId: args.groupId,
        truncate: Boolean(args.truncate),
        triggerType: "manual",
        dbSettingId: ctx.dbSettingId ?? undefined,
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; inserted?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `수집 실패 (HTTP ${r.status})` };
    return { ok: true, message: `${j.inserted ?? 0}건 적재 완료`, data: j };
  }

  if (type === "run_mapping") {
    const mapId = args.mapId;
    const mode = args.mode === "regenerate" ? "regenerate" : "generate";
    const r = await internalFetch(
      ctx.request,
      `/api/visualization/map-mst/${mapId}/generate${dbq(ctx.dbSettingId)}`,
      { method: "POST", body: JSON.stringify({ mode, dbSettingId: ctx.dbSettingId ?? undefined }) },
    );
    const j = asRecord(r.json) as {
      ok?: boolean;
      affectedCount?: number;
      startDate?: string;
      endDate?: string;
      error?: string;
    };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `매핑 생성 실패 (HTTP ${r.status})` };
    const range = j.startDate && j.endDate ? ` (${j.startDate}~${j.endDate})` : "";
    return { ok: true, message: `${j.affectedCount ?? 0}건 시계열 생성${range}`, data: j };
  }

  if (type === "register_org") {
    // 키 없는(또는 키 불필요) 기관도 등록되도록 빈 키는 센티넬로 대체 (POST 빈 키 거부 회피)
    const apiKey = String(args.apiKey ?? "").trim() || SENTINEL_API_KEY;
    const r = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "POST",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        source: {
          name: args.name,
          provider: args.provider,
          baseUrl: args.baseUrl,
          apiKey,
          enabled: typeof args.enabled === "boolean" ? args.enabled : true,
          apiKeyParamKey: args.apiKeyParamKey,
          apiKeyLocation: args.apiKeyLocation,
          apiKeyOrder: args.apiKeyOrder,
          apiKeyEncodeMode: args.apiKeyEncodeMode,
          isTemplate: args.isTemplate,
        },
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; sourceId?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `기관 등록 실패 (HTTP ${r.status})` };
    return { ok: true, message: `기관 '${args.name}' 등록 완료 (sourceId=${j.sourceId})`, data: j };
  }

  if (type === "update_org") {
    const sourceId = Number(args.sourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      return { ok: false, error: "유효한 sourceId 가 필요합니다." };
    }
    const current = await getSourceConfigById(ctx, sourceId);
    if (!current) {
      return { ok: false, error: `sourceId=${sourceId} 기관을 찾을 수 없습니다.` };
    }
    const currentApiKey = String(current.api_key ?? "").trim();
    const nextApiKey = String(args.apiKey ?? "").trim() || currentApiKey;
    if (!nextApiKey) {
      return { ok: false, error: "기존 API 키가 없어 수정할 수 없습니다. 새 API 키를 입력해 주세요." };
    }
    const r = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "PATCH",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        sourceId,
        updateTarget: "source",
        source: {
          name: args.name,
          provider: args.provider,
          baseUrl: args.baseUrl,
          apiKey: nextApiKey,
          enabled:
            typeof args.enabled === "boolean" ? args.enabled : Boolean(current.enabled),
          apiKeyParamKey:
            args.apiKeyParamKey ?? current.api_key_param_key ?? null,
          apiKeyLocation:
            args.apiKeyLocation ?? current.api_key_location ?? "query",
          apiKeyOrder:
            Number.isFinite(args.apiKeyOrder as number)
              ? args.apiKeyOrder
              : (current.api_key_order ?? 0),
          apiKeyEncodeMode:
            args.apiKeyEncodeMode ?? current.api_key_encode_mode ?? "encode",
        },
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; sourceId?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `기관 수정 실패 (HTTP ${r.status})` };
    return { ok: true, message: `기관 '${args.name}'(sourceId=${args.sourceId}) API 키/정보 수정 완료`, data: j };
  }

  if (type === "register_source") {
    const src = asRecord(args.source);
    const provider = String(src.provider ?? "").trim().toLowerCase();
    const givenName = String(src.name ?? "").trim();
    let apiKey = String(src.apiKey ?? "").trim();

    // 소스=기관. provider 로 기존 기관을 찾아 그 소스를 재사용(이름이 데이터셋명이어도 OK).
    const existing = await findExistingSource(ctx, provider, givenName);
    let sourceName = givenName;
    if (existing) {
      sourceName = existing.name; // 기존 기관 소스 재사용
      if (!apiKey) apiKey = SENTINEL_API_KEY; // 재사용 시 기존 키 보존(payload 키는 무시됨)
    } else if (!apiKey) {
      return {
        ok: false,
        error: `'${givenName || provider}' 기관이 아직 등록되지 않았습니다. 기관 관리에서 먼저 등록하거나 API 키를 알려주세요.`,
      };
    }

    // 그룹 이름 = 데이터셋명. groupName 이 없으면 사용자가 준 이름을 그룹명으로.
    const groupName = String(args.groupName ?? "").trim() || givenName;

    const r = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "POST",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        source: { ...src, name: sourceName, provider, apiKey },
        groupName,
        params: args.params,
      }),
    });
    const j = asRecord(r.json) as {
      ok?: boolean;
      sourceId?: number;
      groupId?: number;
      error?: string;
    };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `소스 등록 실패 (HTTP ${r.status})` };
    return {
      ok: true,
      message: `'${sourceName}' 기관에 API '${groupName}' 등록 완료 (sourceId=${j.sourceId}, groupId=${j.groupId}). 샘플 조회에는 이 ID를 사용하세요.`,
      data: j,
    };
  }

  if (type === "create_staging_table") {
    // 1) 테이블 생성 (API 프리뷰 컬럼 기반)
    const schema = (typeof args.schema === "string" && args.schema.trim()) || "dp";
    const table = String(args.table ?? "").trim();
    if (!table || /^example_?lrd$/i.test(table)) {
      return {
        ok: false,
        error:
          "실제 _LRD 테이블명이 필요합니다. example_LRD 같은 예시명으로는 생성하지 않습니다.",
      };
    }
    const created = await internalFetch(ctx.request, `/api/data-agent/create-target-table`, {
      method: "POST",
      body: JSON.stringify({
        sourceId: args.sourceId,
        groupId: args.groupId,
        schema,
        table,
        dbSettingId: ctx.dbSettingId ?? undefined,
      }),
    });
    const cj = asRecord(created.json) as {
      ok?: boolean;
      created?: boolean;
      columns?: Array<{ name: string }>;
      permissionDenied?: boolean;
      ddl?: string;
      error?: string;
    };
    if (!created.ok || !cj.ok) {
      const ddlSuffix = cj.ddl ? `\n\n${cj.ddl}` : "";
      return {
        ok: false,
        error: `${cj.error ?? `테이블 생성 실패 (HTTP ${created.status})`}${ddlSuffix}`,
        data: cj,
      };
    }
    // 2) 그룹에 대상 테이블 연결 (groupTargetTable)
    const bind = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "PATCH",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        sourceId: args.sourceId,
        groupId: args.groupId,
        updateTarget: "groupTargetTable",
        target: { schema, table, truncate: false },
      }),
    });
    const bj = asRecord(bind.json) as { ok?: boolean; error?: string };
    if (!bind.ok || !bj.ok) {
      return {
        ok: false,
        error: `테이블은 생성됐으나 그룹 연결에 실패: ${bj.error ?? `HTTP ${bind.status}`}`,
      };
    }
    const colCount = cj.columns?.length ?? 0;
    return {
      ok: true,
      message: `${schema}.${table} 테이블 생성(컬럼 ${colCount}개) 및 그룹 연결 완료`,
      data: cj,
    };
  }

  if (type === "update_group") {
    const r = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "PATCH",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        sourceId: args.sourceId,
        groupId: args.groupId,
        updateTarget: "group",
        groupName: args.groupName,
        params: args.params,
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; sourceId?: number; groupId?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `그룹 수정 실패 (HTTP ${r.status})` };
    return {
      ok: true,
      message: `수집 그룹 수정 완료 (sourceId=${args.sourceId}, groupId=${args.groupId})`,
      data: j,
    };
  }

  if (type === "update_group_target_table") {
    const schema = (typeof args.schema === "string" && args.schema.trim()) || "dp";
    const table = String(args.table ?? "").trim();
    if (!table) {
      return { ok: false, error: "table 값이 필요합니다." };
    }
    const mergeSql = typeof args.mergeSql === "string" ? args.mergeSql.trim() : "";
    if (mergeSql) {
      if (hasDangerousSqlKeyword(mergeSql)) {
        return {
          ok: false,
          error:
            "mergeSql 에 위험한 DDL/DCL 키워드(DROP/TRUNCATE/ALTER/CREATE/GRANT/REVOKE)가 포함되어 저장할 수 없습니다.",
        };
      }
      if (hasMultiStatement(mergeSql)) {
        return {
          ok: false,
          error: "mergeSql 은 단일 SQL 문만 허용합니다(세미콜론으로 여러 문장 분리 금지).",
        };
      }
      const meta = await internalFetch(ctx.request, `/api/ingestion/db-meta`, {
        method: "POST",
        body: JSON.stringify({
          action: "columns",
          schema,
          table,
          dbSettingId: ctx.dbSettingId ?? undefined,
        }),
      });
      const mj = asRecord(meta.json) as { ok?: boolean; columns?: unknown[]; error?: string };
      if (!meta.ok || !mj.ok || !Array.isArray(mj.columns) || mj.columns.length === 0) {
        return {
          ok: false,
          error: mj.error ?? `대상 테이블 메타 확인 실패 (${schema}.${table})`,
        };
      }
    }
    const r = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "PATCH",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        sourceId: args.sourceId,
        groupId: args.groupId,
        updateTarget: "groupTargetTable",
        target: {
          schema,
          table,
          truncate: Boolean(args.truncate),
          mergeSql,
        },
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; sourceId?: number; groupId?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `테이블 설정 수정 실패 (HTTP ${r.status})` };
    return {
      ok: true,
      message: `${schema}.${table} 테이블 설정 수정 완료 (groupId=${args.groupId})`,
      data: j,
    };
  }

  if (type === "update_group_schedule") {
    const r = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "PATCH",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        sourceId: args.sourceId,
        groupId: args.groupId,
        updateTarget: "groupSchedule",
        schedule: {
          enabled: Boolean(args.enabled),
          type: args.type === "cron" ? "cron" : "interval",
          intervalMinutes: args.intervalMinutes,
          cronExpr: args.cronExpr,
        },
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; sourceId?: number; groupId?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `스케줄 수정 실패 (HTTP ${r.status})` };
    return {
      ok: true,
      message: `수집 그룹 스케줄 수정 완료 (groupId=${args.groupId})`,
      data: j,
    };
  }

  if (type === "refresh_periods") {
    const r = await internalFetch(ctx.request, `/api/ingestion/api-config`, {
      method: "PATCH",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        sourceId: args.sourceId,
        groupId: args.groupId,
        updateTarget: "refreshPeriods",
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; updatedCount?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `기간 갱신 실패 (HTTP ${r.status})` };
    return {
      ok: true,
      message: `API(groupId=${args.groupId}) 기간 파라미터 ${j.updatedCount ?? 0}개 갱신 완료`,
      data: j,
    };
  }

  if (type === "create_mapping") {
    const r = await internalFetch(ctx.request, `/api/visualization/map-mst${dbq(ctx.dbSettingId)}`, {
      method: "POST",
      body: JSON.stringify({
        dbSettingId: ctx.dbSettingId ?? undefined,
        sourceOrg: args.sourceOrg ?? "custom",
        apiName: args.apiName,
        sourceTable: args.sourceTable,
        seriesName: args.seriesName,
        dateColumn: args.dateColumn,
        valueColumn: args.valueColumn,
        dateFormat: args.dateFormat,
        freq: args.freq,
        whereClause: args.whereClause,
        unitName: args.unitName,
      }),
    });
    const j = asRecord(r.json) as {
      ok?: boolean;
      mapId?: number;
      map?: { map_id?: number };
      error?: string;
    };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `매핑 생성 실패 (HTTP ${r.status})` };
    const mapId = j.mapId ?? j.map?.map_id;
    return {
      ok: true,
      message: `매핑 생성 완료${mapId ? ` (mapId=${mapId})` : ""}. 이제 매핑 생성 실행을 요청할 수 있어요.`,
      data: j,
    };
  }

  if (type === "create_transform") {
    const r = await internalFetch(ctx.request, `/api/data-transform${dbq(ctx.dbSettingId)}`, {
      method: "POST",
      body: JSON.stringify({
        name: args.name,
        sourceMapId: args.sourceMapId,
        transformType: args.transformType,
        config: args.config,
        outputName: args.outputName,
        outputUnit: args.outputUnit,
        outputFreq: args.outputFreq,
        dbSettingId: ctx.dbSettingId ?? undefined,
      }),
    });
    const j = asRecord(r.json) as { ok?: boolean; transformId?: number; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `가공 생성 실패 (HTTP ${r.status})` };
    return {
      ok: true,
      message: `가공 생성 완료${j.transformId ? ` (transformId=${j.transformId})` : ""}. 이제 가공 실행을 요청할 수 있어요.`,
      data: j,
    };
  }

  if (type === "run_transform") {
    const id = args.transformId;
    const r = await internalFetch(
      ctx.request,
      `/api/data-transform/${id}/run${dbq(ctx.dbSettingId)}`,
      { method: "POST", body: JSON.stringify({ dbSettingId: ctx.dbSettingId ?? undefined }) },
    );
    const j = asRecord(r.json) as {
      ok?: boolean;
      affectedCount?: number;
      startDate?: string;
      endDate?: string;
      error?: string;
    };
    if (!r.ok || !j.ok) return { ok: false, error: j.error ?? `가공 실행 실패 (HTTP ${r.status})` };
    const range = j.startDate && j.endDate ? ` (${j.startDate}~${j.endDate})` : "";
    return { ok: true, message: `${j.affectedCount ?? 0}건 가공 결과 생성${range}`, data: j };
  }

  return { ok: false, error: `알 수 없는 실행 유형: ${type}` };
};
