import { NextResponse } from "next/server";
import {
  connectWithTimeout,
  createDbClientFromRequest,
  parseDbSettingIdFromRequest,
} from "../../visualization/_lib/db";
import { updateTransform, type TransformInput } from "../_lib/persist";

export const runtime = "nodejs";

const parseId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isFinite(id) ? Math.trunc(id) : null;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await context.params;
  const transformId = parseId(raw);
  if (!transformId) {
    return NextResponse.json({ ok: false, error: "잘못된 가공 ID 입니다." }, { status: 400 });
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const res = await client.query(
      `select transform_id, name, transform_type, source_map_id, output_map_id,
              config, output_name, output_unit, output_freq, is_active
       from dp.api_transform where transform_id = $1`,
      [transformId],
    );
    const transform = res.rows[0];
    if (!transform) {
      return NextResponse.json({ ok: false, error: "가공 정의를 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, transform });
  } catch (error) {
    const message = error instanceof Error ? error.message : "가공 조회에 실패했습니다.";
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
  context: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await context.params;
  const transformId = parseId(raw);
  if (!transformId) {
    return NextResponse.json({ ok: false, error: "잘못된 가공 ID 입니다." }, { status: 400 });
  }
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
    await updateTransform(client, transformId, { ...body, dbSettingId });
    return NextResponse.json({ ok: true, transformId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "가공 저장에 실패했습니다.";
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
  context: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await context.params;
  const transformId = parseId(raw);
  if (!transformId) {
    return NextResponse.json({ ok: false, error: "잘못된 가공 ID 입니다." }, { status: 400 });
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    // 출력 파생 시리즈도 함께 제거.
    // viz_map_data → viz_map_mst 에 FK cascade 가 없으므로 data 를 명시적으로 지운다.
    const outputRes = await client.query<{ output_map_id: number | null }>(
      `select output_map_id from dp.api_transform where transform_id = $1`,
      [transformId],
    );
    const outputMapId = outputRes.rows[0]?.output_map_id ?? null;
    await client.query(`delete from dp.api_transform where transform_id = $1`, [transformId]);
    if (outputMapId) {
      await client.query(`delete from dp.viz_map_data where map_id = $1`, [Number(outputMapId)]);
      await client.query(`delete from dp.viz_map_mst where map_id = $1`, [Number(outputMapId)]);
    }
    return NextResponse.json({ ok: true, transformId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "가공 삭제에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
