import { NextResponse } from "next/server";
import cron from "node-cron";
import { ITEMTRADE_JOB_KEY, connectPlatformClient } from "../../_lib/pdf-itemtrade-loader";
import {
  initializePdfItemtradeScheduler,
  refreshPdfItemtradeSchedule,
} from "../../_lib/pdf-itemtrade-scheduler";

export const runtime = "nodejs";

type RunLogRow = {
  trigger_type: string;
  status: string;
  report_month: string | null;
  source_file: string | null;
  inserted_count: number | null;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
};

export async function GET() {
  await initializePdfItemtradeScheduler();
  const client = await connectPlatformClient();
  try {
    const configResult = await client.query<{
      schedule_enabled: boolean;
      schedule_cron_expr: string;
      updated_at: string;
    }>(
      `select schedule_enabled, schedule_cron_expr, updated_at
       from dp.pdf_ingest_schedule where job_key = $1`,
      [ITEMTRADE_JOB_KEY],
    );
    const logsResult = await client.query<RunLogRow>(
      `select trigger_type, status, report_month, source_file, inserted_count,
              started_at, finished_at, error_message
       from dp.pdf_ingest_run_log
       where job_key = $1
       order by started_at desc
       limit 10`,
      [ITEMTRADE_JOB_KEY],
    );
    const config = configResult.rows[0];
    return NextResponse.json({
      ok: true,
      enabled: Boolean(config?.schedule_enabled),
      cronExpr: config?.schedule_cron_expr?.trim() || "0 9 1 * *",
      updatedAt: config?.updated_at ?? null,
      recentRuns: logsResult.rows,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스케줄 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

type PatchRequest = { enabled?: boolean; cronExpr?: string };

export async function PATCH(request: Request) {
  let payload: PatchRequest = {};
  try {
    payload = (await request.json()) as PatchRequest;
  } catch {
    payload = {};
  }
  const enabled = Boolean(payload.enabled);
  const cronExpr = (payload.cronExpr ?? "0 9 1 * *").trim();
  if (enabled && !cron.validate(cronExpr)) {
    return NextResponse.json(
      { ok: false, error: "cron 표현식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const client = await connectPlatformClient();
  try {
    await client.query(
      `insert into dp.pdf_ingest_schedule (job_key, schedule_enabled, schedule_cron_expr, updated_at)
       values ($1, $2, $3, now())
       on conflict (job_key) do update
         set schedule_enabled = excluded.schedule_enabled,
             schedule_cron_expr = excluded.schedule_cron_expr,
             updated_at = now()`,
      [ITEMTRADE_JOB_KEY, enabled, cronExpr],
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스케줄 저장에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }

  await refreshPdfItemtradeSchedule();
  return NextResponse.json({ ok: true, enabled, cronExpr });
}
