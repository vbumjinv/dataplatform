import { NextResponse } from "next/server";
import { Client } from "pg";
import {
  buildConnectionString,
  CONNECT_TIMEOUT_MS,
  isNonEmpty,
  resolveDbConfig,
} from "@/app/api/db/_lib/connection";

const MAX_ROWS = 100;

type QueryRequest = {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
  dbType?: "postgres";
  schema?: string;
  table?: string;
  sql?: string;
};

const escapeIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

export async function POST(request: Request) {
  let payload: QueryRequest | null = null;
  try {
    payload = (await request.json()) as QueryRequest;
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

  const schema = isNonEmpty(payload.schema) ? payload.schema : "public";

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

    let result;
    if (isNonEmpty(payload.sql)) {
      const rawSql = payload.sql.trim();
      const lowered = rawSql.toLowerCase();
      if (!lowered.startsWith("select")) {
        return NextResponse.json(
          { ok: false, error: "SELECT 쿼리만 실행할 수 있습니다." },
          { status: 400 },
        );
      }
      if (rawSql.includes(";")) {
        return NextResponse.json(
          { ok: false, error: "단일 SELECT 쿼리만 허용됩니다." },
          { status: 400 },
        );
      }
      const limitedSql = /limit\s+\d+$/i.test(rawSql)
        ? rawSql
        : `${rawSql} limit ${MAX_ROWS}`;
      result = await client.query(limitedSql);
    } else {
      if (!isNonEmpty(payload.table)) {
        return NextResponse.json(
          { ok: false, error: "테이블을 선택하세요." },
          { status: 400 },
        );
      }
      const escapedTable = `${escapeIdentifier(schema)}.${escapeIdentifier(
        payload.table,
      )}`;
      result = await client.query(
        `select * from ${escapedTable} limit ${MAX_ROWS}`,
      );
    }

    let columns: Array<{ name: string; dataType: string }> | undefined;
    if (!isNonEmpty(payload.sql) && isNonEmpty(payload.table)) {
      const meta = await client.query(
        `
          select column_name, data_type
          from information_schema.columns
          where table_schema = $1
            and table_name = $2
          order by ordinal_position
        `,
        [schema, payload.table],
      );
      columns = meta.rows.map((row) => ({
        name: row.column_name as string,
        dataType: row.data_type as string,
      }));
    }

    return NextResponse.json({ ok: true, rows: result.rows, columns });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "데이터 조회에 실패했습니다.";
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
