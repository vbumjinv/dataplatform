import { NextResponse } from "next/server";
import { Client } from "pg";

const CONNECT_TIMEOUT_MS = 5000;
const MAX_PARAMS_PER_QUERY = 30000;

type InsertRequest = {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
  dbType?: "postgres";
  schema?: string;
  table?: string;
  columns?: string[];
  rows?: Array<Array<unknown>>;
  truncate?: boolean;
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeJdbcUrl = (raw: string) => {
  if (raw.startsWith("jdbc:")) {
    return raw.replace(/^jdbc:/, "");
  }
  return raw;
};

const buildConnectionString = (payload: InsertRequest) => {
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

const escapeIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

export async function POST(request: Request) {
  let payload: InsertRequest | null = null;
  try {
    payload = (await request.json()) as InsertRequest;
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

  const schema = isNonEmpty(payload.schema) ? payload.schema : "public";
  if (!isNonEmpty(payload.table)) {
    return NextResponse.json(
      { ok: false, error: "테이블을 선택하세요." },
      { status: 400 },
    );
  }
  if (!payload.columns?.length || !payload.rows?.length) {
    return NextResponse.json(
      { ok: false, error: "저장할 데이터가 없습니다." },
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

  const columns = payload.columns.filter(isNonEmpty);
  const rows = payload.rows;
  if (!columns.length || !rows.length) {
    return NextResponse.json(
      { ok: false, error: "저장할 데이터가 없습니다." },
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

    const escapedColumns = columns.map(escapeIdentifier).join(", ");
    const escapedTable = `${escapeIdentifier(schema)}.${escapeIdentifier(
      payload.table,
    )}`;
    if (payload.truncate) {
      await client.query(`truncate table ${escapedTable}`);
    }

    const maxRowsPerBatch = Math.max(
      1,
      Math.floor(MAX_PARAMS_PER_QUERY / Math.max(columns.length, 1)),
    );
    let inserted = 0;

    for (let start = 0; start < rows.length; start += maxRowsPerBatch) {
      const batchRows = rows.slice(start, start + maxRowsPerBatch);
      const values: unknown[] = [];
      const placeholders = batchRows
        .map((row, rowIndex) => {
          const base = rowIndex * columns.length;
          const rowPlaceholders = columns.map((_, colIndex) => {
            values.push(row[colIndex] ?? null);
            return `$${base + colIndex + 1}`;
          });
          return `(${rowPlaceholders.join(", ")})`;
        })
        .join(", ");

      const query = `insert into ${escapedTable} (${escapedColumns}) values ${placeholders}`;
      await client.query(query, values);
      inserted += batchRows.length;
    }

    return NextResponse.json({ ok: true, inserted });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "데이터 저장에 실패했습니다.";
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
