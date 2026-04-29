import { NextResponse } from "next/server";
import { Client } from "pg";

export const runtime = "nodejs";

const CONNECT_TIMEOUT_MS = 5000;
const DB_CONFIG = {
  url: process.env.DP_DB_URL,
  database: process.env.DP_DB_NAME,
  user: process.env.DP_DB_USER,
  password: process.env.DP_DB_PASSWORD,
};

type MetaRequest = {
  action?: "schemas" | "tables" | "columns";
  schema?: string;
  table?: string;
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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

export async function POST(request: Request) {
  let payload: MetaRequest | null = null;
  try {
    payload = (await request.json()) as MetaRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  if (
    !isNonEmpty(DB_CONFIG.url) ||
    !isNonEmpty(DB_CONFIG.database) ||
    !isNonEmpty(DB_CONFIG.user) ||
    !isNonEmpty(DB_CONFIG.password)
  ) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const connectionString = buildConnectionString(DB_CONFIG);
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

    const action = payload?.action ?? "schemas";
    if (action === "schemas") {
      const result = await client.query(
        `
          select schema_name
          from information_schema.schemata
          where schema_name not in ('pg_catalog', 'information_schema')
          order by schema_name
        `,
      );
      return NextResponse.json({
        ok: true,
        schemas: result.rows.map((row) => row.schema_name as string),
      });
    }

    const schema = payload?.schema?.trim() || "public";
    if (action === "tables") {
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
      return NextResponse.json({
        ok: true,
        tables: result.rows.map((row) => row.table_name as string),
      });
    }

    const table = payload?.table?.trim();
    if (!table) {
      return NextResponse.json(
        { ok: false, error: "테이블을 선택하세요." },
        { status: 400 },
      );
    }
    const result = await client.query(
      `
        select column_name, data_type
        from information_schema.columns
        where table_schema = $1
          and table_name = $2
        order by ordinal_position
      `,
      [schema, table],
    );
    return NextResponse.json({
      ok: true,
      columns: result.rows.map((row) => ({
        name: row.column_name as string,
        dataType: row.data_type as string,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DB 메타 조회에 실패했습니다.";
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
