import { NextResponse } from "next/server";
import { executeApiGroupLoad } from "../load-runner";
import {
  registerLoadJob,
  removeLoadJob,
  setLoadJobBackendPid,
} from "../_lib/load-jobs";

export const runtime = "nodejs";

type LoadRequest = {
  sourceId?: number | string;
  groupId?: number | string;
  truncate?: boolean;
  triggerType?: "manual" | "schedule";
  dbSettingId?: number | string;
  loadTaskId?: string;
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
  const dbSettingId = toValidId(payload?.dbSettingId);
  const loadTaskId =
    typeof payload?.loadTaskId === "string" && payload.loadTaskId.trim().length > 0
      ? payload.loadTaskId.trim()
      : undefined;
  if (!sourceId || !groupId) {
    return NextResponse.json(
      { ok: false, error: "적재 대상이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  const job = registerLoadJob(loadTaskId);
  try {
    const result = await executeApiGroupLoad({
      sourceId,
      groupId,
      truncate: payload?.truncate,
      triggerType: payload?.triggerType === "schedule" ? "schedule" : "manual",
      dbSettingId: dbSettingId ?? undefined,
    }, {
      abortSignal: job.abortController.signal,
      onDbBackendPid: (pid) => {
        setLoadJobBackendPid(job.id, pid);
      },
    });
    return NextResponse.json({
      ok: true,
      loadTaskId: job.id,
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "적재에 실패했습니다.";
    const cancelled = message.includes("취소");
    return NextResponse.json(
      { ok: false, cancelled, loadTaskId: job.id, error: message },
      { status: cancelled ? 499 : 500 },
    );
  } finally {
    removeLoadJob(job.id);
  }
}
