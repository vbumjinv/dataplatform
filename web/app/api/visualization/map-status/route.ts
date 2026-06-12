import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClientFromRequest } from "../_lib/db";
import { canUseMapRunLog } from "../_lib/map-run-log";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    await connectWithTimeout(client);
    const available = await canUseMapRunLog(client);
    if (!available) {
      return NextResponse.json({
        ok: true,
        summary: {
          totalRuns: 0,
          successRuns: 0,
          errorRuns: 0,
          successRate: 0,
          affectedTotal: 0,
          lastRunAt: null,
        },
        daily: [],
        dailyDetails: [],
        recentFailures: [],
      });
    }

    const [summaryResult, dailyResult, dailyDetailResult, failureResult] = await Promise.all([
      client.query(
        `
          select
            count(*)::int as total_runs,
            count(*) filter (where status = 'success')::int as success_runs,
            count(*) filter (where status = 'error')::int as error_runs,
            coalesce(sum(affected_count), 0)::bigint as affected_total,
            max(started_at) as last_run_at
          from dp.viz_map_run_log
          where started_at::date = current_date
        `,
      ),
      client.query(
        `
          select
            to_char(started_at::date, 'YYYY-MM-DD') as run_date,
            count(*)::int as total_runs,
            count(*) filter (where status = 'success')::int as success_runs,
            count(*) filter (where status = 'error')::int as error_runs,
            coalesce(sum(affected_count), 0)::bigint as affected_total
          from dp.viz_map_run_log
          where started_at >= (current_date - interval '13 days')
          group by started_at::date
          order by started_at::date asc
        `,
      ),
      client.query(
        `
          select
            to_char(l.started_at::date, 'YYYY-MM-DD') as run_date,
            l.run_log_id::bigint as run_log_id,
            l.started_at,
            coalesce(l.series_name, m.series_name, '(미상)') as series_name,
            l.map_id::bigint as map_id,
            l.trigger_type,
            l.run_mode,
            l.status,
            coalesce(l.affected_count, 0)::bigint as affected_count,
            l.error_message
          from dp.viz_map_run_log l
          left join dp.viz_map_mst m on m.map_id = l.map_id
          where l.started_at >= (current_date - interval '13 days')
            and l.status in ('success', 'error')
          order by l.started_at desc
        `,
      ),
      client.query(
        `
          select
            l.run_log_id::bigint as run_log_id,
            l.started_at,
            coalesce(l.series_name, m.series_name, '(미상)') as series_name,
            l.map_id::bigint as map_id,
            l.trigger_type,
            l.run_mode,
            l.status,
            coalesce(l.affected_count, 0)::bigint as affected_count,
            l.error_message
          from dp.viz_map_run_log l
          left join dp.viz_map_mst m on m.map_id = l.map_id
          where l.started_at >= (current_date - interval '6 days')
          order by l.started_at desc
        `,
      ),
    ]);

    const summaryRow = summaryResult.rows[0] as
      | {
          total_runs: number;
          success_runs: number;
          error_runs: number;
          affected_total: number;
          last_run_at: Date | null;
        }
      | undefined;
    const totalRuns = Number(summaryRow?.total_runs ?? 0);
    const successRuns = Number(summaryRow?.success_runs ?? 0);
    const errorRuns = Number(summaryRow?.error_runs ?? 0);
    const affectedTotal = Number(summaryRow?.affected_total ?? 0);
    const successRate = totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0;

    return NextResponse.json({
      ok: true,
      summary: {
        totalRuns,
        successRuns,
        errorRuns,
        successRate: Number(successRate.toFixed(1)),
        affectedTotal,
        lastRunAt: summaryRow?.last_run_at ? new Date(summaryRow.last_run_at).toISOString() : null,
      },
      daily: dailyResult.rows.map((row) => ({
        runDate: String(row.run_date),
        totalRuns: Number(row.total_runs ?? 0),
        successRuns: Number(row.success_runs ?? 0),
        errorRuns: Number(row.error_runs ?? 0),
        affectedTotal: Number(row.affected_total ?? 0),
      })),
      dailyDetails: dailyDetailResult.rows.map((row) => ({
        runDate: String(row.run_date),
        runLogId: Number(row.run_log_id ?? 0),
        startedAt: new Date(row.started_at as Date).toISOString(),
        seriesName: String(row.series_name ?? "(미상)"),
        mapId: Number(row.map_id ?? 0),
        triggerType: String(row.trigger_type ?? "")
          .trim()
          .toLowerCase()
          .startsWith("sched")
          ? "schedule"
          : "manual",
        runMode: String(row.run_mode ?? "")
          .trim()
          .toLowerCase()
          .startsWith("re")
          ? "regenerate"
          : "generate",
        status: row.status === "success" ? "success" : "error",
        affectedCount: Number(row.affected_count ?? 0),
        errorMessage: row.error_message ? String(row.error_message) : null,
      })),
      recentFailures: failureResult.rows.map((row) => ({
        runLogId: Number(row.run_log_id ?? 0),
        startedAt: new Date(row.started_at as Date).toISOString(),
        seriesName: String(row.series_name ?? "(미상)"),
        mapId: Number(row.map_id ?? 0),
        triggerType: String(row.trigger_type ?? "")
          .trim()
          .toLowerCase()
          .startsWith("sched")
          ? "schedule"
          : "manual",
        runMode: String(row.run_mode ?? "")
          .trim()
          .toLowerCase()
          .startsWith("re")
          ? "regenerate"
          : "generate",
        status:
          row.status === "success" || row.status === "running" ? String(row.status) : "error",
        affectedCount: Number(row.affected_count ?? 0),
        errorMessage: row.error_message ? String(row.error_message) : null,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "매핑 현황을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
