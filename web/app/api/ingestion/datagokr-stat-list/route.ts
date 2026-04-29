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
  const q = (searchParams.get("q") ?? "").trim();

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

    const queryText = `
        select
          p_stat_code,
          stat_code,
          stat_name,
          srch_yn,
          org_cd,
          org_name,
          list_url
        from dp.api_stat_list_datagokr
        where
          (
            $1 = ''
            or (
              trim(srch_yn) = 'Y'
              and (
                stat_name ilike ('%' || $1 || '%')
                or stat_code ilike ('%' || $1 || '%')
              )
            )
          )
        order by
          case
            when split_part(stat_name, ' ', 1) ~ '^[0-9]+(\.[0-9]+)*\.$' then 0
            else 1
          end,
          case
            when split_part(stat_name, ' ', 1) ~ '^[0-9]+(\.[0-9]+)*\.$'
              then string_to_array(regexp_replace(split_part(stat_name, ' ', 1), '\.$', ''), '.')::int[]
            else null
          end,
          stat_name collate "ko-x-icu" asc
        ${q ? "limit 100" : ""}
      `;
    const result = await client.query(queryText, [q]);

    return NextResponse.json({
      ok: true,
      items: result.rows.map((row) => ({
        p_stat_code: String(row.p_stat_code ?? ""),
        stat_code: String(row.stat_code ?? ""),
        stat_name: String(row.stat_name ?? ""),
        srch_yn: String(row.srch_yn ?? ""),
        org_cd: String(row.org_cd ?? ""),
        org_name: String(row.org_name ?? ""),
        list_url: String(row.list_url ?? ""),
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "공공데이터포털 수집대상을 불러오지 못했습니다.";
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

