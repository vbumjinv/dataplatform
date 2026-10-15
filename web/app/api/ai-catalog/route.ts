import { NextResponse } from "next/server";
import {
  canUseDb,
  connectWithTimeout,
  createDbClientFromRequest,
} from "@/app/api/visualization/_lib/db";
import type { CatalogKind } from "../ai-orchestrator/_lib/worker-contract";
import { DATA_READINESS_TOOL_NAMES, DATASET_ENGINEERING_TOOL_NAMES } from "../data-agent/_lib/tools";
import { requireAdminSession } from "../data-agent/_lib/auth";

export const runtime = "nodejs";

type CatalogItem = {
  kind: CatalogKind;
  id: string;
  name: string;
  description?: string | null;
  tags?: string[];
  provider?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  links?: Array<{ rel: string; id: string; kind: CatalogKind }>;
  raw?: Record<string, unknown>;
};

type DbClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const FIRST_PHASE_KINDS = new Set<CatalogKind>([
  "source",
  "group",
  "dataset",
  "mapping",
  "transform",
  "pipeline",
  "tool",
]);

const parseKind = (request: Request): CatalogKind | null => {
  const raw = new URL(request.url).searchParams.get("kind");
  return raw && FIRST_PHASE_KINDS.has(raw as CatalogKind) ? (raw as CatalogKind) : null;
};

const matchesQuery = (item: CatalogItem, query: string) => {
  if (!query) return true;
  const haystack = [
    item.kind,
    item.id,
    item.name,
    item.description,
    item.provider,
    item.status,
    ...(item.tags ?? []),
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  return haystack.includes(query.toLowerCase());
};

const toolItems = (): CatalogItem[] => [
  ...DATA_READINESS_TOOL_NAMES.map((name) => ({
    kind: "tool" as const,
    id: `tool:${name}`,
    name,
    description: "Data Readiness 도구",
    tags: ["data_readiness"],
  })),
  ...DATASET_ENGINEERING_TOOL_NAMES.map((name) => ({
    kind: "tool" as const,
    id: `tool:${name}`,
    name,
    description: "Dataset Engineering 도구",
    tags: ["dataset_engineering"],
  })),
];

const sourceItems = async (client: DbClient): Promise<CatalogItem[]> => {
  const result = await client.query(
    `select id, name, provider, base_url, enabled, created_at
       from dp.api_source
      order by id desc`,
  );
  return result.rows.map((row) => ({
    kind: "source",
    id: `source:${row.id}`,
    name: String(row.name ?? `source:${row.id}`),
    provider: row.provider ? String(row.provider) : null,
    status: row.enabled === false ? "disabled" : "active",
    updatedAt: row.created_at ? String(row.created_at) : null,
    raw: {
      sourceId: row.id,
      baseUrl: row.base_url,
      hasBaseUrl: Boolean(row.base_url),
    },
  }));
};

const groupAndDatasetItems = async (client: DbClient): Promise<CatalogItem[]> => {
  const result = await client.query(
    `select
       g.id, g.name, g.source_id, g.target_schema, g.target_table,
       s.name as source_name, s.provider, g.created_at
     from dp.api_param_group g
     left join dp.api_source s on s.id = g.source_id
     order by g.id desc`,
  );

  const groups: CatalogItem[] = result.rows.map((row) => ({
    kind: "group",
    id: `group:${row.id}`,
    name: String(row.name ?? `group:${row.id}`),
    provider: row.provider ? String(row.provider) : null,
    updatedAt: row.created_at ? String(row.created_at) : null,
    links: row.source_id
      ? [{ rel: "source", id: `source:${row.source_id}`, kind: "source" }]
      : undefined,
    raw: {
      groupId: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      targetSchema: row.target_schema,
      targetTable: row.target_table,
    },
  }));

  const datasets: CatalogItem[] = result.rows
    .filter((row) => row.target_table)
    .map((row) => ({
      kind: "dataset",
      id: `dataset:group:${row.id}`,
      name: String(row.name ?? row.target_table ?? `dataset:${row.id}`),
      provider: row.provider ? String(row.provider) : null,
      updatedAt: row.created_at ? String(row.created_at) : null,
      links: [
        { rel: "group", id: `group:${row.id}`, kind: "group" },
        ...(row.source_id
          ? [{ rel: "source", id: `source:${row.source_id}`, kind: "source" as const }]
          : []),
      ],
      raw: {
        groupId: row.id,
        sourceId: row.source_id,
        table: [row.target_schema, row.target_table].filter(Boolean).join("."),
      },
    }));

  return [...groups, ...datasets];
};

const mappingItems = async (client: DbClient): Promise<CatalogItem[]> => {
  const result = await client.query(
    `select
       map_id, source_org, api_name, source_table, series_name,
       date_column, value_column, freq, is_active
     from dp.viz_map_mst
     order by map_id desc`,
  );
  return result.rows.map((row) => ({
    kind: "mapping",
    id: `map:${row.map_id}`,
    name: String(row.series_name ?? `map:${row.map_id}`),
    description: row.source_table ? `source_table=${row.source_table}` : null,
    provider: row.source_org ? String(row.source_org) : null,
    status: row.is_active === false ? "disabled" : "active",
    raw: {
      mapId: row.map_id,
      apiName: row.api_name,
      sourceTable: row.source_table,
      dateColumn: row.date_column,
      valueColumn: row.value_column,
      freq: row.freq,
    },
  }));
};

const transformItems = async (client: DbClient): Promise<CatalogItem[]> => {
  const result = await client.query(
    `select transform_id, name, transform_type, source_map_id, output_map_id, is_active
       from dp.api_transform
      order by transform_id desc`,
  );
  return result.rows.map((row) => ({
    kind: "transform",
    id: `transform:${row.transform_id}`,
    name: String(row.name ?? `transform:${row.transform_id}`),
    status: row.is_active === false ? "disabled" : "active",
    links: [
      ...(row.source_map_id
        ? [{ rel: "source_mapping", id: `map:${row.source_map_id}`, kind: "mapping" as const }]
        : []),
      ...(row.output_map_id
        ? [{ rel: "output_mapping", id: `map:${row.output_map_id}`, kind: "mapping" as const }]
        : []),
    ],
    raw: {
      transformId: row.transform_id,
      transformType: row.transform_type,
      sourceMapId: row.source_map_id,
      outputMapId: row.output_map_id,
    },
  }));
};

const pipelineItems = async (client: DbClient): Promise<CatalogItem[]> => {
  const result = await client.query(
    `select
       p.pipeline_id, p.name, p.description, p.is_active, p.group_id,
       coalesce(nullif(g.name, ''), s.name) as collection_label
     from dp.api_pipeline p
     left join dp.api_param_group g on g.id = p.group_id
     left join dp.api_source s on s.id = g.source_id
     order by p.pipeline_id desc`,
  );
  return result.rows.map((row) => ({
    kind: "pipeline",
    id: `pipeline:${row.pipeline_id}`,
    name: String(row.name ?? `pipeline:${row.pipeline_id}`),
    description: row.description ? String(row.description) : null,
    status: row.is_active === false ? "disabled" : "active",
    links: row.group_id
      ? [{ rel: "collection_group", id: `group:${row.group_id}`, kind: "group" }]
      : undefined,
    raw: {
      pipelineId: row.pipeline_id,
      groupId: row.group_id,
      collectionLabel: row.collection_label,
    },
  }));
};

const loadItems = async (
  client: DbClient,
  kind: CatalogKind | null,
): Promise<CatalogItem[]> => {
  if (kind === "tool") return toolItems();

  const batches: CatalogItem[][] = [];
  if (!kind || kind === "source") batches.push(await sourceItems(client));
  if (!kind || kind === "group" || kind === "dataset") {
    const groupAndDatasets = await groupAndDatasetItems(client);
    batches.push(kind ? groupAndDatasets.filter((item) => item.kind === kind) : groupAndDatasets);
  }
  if (!kind || kind === "mapping") batches.push(await mappingItems(client));
  if (!kind || kind === "transform") batches.push(await transformItems(client));
  if (!kind || kind === "pipeline") batches.push(await pipelineItems(client));

  if (!kind) batches.push(toolItems());
  return batches.flat();
};

export async function GET(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }

  const url = new URL(request.url);
  const kind = parseKind(request);
  const requestedKind = url.searchParams.get("kind");
  if (requestedKind && !kind) {
    return NextResponse.json(
      {
        ok: false,
        error: "지원하지 않는 카탈로그 kind 입니다.",
        supportedKinds: Array.from(FIRST_PHASE_KINDS),
      },
      { status: 400 },
    );
  }

  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    await connectWithTimeout(client);
    const q = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
    const items = (await loadItems(client, kind)).filter((item) => matchesQuery(item, q));
    return NextResponse.json({
      ok: true,
      kind: kind ?? "all",
      count: items.length,
      items: items.slice(0, limit),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 카탈로그 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
