import { NextResponse } from "next/server";
import type { WorkflowState } from "@/app/workflow/types";
import {
  deleteSchedule,
  getSchedule,
  normalizeScheduleConfig,
  readSchedules,
  upsertSchedule,
  type ScheduleConfig,
} from "./storage";
import { initializeScheduler, refreshSchedule, removeSchedule } from "./scheduler";

export const runtime = "nodejs";

type SchedulePayload = {
  id?: string;
  name?: string;
  workflow?: WorkflowState;
  schedule?: ScheduleConfig;
};

export async function GET() {
  await initializeScheduler();
  const schedules = await readSchedules();
  return NextResponse.json({ ok: true, schedules });
}

export async function POST(request: Request) {
  await initializeScheduler();
  let payload: SchedulePayload | null = null;
  try {
    payload = (await request.json()) as SchedulePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }
  if (!payload?.id || !payload.name || !payload.workflow || !payload.schedule) {
    return NextResponse.json(
      { ok: false, error: "스케줄 저장에 필요한 정보가 없습니다." },
      { status: 400 },
    );
  }
  const existing = await getSchedule(payload.id);
  const now = new Date().toISOString();
  const entry = {
    id: payload.id,
    name: payload.name,
    workflow: payload.workflow,
    schedule: normalizeScheduleConfig(payload.schedule),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    lastError: existing?.lastError,
  };
  await upsertSchedule(entry);
  await refreshSchedule(entry);
  return NextResponse.json({ ok: true, schedule: entry });
}

export async function DELETE(request: Request) {
  await initializeScheduler();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "id 파라미터가 필요합니다." },
      { status: 400 },
    );
  }
  const removed = await deleteSchedule(id);
  removeSchedule(id);
  return NextResponse.json({ ok: true, removed });
}
