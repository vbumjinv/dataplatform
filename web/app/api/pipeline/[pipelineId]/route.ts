import { NextResponse } from "next/server";
import { connectWithTimeout, createPipelineClientFromRequest, parseDbSettingIdFromRequest } from "../_lib/db";
import { updatePipeline, type PipelineInput } from "../_lib/persist";
import {
  refreshPipelineSchedule,
  removePipelineSchedule,
} from "../_lib/pipeline-scheduler";

export const runtime = "nodejs";

const parseId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isFinite(id) ? Math.trunc(id) : null;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId: raw } = await context.params;
  const pipelineId = parseId(raw);
  if (!pipelineId) {
    return NextResponse.json({ ok: false, error: "잘못된 파이프라인 ID 입니다." }, { status: 400 });
  }
  const client = await createPipelineClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const pipelineRes = await client.query(
      `select pipeline_id, name, description, group_id, schedule_enabled, schedule_type,
              schedule_interval_minutes, schedule_cron_expr, is_active
       from dp.api_pipeline where pipeline_id = $1`,
      [pipelineId],
    );
    const pipeline = pipelineRes.rows[0];
    if (!pipeline) {
      return NextResponse.json({ ok: false, error: "파이프라인을 찾을 수 없습니다." }, { status: 404 });
    }
    const mapsRes = await client.query<{ map_id: number }>(
      `select map_id from dp.api_pipeline_map where pipeline_id = $1 order by sort_order, id`,
      [pipelineId],
    );
    const transformsRes = await client.query<{ transform_id: number }>(
      `select transform_id from dp.api_pipeline_transform where pipeline_id = $1 order by sort_order, id`,
      [pipelineId],
    );
    return NextResponse.json({
      ok: true,
      pipeline,
      mapIds: mapsRes.rows.map((r) => Number(r.map_id)),
      transformIds: transformsRes.rows.map((r) => Number(r.transform_id)),
    });
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId: raw } = await context.params;
  const pipelineId = parseId(raw);
  if (!pipelineId) {
    return NextResponse.json({ ok: false, error: "잘못된 파이프라인 ID 입니다." }, { status: 400 });
  }
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
    await updatePipeline(client, pipelineId, { ...body, dbSettingId });
    await refreshPipelineSchedule(pipelineId);
    return NextResponse.json({ ok: true, pipelineId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파이프라인 저장에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId: raw } = await context.params;
  const pipelineId = parseId(raw);
  if (!pipelineId) {
    return NextResponse.json({ ok: false, error: "잘못된 파이프라인 ID 입니다." }, { status: 400 });
  }
  const client = await createPipelineClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    await client.query(`delete from dp.api_pipeline where pipeline_id = $1`, [pipelineId]);
    removePipelineSchedule(pipelineId);
    return NextResponse.json({ ok: true, pipelineId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파이프라인 삭제에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
