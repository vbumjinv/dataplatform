import { NextResponse } from "next/server";
import {
  canUseDb,
  connectWithTimeout,
  createDbClientFromRequest,
  parseDbSettingIdFromRequest,
} from "../visualization/_lib/db";
import { createTransform, type TransformInput } from "./_lib/persist";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `select
         t.transform_id, t.name, t.transform_type, t.source_map_id, t.output_map_id,
         t.config, t.output_name, t.output_unit, t.output_freq, t.is_active,
         sm.series_name as source_series_name,
         (select count(*)::int from dp.viz_map_data d where d.map_id = t.output_map_id) as output_count,
         (select status from dp.api_transform_run_log r where r.transform_id = t.transform_id order by started_at desc limit 1) as last_status,
         (select started_at from dp.api_transform_run_log r where r.transform_id = t.transform_id order by started_at desc limit 1) as last_run_at
       from dp.api_transform t
       left join dp.viz_map_mst sm on sm.map_id = t.source_map_id
       order by t.transform_id desc`,
    );
    return NextResponse.json({ ok: true, items: result.rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "가공 목록 조회에 실패했습니다.";
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
  let body: TransformInput = {};
  try {
    body = (await request.json()) as TransformInput;
  } catch {
    body = {};
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const dbSettingId = parseDbSettingIdFromRequest(request);
    const transformId = await createTransform(client, { ...body, dbSettingId });
    return NextResponse.json({ ok: true, transformId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "가공 생성에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
