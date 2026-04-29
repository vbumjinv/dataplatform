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

const normalizeJdbcUrl = (raw: string) =>
  raw.startsWith("jdbc:") ? raw.replace(/^jdbc:/, "") : raw;

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
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return null;
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};

const canUseDb = () =>
  isNonEmpty(DB_CONFIG.url) &&
  isNonEmpty(DB_CONFIG.database) &&
  isNonEmpty(DB_CONFIG.user) &&
  isNonEmpty(DB_CONFIG.password);

export async function GET() {
  if (!canUseDb()) {
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

    const [summaryResult, dailyResult, bySourceResult, failureResult] = await Promise.all([
      client.query(
        `
          select
            count(*)::int as total_runs,
            count(*) filter (where status = 'success')::int as success_runs,
            count(*) filter (where status = 'error')::int as error_runs,
            coalesce(sum(inserted_count), 0)::bigint as inserted_total,
            max(started_at) as last_run_at
          from dp.api_load_log
        `,
      ),
      client.query(
        `
          select
            to_char(started_at::date, 'YYYY-MM-DD') as run_date,
            count(*)::int as total_runs,
            count(*) filter (where status = 'success')::int as success_runs,
            count(*) filter (where status = 'error')::int as error_runs,
            coalesce(sum(inserted_count), 0)::bigint as inserted_total
          from dp.api_load_log
          where started_at >= (current_date - interval '13 days')
          group by started_at::date
          order by started_at::date asc
        `,
      ),
      client.query(
        `
          select
            l.source_id::bigint as source_id,
            coalesce(s.name, '(미상)') as source_name,
            count(*)::int as total_runs,
            count(*) filter (where l.status = 'success')::int as success_runs,
            count(*) filter (where l.status = 'error')::int as error_runs
          from dp.api_load_log l
          left join dp.api_source s on s.id = l.source_id
          where l.started_at >= (now() - interval '30 days')
          group by l.source_id, s.name
          order by total_runs desc, source_name asc
          limit 12
        `,
      ),
      client.query(
        `
          select
            l.load_log_id::bigint as load_log_id,
            l.started_at,
            coalesce(s.name, '(미상)') as source_name,
            g.name as group_name,
            l.error_stage,
            l.error_message
          from dp.api_load_log l
          left join dp.api_source s on s.id = l.source_id
          left join dp.api_param_group g on g.id = l.group_id
          where l.status = 'error'
          order by l.started_at desc
          limit 20
        `,
      ),
    ]);

    const summaryRow = summaryResult.rows[0] as
      | {
          total_runs: number;
          success_runs: number;
          error_runs: number;
          inserted_total: number;
          last_run_at: Date | null;
        }
      | undefined;
    const totalRuns = Number(summaryRow?.total_runs ?? 0);
    const successRuns = Number(summaryRow?.success_runs ?? 0);
    const errorRuns = Number(summaryRow?.error_runs ?? 0);
    const insertedTotal = Number(summaryRow?.inserted_total ?? 0);
    const successRate = totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0;

    return NextResponse.json({
      ok: true,
      summary: {
        totalRuns,
        successRuns,
        errorRuns,
        successRate: Number(successRate.toFixed(1)),
        insertedTotal,
        lastRunAt: summaryRow?.last_run_at
          ? new Date(summaryRow.last_run_at).toISOString()
          : null,
      },
      daily: dailyResult.rows.map((row) => ({
        runDate: String(row.run_date),
        totalRuns: Number(row.total_runs ?? 0),
        successRuns: Number(row.success_runs ?? 0),
        errorRuns: Number(row.error_runs ?? 0),
        insertedTotal: Number(row.inserted_total ?? 0),
      })),
      bySource: bySourceResult.rows.map((row) => {
        const srcTotal = Number(row.total_runs ?? 0);
        const srcSuccess = Number(row.success_runs ?? 0);
        return {
          sourceId: Number(row.source_id ?? 0),
          sourceName: String(row.source_name ?? "(미상)"),
          totalRuns: srcTotal,
          successRuns: srcSuccess,
          errorRuns: Number(row.error_runs ?? 0),
          successRate: srcTotal > 0 ? Number(((srcSuccess / srcTotal) * 100).toFixed(1)) : 0,
        };
      }),
      recentFailures: failureResult.rows.map((row) => ({
        loadLogId: Number(row.load_log_id ?? 0),
        startedAt: new Date(row.started_at as Date).toISOString(),
        sourceName: String(row.source_name ?? "(미상)"),
        groupName: row.group_name ? String(row.group_name) : null,
        errorStage: row.error_stage ? String(row.error_stage) : null,
        errorMessage: row.error_message ? String(row.error_message) : null,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "수집 현황을 불러오지 못했습니다.";
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
