import { NextResponse } from "next/server";
import { Client } from "pg";
import {
  buildConnectionString,
  CONNECT_TIMEOUT_MS,
  isNonEmpty,
  resolveDbConfig,
} from "@/app/api/db/_lib/connection";

type ConnectRequest = {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
  dbType?: "postgres";
};

export async function POST(request: Request) {
  let payload: ConnectRequest | null = null;
  try {
    payload = (await request.json()) as ConnectRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  if (!payload || (payload.dbType && payload.dbType !== "postgres")) {
    return NextResponse.json(
      { ok: false, error: "현재 Postgres만 지원합니다." },
      { status: 400 },
    );
  }

  const hasInlinePayload =
    payload.url !== undefined ||
    payload.database !== undefined ||
    payload.user !== undefined ||
    payload.password !== undefined;

  if (hasInlinePayload) {
    if (
      !isNonEmpty(payload.url) ||
      !isNonEmpty(payload.database) ||
      !isNonEmpty(payload.user) ||
      !isNonEmpty(payload.password)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "모든 값을 입력하세요",
        },
        { status: 400 },
      );
    }
  }

  const resolved = hasInlinePayload
    ? {
        dbType: "postgres" as const,
        url: payload.url!.trim(),
        database: payload.database!.trim(),
        user: payload.user!.trim(),
        password: payload.password!,
      }
    : await resolveDbConfig(payload);

  if (!resolved) {
    return NextResponse.json(
      { ok: false, error: "DB 설정이 없습니다. 'DB 설정' 메뉴에서 먼저 저장하세요." },
      { status: 400 },
    );
  }
  const connectionString = buildConnectionString(resolved);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  const startedAt = Date.now();
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.query("select 1");
      })(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DB 연결에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
