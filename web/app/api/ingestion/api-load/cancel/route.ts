import { NextResponse } from "next/server";
import { Client } from "pg";
import { getLoadJob } from "../../_lib/load-jobs";
import { resolveDbConfig } from "../../../db/_lib/connection";

export const runtime = "nodejs";

type CancelRequest = {
  loadTaskId?: string;
  dbSettingId?: number | string;
};

const normalizeJdbcUrl = (raw: string) => {
  if (raw.startsWith("jdbc:")) {
    return raw.replace(/^jdbc:/, "");
  }
  return raw;
};

const buildConnectionString = (payload: {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
}) => {
  if (!payload.url) return null;
  const normalized = normalizeJdbcUrl(payload.url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return null;
  }
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};

const toValidId = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
};

export async function POST(request: Request) {
  let payload: CancelRequest | null = null;
  try {
    payload = (await request.json()) as CancelRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "요청 본문이 비어있습니다." }, { status: 400 });
  }

  const loadTaskId = (payload?.loadTaskId ?? "").trim();
  if (!loadTaskId) {
    return NextResponse.json({ ok: false, error: "취소할 작업 ID가 필요합니다." }, { status: 400 });
  }

  const job = getLoadJob(loadTaskId);
  if (!job) {
    return NextResponse.json({
      ok: true,
      cancelled: false,
      loadTaskId,
      message: "이미 종료되었거나 존재하지 않는 작업입니다.",
    });
  }

  job.abortController.abort();
  let dbCancelRequested = false;

  const dbSettingId = toValidId(payload?.dbSettingId);
  if (job.dbBackendPid && dbSettingId) {
    const resolvedDb = await resolveDbConfig({ settingId: dbSettingId });
    const connectionString = resolvedDb ? buildConnectionString(resolvedDb) : null;
    if (connectionString) {
      const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        const result = await client.query<{ cancelled: boolean }>(
          "select pg_cancel_backend($1)::boolean as cancelled",
          [job.dbBackendPid],
        );
        dbCancelRequested = Boolean(result.rows[0]?.cancelled);
      } catch {
        dbCancelRequested = false;
      } finally {
        try {
          await client.end();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    cancelled: true,
    loadTaskId,
    dbCancelRequested,
    message: "적재 중단을 요청했습니다.",
  });
}

