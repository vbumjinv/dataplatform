import { NextResponse } from "next/server";
import { connectWithTimeout, createDbClientFromRequest } from "../../visualization/_lib/db";
import { normalizeTransformType, type TransformConfig } from "../_lib/sql-builder";
import { runTransformPreview } from "../_lib/transform-runner";

export const runtime = "nodejs";

type PreviewBody = {
  sourceMapId?: number | null;
  transformType?: string;
  config?: TransformConfig;
};

// 저장 없이 변환 결과 미리보기 (생성/수정 모달에서 사용)
export async function POST(request: Request) {
  let body: PreviewBody = {};
  try {
    body = (await request.json()) as PreviewBody;
  } catch {
    body = {};
  }
  const sourceMapId = Number(body.sourceMapId);
  if (!Number.isFinite(sourceMapId) || sourceMapId <= 0) {
    return NextResponse.json({ ok: false, error: "입력 시리즈를 선택하세요." }, { status: 400 });
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 연결 설정이 없습니다." }, { status: 400 });
  }
  try {
    await connectWithTimeout(client);
    const rows = await runTransformPreview(
      client,
      normalizeTransformType(body.transformType),
      body.config ?? {},
      Math.trunc(sourceMapId),
    );
    return NextResponse.json({ ok: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "미리보기에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
