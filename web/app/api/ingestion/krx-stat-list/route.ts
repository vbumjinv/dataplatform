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

export async function GET() {
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

    const result = await client.query(
      `
        select
          p_api_id,
          api_id,
          api_name,
          api_path,
          category_name,
          cycle,
          srch_yn,
          category_sort,
          api_sort
        from dp.api_stat_list_krx
        where coalesce(srch_yn, 'Y') = 'Y'
        order by category_sort asc nulls last, api_sort asc nulls last, api_id asc
      `,
    );

    return NextResponse.json({
      ok: true,
      items: result.rows.map((row) => ({
        p_api_id: String(row.p_api_id ?? ""),
        api_id: String(row.api_id ?? ""),
        api_name: String(row.api_name ?? ""),
        api_path: String(row.api_path ?? "").trim() || "gen",
        category_name: String(row.category_name ?? ""),
        cycle: String(row.cycle ?? "D"),
        srch_yn: String(row.srch_yn ?? "Y"),
        category_sort: Number.isFinite(Number(row.category_sort))
          ? Number(row.category_sort)
          : Number.MAX_SAFE_INTEGER,
        api_sort: Number.isFinite(Number(row.api_sort))
          ? Number(row.api_sort)
          : Number.MAX_SAFE_INTEGER,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "KRX API 목록을 불러오지 못했습니다.";
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
