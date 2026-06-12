import { NextResponse } from "next/server";
import { Client } from "pg";
import { buildConnectionString, resolveDbConfig } from "../../db/_lib/connection";

export const runtime = "nodejs";

const CONNECT_TIMEOUT_MS = 5000;
const MAX_PARAMS_PER_QUERY = 30000;

type TargetColumnType = "text" | "numeric" | "date" | "timestamp";

type TargetColumn = {
  name?: string;
  type?: TargetColumnType;
};

type PdfLoadRequest = {
  dbSettingId?: number | string;
  schema?: string;
  table?: string;
  targetColumns?: TargetColumn[];
  rows?: Array<Array<unknown>>;
  createIfMissing?: boolean;
  truncate?: boolean;
};

const COLUMN_SQL_TYPE: Record<TargetColumnType, string> = {
  text: "text",
  numeric: "numeric",
  date: "date",
  timestamp: "timestamp",
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const escapeIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

// 입력 식별자 안전화: 따옴표는 escapeIdentifier 가 처리하지만, 비정상 길이/빈값은 거른다.
const sanitizeIdentifier = (value: string) => value.trim().slice(0, 63);

// 셀 값을 대상 컬럼 타입에 맞게 정규화한다. (load-runner 의 normalizeCellByType 와 동일한 취지)
const normalizeCell = (value: unknown, type: TargetColumnType): unknown => {
  if (value == null) return null;
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return null;

  if (type === "numeric") {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    let text = String(raw).replace(/,/g, "").trim();
    // 괄호 표기 음수: (1,234) -> -1234
    const negParen = text.match(/^\((.*)\)$/);
    if (negParen) text = `-${negParen[1]}`;
    text = text.replace(/[%\s]/g, "");
    if (!/^[-+]?\d*\.?\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (type === "date" || type === "timestamp") {
    // 문자열로 넘기고 Postgres 캐스팅에 맡긴다. 형식이 깨지면 INSERT 단계에서 에러.
    return String(raw).trim();
  }
  return String(raw);
};

export async function POST(request: Request) {
  let payload: PdfLoadRequest | null = null;
  try {
    payload = (await request.json()) as PdfLoadRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  const schema = isNonEmpty(payload?.schema)
    ? sanitizeIdentifier(payload!.schema!)
    : "public";
  const table = isNonEmpty(payload?.table)
    ? sanitizeIdentifier(payload!.table!)
    : "";
  if (!table) {
    return NextResponse.json(
      { ok: false, error: "테이블 이름을 입력하세요." },
      { status: 400 },
    );
  }

  const targetColumns = (payload?.targetColumns ?? [])
    .map((col) => ({
      name: isNonEmpty(col?.name) ? sanitizeIdentifier(col!.name!) : "",
      type: (col?.type && COLUMN_SQL_TYPE[col.type] ? col.type : "text") as TargetColumnType,
    }))
    .filter((col) => col.name.length > 0);

  if (targetColumns.length === 0) {
    return NextResponse.json(
      { ok: false, error: "대상 컬럼이 정의되지 않았습니다." },
      { status: 400 },
    );
  }
  const rows = Array.isArray(payload?.rows) ? payload!.rows! : [];
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "저장할 데이터가 없습니다." },
      { status: 400 },
    );
  }

  const selectedSettingId =
    typeof payload?.dbSettingId === "string"
      ? Number(payload.dbSettingId)
      : payload?.dbSettingId;
  const resolvedDb = await resolveDbConfig({
    settingId:
      typeof selectedSettingId === "number" && Number.isFinite(selectedSettingId)
        ? selectedSettingId
        : null,
  });
  if (!resolvedDb) {
    return NextResponse.json(
      { ok: false, error: "DB 연결 설정을 찾을 수 없습니다." },
      { status: 400 },
    );
  }
  const connectionString = buildConnectionString(resolvedDb);
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
  let transactionStarted = false;

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    const escapedTable = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;
    const columnNames = targetColumns.map((col) => col.name);
    const escapedColumns = columnNames.map(escapeIdentifier).join(", ");

    await client.query("begin");
    transactionStarted = true;

    let created = false;
    if (payload?.createIfMissing) {
      await client.query(
        `create schema if not exists ${escapeIdentifier(schema)}`,
      );
      const columnDefs = targetColumns
        .map((col) => `${escapeIdentifier(col.name)} ${COLUMN_SQL_TYPE[col.type]}`)
        .join(", ");
      await client.query(
        `create table if not exists ${escapedTable} (${columnDefs})`,
      );
      created = true;
    }

    if (payload?.truncate) {
      await client.query(`truncate table ${escapedTable}`);
    }

    const normalizedRows = rows.map((row) =>
      targetColumns.map((col, colIndex) => normalizeCell(row[colIndex], col.type)),
    );

    const maxRowsPerBatch = Math.max(
      1,
      Math.floor(MAX_PARAMS_PER_QUERY / Math.max(columnNames.length, 1)),
    );
    let inserted = 0;
    for (let start = 0; start < normalizedRows.length; start += maxRowsPerBatch) {
      const batchRows = normalizedRows.slice(start, start + maxRowsPerBatch);
      const values: unknown[] = [];
      const placeholders = batchRows
        .map((row, rowIndex) => {
          const base = rowIndex * columnNames.length;
          const rowPlaceholders = columnNames.map((_, colIndex) => {
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

    await client.query("commit");
    transactionStarted = false;

    return NextResponse.json({ ok: true, created, inserted });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("rollback");
      } catch {
        // ignore rollback errors
      }
    }
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
