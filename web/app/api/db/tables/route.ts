import { NextResponse } from "next/server";
import { Client } from "pg";
import {
  buildConnectionString,
  CONNECT_TIMEOUT_MS,
  isNonEmpty,
  resolveDbConfig,
} from "@/app/api/db/_lib/connection";

type TablesRequest = {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
  dbType?: "postgres";
  schema?: string;
};

export async function POST(request: Request) {
  let payload: TablesRequest | null = null;
  try {
    payload = (await request.json()) as TablesRequest;
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

  const resolved = await resolveDbConfig(payload);
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

  const schema = isNonEmpty(payload.schema) ? payload.schema : "public";
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    const result = await client.query(
      `
        select table_name
        from information_schema.tables
        where table_schema = $1
          and table_type = 'BASE TABLE'
        order by table_name
      `,
      [schema],
    );

    const tables = result.rows.map((row) => row.table_name as string);
    return NextResponse.json({ ok: true, tables });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "테이블 조회에 실패했습니다.";
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
