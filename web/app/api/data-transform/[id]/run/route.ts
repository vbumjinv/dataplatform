import { NextResponse } from "next/server";
import { connectWithTimeout, createDbClientFromRequest } from "../../../visualization/_lib/db";
import { runTransform } from "../../_lib/transform-runner";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await context.params;
  const transformId = Number(raw);
  if (!Number.isFinite(transformId)) {
    return NextResponse.json({ ok: false, error: "잘못된 가공 ID 입니다." }, { status: 400 });
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const result = await runTransform(client, Math.trunc(transformId), "manual");
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "가공 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
