import { NextResponse } from "next/server";
import { Client } from "pg";
import {
  buildConnectionString,
  CONNECT_TIMEOUT_MS,
  resolveDbConfig,
} from "@/app/api/db/_lib/connection";

type SchemasRequest = {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
  dbType?: "postgres";
};

export async function POST(request: Request) {
  let payload: SchemasRequest | null = null;
  try {
    payload = (await request.json()) as SchemasRequest;
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
        select schema_name
        from information_schema.schemata
        where schema_name not like 'pg_%'
          and schema_name <> 'information_schema'
        order by schema_name
      `,
    );

    const schemas = result.rows.map((row) => row.schema_name as string);
    return NextResponse.json({ ok: true, schemas });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스키마 조회에 실패했습니다.";
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
