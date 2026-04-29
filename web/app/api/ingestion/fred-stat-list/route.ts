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

export async function GET(request: Request) {
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

  const { searchParams } = new URL(request.url);
  const parent = (searchParams.get("parent") ?? "").trim();

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

    console.time("fred-stat-list:response");
    const queryText = parent
      ? `
        select
          node_id,
          parent_node_id,
          node_name,
          node_type,
          stat_code,
          cycle,
          srch_yn,
          leaf_yn,
          sort_ord,
          org_name
        from dp.api_stat_list_fred
        where parent_node_id = $1
        order by coalesce(sort_ord, 999999), node_name asc
      `
      : `
        select
          node_id,
          parent_node_id,
          node_name,
          node_type,
          stat_code,
          cycle,
          srch_yn,
          leaf_yn,
          sort_ord,
          org_name
        from dp.api_stat_list_fred
        where parent_node_id is null
        order by coalesce(sort_ord, 999999), node_name asc
      `;

    console.time("fred-stat-list:db");
    const result = await client.query(queryText, parent ? [parent] : []);
    console.timeEnd("fred-stat-list:db");

    console.time("fred-stat-list:transform");
    const items = result.rows.map((row) => ({
      node_id: String(row.node_id ?? ""),
      parent_node_id: row.parent_node_id == null ? null : String(row.parent_node_id),
      node_name: String(row.node_name ?? ""),
      node_type: String(row.node_type ?? ""),
      stat_code: row.stat_code == null ? null : String(row.stat_code),
      cycle: row.cycle == null ? null : String(row.cycle),
      srch_yn: row.srch_yn == null ? null : String(row.srch_yn),
      leaf_yn: row.leaf_yn == null ? null : String(row.leaf_yn),
      sort_ord: row.sort_ord == null ? null : Number(row.sort_ord),
      org_name: row.org_name == null ? null : String(row.org_name),
    }));
    console.timeEnd("fred-stat-list:transform");
    console.timeEnd("fred-stat-list:response");

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "FRED 수집대상을 불러오지 못했습니다.";
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

