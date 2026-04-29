import { NextResponse } from "next/server";
import { executeApiGroupLoad } from "../load-runner";

export const runtime = "nodejs";

type LoadRequest = {
  sourceId?: number | string;
  groupId?: number | string;
  truncate?: boolean;
  triggerType?: "manual" | "schedule";
};

const isValidId = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const toValidId = (value: unknown) => {
  if (typeof value === "string") {
    const parsed = Number(value);
    return isValidId(parsed) ? parsed : null;
  }
  return isValidId(value) ? value : null;
};


export async function POST(request: Request) {
  let payload: LoadRequest | null = null;
  try {
    payload = (await request.json()) as LoadRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }
  const sourceId = toValidId(payload?.sourceId);
  const groupId = toValidId(payload?.groupId);
  if (!sourceId || !groupId) {
    return NextResponse.json(
      { ok: false, error: "적재 대상이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  try {
    const result = await executeApiGroupLoad({
      sourceId,
      groupId,
      truncate: payload?.truncate,
      triggerType: payload?.triggerType === "schedule" ? "schedule" : "manual",
    });
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "적재에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
