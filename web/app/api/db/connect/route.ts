import { NextResponse } from "next/server";
import { Client } from "pg";

const CONNECT_TIMEOUT_MS = 5000;

type ConnectRequest = {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
  dbType?: "postgres";
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeJdbcUrl = (raw: string) => {
  if (raw.startsWith("jdbc:")) {
    return raw.replace(/^jdbc:/, "");
  }
  return raw;
};

const buildConnectionString = (payload: ConnectRequest) => {
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

  if (!payload || payload.dbType !== "postgres") {
    return NextResponse.json(
      { ok: false, error: "현재 Postgres만 지원합니다." },
      { status: 400 },
    );
  }

  if (
    !isNonEmpty(payload.url) ||
    !isNonEmpty(payload.database) ||
    !isNonEmpty(payload.user) ||
    !isNonEmpty(payload.password)
  ) {
    return NextResponse.json(
      { ok: false, error: "DB 설정 정보를 모두 입력하세요." },
      { status: 400 },
    );
  }

  const connectionString = buildConnectionString(payload);
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
