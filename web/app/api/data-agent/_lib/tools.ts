import { internalFetch } from "./internal";
import type { OpenAiTool } from "./llm";

export type ToolContext = { request: Request; dbSettingId: number | null };

const dbq = (dbSettingId: number | null, sep: "?" | "&" = "?") =>
  dbSettingId ? `${sep}dbSettingId=${dbSettingId}` : "";

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
        "제공기관의 통계/지표 코드를 검색한다. v1은 provider='kosis'(통계청)만 지원.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["kosis"] },
          query: { type: "string", description: "검색어(예: 소비자물가지수)" },
        },
        required: ["provider", "query"],
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
];

// propose_* 도구명 → 실행 액션 타입
export const PROPOSE_MAP: Record<string, string> = {
  propose_collection_run: "run_collection",
  propose_mapping_run: "run_mapping",
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

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
      groups: ((s.groups as Array<Record<string, unknown>>) ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        target_schema: g.target_schema,
        target_table: g.target_table,
      })),
    }));
    return { sources: trimmed };
  }
  if (name === "list_mappings") {
    const r = await internalFetch(
      ctx.request,
      `/api/visualization/map-mst${dbq(ctx.dbSettingId)}`,
    );
    return r.json;
  }
  if (name === "search_statistic") {
    const provider = String(args.provider ?? "kosis").toLowerCase();
    if (provider !== "kosis") {
      return { error: "v1은 kosis(통계청) 검색만 지원합니다." };
    }
    const query = encodeURIComponent(String(args.query ?? "").trim());
    const r = await internalFetch(
      ctx.request,
      `/api/ingestion/kosis-stat-search?q=${query}&limit=15${dbq(ctx.dbSettingId, "&")}`,
    );
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
    if (!r.ok || !j.ok) {
      return { ok: false, error: j.error ?? `수집 실패 (HTTP ${r.status})` };
    }
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
    if (!r.ok || !j.ok) {
      return { ok: false, error: j.error ?? `매핑 생성 실패 (HTTP ${r.status})` };
    }
    const range = j.startDate && j.endDate ? ` (${j.startDate}~${j.endDate})` : "";
    return { ok: true, message: `${j.affectedCount ?? 0}건 시계열 생성${range}`, data: j };
  }
  return { ok: false, error: `알 수 없는 실행 유형: ${type}` };
};
