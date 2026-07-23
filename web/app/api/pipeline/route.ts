import { NextResponse } from "next/server";
import {
  canUseDb,
  connectWithTimeout,
  createPipelineClientFromRequest,
  parseDbSettingIdFromRequest,
} from "./_lib/db";
import { createPipeline, type PipelineInput } from "./_lib/persist";
import {
  initializePipelineScheduler,
  refreshPipelineSchedule,
} from "./_lib/pipeline-scheduler";

export const runtime = "nodejs";

type PipelineListRow = {
  pipeline_id: number;
  name: string;
  description: string | null;
  schedule_enabled: boolean;
  schedule_type: "interval" | "cron";
  schedule_interval_minutes: number | null;
  schedule_cron_expr: string | null;
  is_active: boolean;
  group_id: number | null;
  collection_label: string | null;
  map_count: number;
  mappings: string[];
  transform_count: number;
  transforms: string[];
  last_status: string | null;
  last_run_at: string | null;
};

export async function GET(request: Request) {
  await initializePipelineScheduler();
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  const client = await createPipelineClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const result = await client.query<PipelineListRow>(
      `select
         p.pipeline_id, p.name, p.description, p.schedule_enabled, p.schedule_type,
         p.schedule_interval_minutes, p.schedule_cron_expr, p.is_active, p.group_id,
         coalesce(nullif(g.name, ''), s.name) as collection_label,
         (select count(*)::int from dp.api_pipeline_map m where m.pipeline_id = p.pipeline_id) as map_count,
         (select coalesce(json_agg(vm.series_name order by mm.sort_order, mm.id), '[]'::json)
            from dp.api_pipeline_map mm
            join dp.viz_map_mst vm on vm.map_id = mm.map_id
            where mm.pipeline_id = p.pipeline_id) as mappings,
         (select count(*)::int from dp.api_pipeline_transform pt where pt.pipeline_id = p.pipeline_id) as transform_count,
         (select coalesce(json_agg(t.name order by pt.sort_order, pt.id), '[]'::json)
            from dp.api_pipeline_transform pt
            join dp.api_transform t on t.transform_id = pt.transform_id
            where pt.pipeline_id = p.pipeline_id) as transforms,
         (select status from dp.api_pipeline_run_log r where r.pipeline_id = p.pipeline_id order by started_at desc limit 1) as last_status,
         (select started_at from dp.api_pipeline_run_log r where r.pipeline_id = p.pipeline_id order by started_at desc limit 1) as last_run_at
       from dp.api_pipeline p
       left join dp.api_param_group g on g.id = p.group_id
       left join dp.api_source s on s.id = g.source_id
       order by p.pipeline_id desc`,
    );
    return NextResponse.json({ ok: true, items: result.rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파이프라인 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

export async function POST(request: Request) {
  let body: PipelineInput = {};
  try {
    body = (await request.json()) as PipelineInput;
  } catch {
    body = {};
  }
  const client = await createPipelineClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const dbSettingId = parseDbSettingIdFromRequest(request);
    const pipelineId = await createPipeline(client, { ...body, dbSettingId });
    await refreshPipelineSchedule(pipelineId);
    return NextResponse.json({ ok: true, pipelineId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파이프라인 생성에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
