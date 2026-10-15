import { NextResponse } from "next/server";
import { previewDraftApi } from "@/app/api/ingestion/load-runner";
import { requireAdminSession } from "../_lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

type DraftBody = {
  sourceId?: number | string;
  dbSettingId?: number | string;
  params?: Array<{
    key?: string;
    value?: string;
    location?: string;
    order?: number;
    role?: string | null;
    encodeMode?: string;
  }>;
};

const toId = (value: unknown) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status },
    );
  }

  let body: DraftBody;
  try {
    body = (await request.json()) as DraftBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  const sourceId = toId(body.sourceId);
  if (!sourceId) {
    return NextResponse.json(
      { ok: false, error: "기존 기관의 sourceId가 필요합니다." },
      { status: 400 },
    );
  }
  const rawParams = Array.isArray(body.params) ? body.params.slice(0, 50) : [];
  const hasSecret = rawParams.some((param) =>
    /api.?key|token|secret|authorization|auth.?key/i.test(
      String(param.key ?? ""),
    ),
  );
  if (hasSecret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "draft preview 요청에 인증정보를 포함할 수 없습니다. 기관 설정의 API 키를 사용합니다.",
      },
      { status: 400 },
    );
  }
  const params = rawParams
    .map((param) => ({
      key: String(param.key ?? "").trim().slice(0, 100),
      value: String(param.value ?? "").trim().slice(0, 2_000),
      location: param.location === "path" ? ("path" as const) : ("query" as const),
      order: Number(param.order) || 0,
      role: param.role ? String(param.role).slice(0, 50) : null,
      encodeMode: param.encodeMode
        ? String(param.encodeMode).slice(0, 30)
        : "encode",
    }))
    .filter((param) => param.key && param.value);

  try {
    const result = await previewDraftApi({
      sourceId,
      params,
      dbSettingId: toId(body.dbSettingId),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "draft preview에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
