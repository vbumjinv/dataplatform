import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClientFromRequest } from "../_lib/db";

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
    const tableCheck = await client.query<{ exists: boolean }>(
      `select to_regclass('dp.api_pipeline_run_log') is not null as exists`,
    );
    if (!tableCheck.rows[0]?.exists) {
      return NextResponse.json({
        ok: true,
        summary: {
          totalRuns: 0,
          successRuns: 0,
          errorRuns: 0,
          successRate: 0,
          lastRunAt: null,
        },
        daily: [],
        recentFailures: [],
      });
    }
    const [summaryResult, dailyResult, failureResult] = await Promise.all([
      client.query(
        `
          select
            count(*)::int as total_runs,
            count(*) filter (where status = 'success')::int as success_runs,
            count(*) filter (where status = 'error')::int as error_runs,
            max(started_at) as last_run_at
          from dp.api_pipeline_run_log
          where started_at::date = current_date
        `,
      ),
      client.query(
        `
          select
            to_char(started_at::date, 'YYYY-MM-DD') as run_date,
            count(*)::int as total_runs,
            count(*) filter (where status = 'success')::int as success_runs,
            count(*) filter (where status = 'error')::int as error_runs
          from dp.api_pipeline_run_log
          where started_at >= (current_date - interval '13 days')
          group by started_at::date
          order by started_at::date asc
        `,
      ),
      client.query(
        `
          select
            r.run_log_id::bigint as run_log_id,
            to_char(r.started_at::date, 'YYYY-MM-DD') as run_date,
            r.started_at,
            p.name as pipeline_name,
            r.trigger_type,
            r.status,
            r.error_message,
            r.step_results
          from dp.api_pipeline_run_log r
          left join dp.api_pipeline p on p.pipeline_id = r.pipeline_id
          where r.started_at >= (current_date - interval '6 days')
          order by r.started_at desc
        `,
      ),
    ]);

    const summaryRow = summaryResult.rows[0] as
      | {
          total_runs: number;
          success_runs: number;
          error_runs: number;
          last_run_at: Date | null;
        }
      | undefined;
    const totalRuns = Number(summaryRow?.total_runs ?? 0);
    const successRuns = Number(summaryRow?.success_runs ?? 0);
    const errorRuns = Number(summaryRow?.error_runs ?? 0);
    const successRate = totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0;

    const rawFailures = failureResult.rows.map((row) => ({
      runLogId: Number(row.run_log_id ?? 0),
      runDate: String(row.run_date),
      startedAt: new Date(row.started_at as Date).toISOString(),
      pipelineName: row.pipeline_name ? String(row.pipeline_name) : "(미상)",
      triggerType: String(row.trigger_type ?? "")
        .trim()
        .toLowerCase()
        .startsWith("sched")
        ? "schedule"
        : "manual",
      status:
        row.status === "success" || row.status === "running" ? String(row.status) : "error",
      errorMessage: row.error_message ? String(row.error_message) : null,
      stepResults: Array.isArray(row.step_results) ? row.step_results : [],
    }));

    const mapIds = Array.from(
      new Set(
        rawFailures.flatMap((failure) =>
          (failure.stepResults as Array<{ type?: string; refId?: unknown }>)
            .filter((step) => step?.type === "map" && Number.isFinite(Number(step?.refId)))
            .map((step) => Number(step.refId)),
        ),
      ),
    ).filter((id) => id > 0);

    const mapNameById = new Map<number, string>();
    if (mapIds.length > 0) {
      const mapNameResult = await client.query<{ map_id: number; series_name: string | null }>(
        `
          select map_id::int as map_id, series_name
          from dp.viz_map_mst
          where map_id = any($1::int[])
        `,
        [mapIds],
      );
      mapNameResult.rows.forEach((row) => {
        const id = Number(row.map_id ?? 0);
        if (!id) return;
        mapNameById.set(id, row.series_name?.trim() || `MAP:${id}`);
      });
    }

    const normalizedFailures = rawFailures.map((failure) => ({
      ...failure,
      stepResults: (failure.stepResults as Array<Record<string, unknown>>).map((step) => {
        if (step?.type !== "map") return step;
        const refId = Number(step.refId ?? 0);
        const existingLabel =
          typeof step.mapLabel === "string" && step.mapLabel.trim().length > 0
            ? step.mapLabel.trim()
            : null;
        const resolvedLabel = existingLabel || mapNameById.get(refId) || (refId ? `MAP:${refId}` : "매핑");
        return {
          ...step,
          refId: Number.isFinite(refId) ? refId : null,
          mapLabel: resolvedLabel,
        };
      }),
    }));

    return NextResponse.json({
      ok: true,
      summary: {
        totalRuns,
        successRuns,
        errorRuns,
        successRate: Number(successRate.toFixed(1)),
        lastRunAt: summaryRow?.last_run_at ? new Date(summaryRow.last_run_at).toISOString() : null,
      },
      daily: dailyResult.rows.map((row) => ({
        runDate: String(row.run_date),
        totalRuns: Number(row.total_runs ?? 0),
        successRuns: Number(row.success_runs ?? 0),
        errorRuns: Number(row.error_runs ?? 0),
      })),
      recentFailures: normalizedFailures,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "파이프라인 현황을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

