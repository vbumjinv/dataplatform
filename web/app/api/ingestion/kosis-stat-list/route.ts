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

    const { searchParams } = new URL(request.url);
    const parent = (searchParams.get("parent") ?? "*").trim() || "*";
    const vwCd = (searchParams.get("vw") ?? "").trim();

    console.time("kosis-stat-list:db");
    const result = await client.query(
      `
        select
          node_id,
          p_stat_code,
          stat_code,
          tree_no,
          stat_name_no,
          stat_name,
          srch_yn,
          vw_cd,
          stat_id,
          send_de,
          cycle
        from dp.api_stat_list_kosis
        where p_stat_code = $1
          and ($2 = '' or vw_cd = $2)
        order by tree_no asc
      `,
      [parent, vwCd],
    );
    console.timeEnd("kosis-stat-list:db");

    console.time("kosis-stat-list:transform");
    const items = result.rows.map((row) => ({
      p_stat_code: String(row.p_stat_code ?? ""),
      stat_code: String(row.stat_code ?? ""),
      tree_no: String(row.tree_no ?? ""),
      stat_name_no: String(row.stat_name_no ?? ""),
      stat_name: String(row.stat_name ?? ""),
      srch_yn: String(row.srch_yn ?? ""),
      vw_cd: String(row.vw_cd ?? ""),
      stat_id: String(row.stat_id ?? ""),
      send_de: String(row.send_de ?? ""),
      cycle: String(row.cycle ?? ""),
      node_id: Number(row.node_id ?? 0),
    }));
    console.timeEnd("kosis-stat-list:transform");
    console.time("kosis-stat-list:response");
    const response = NextResponse.json({
      ok: true,
      items,
    });
    console.timeEnd("kosis-stat-list:response");
    return response;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "통계청 통계표 목록을 불러오지 못했습니다.";
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

