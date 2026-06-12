import { NextResponse } from "next/server";
import {
  canUseDb,
  createDbClientFromRequest,
  connectWithTimeout,
} from "../_lib/db";

export const runtime = "nodejs";

const normalizeProvider = (provider?: string | null) => {
  const value = (provider ?? "").trim().toLowerCase();
  if (value === "data-go-kr" || value === "data_go_kr") return "datagokr";
  return value || "custom";
};

export async function GET(request: Request) {
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `
        with candidate as (
          select
            s.provider,
            coalesce(nullif(g.name, ''), s.name) as api_name,
            coalesce(nullif(g.target_schema, ''), 'dp') as target_schema,
            g.target_table,
            case
              when g.target_table ilike '%\\_lrd' escape '\\'
                then regexp_replace(g.target_table, '_lrd$', '', 'i')
              else g.target_table
            end as source_table
          from dp.api_param_group g
          join dp.api_source s on s.id = g.source_id
          where g.is_template = false
            and nullif(g.target_table, '') is not null
        ),
        existing as (
          select
            c.*,
            (
              to_regclass(format('%I.%I', c.target_schema, c.source_table)) is not null
            ) as source_table_exists
          from candidate c
        ),
        mapped as (
          select
            e.*,
            m.map_id,
            m.is_active as map_active
          from existing e
          left join lateral (
            select map_id, is_active
            from dp.viz_map_mst vm
            where lower(vm.source_org) = lower(e.provider)
              and lower(vm.source_table) = lower(e.source_table)
            order by vm.updated_at desc, vm.map_id desc
            limit 1
          ) m on true
          where e.source_table_exists = true
        )
        select
          provider,
          api_name,
          target_table,
          source_table,
          map_id,
          map_active
        from mapped
        order by provider, api_name, source_table
      `,
    );

    return NextResponse.json({
      ok: true,
      items: result.rows.map((row) => ({
        sourceOrg: normalizeProvider((row.provider as string | null) ?? ""),
        apiName: ((row.api_name as string | null) ?? "").trim(),
        targetTable: ((row.target_table as string | null) ?? "").trim(),
        sourceTable: ((row.source_table as string | null) ?? "").trim(),
        hasMapping: Number.isFinite(Number(row.map_id)),
        isActive: Boolean(row.map_active ?? false),
        mapId: Number.isFinite(Number(row.map_id)) ? Number(row.map_id) : null,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "매핑 대상 목록을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

