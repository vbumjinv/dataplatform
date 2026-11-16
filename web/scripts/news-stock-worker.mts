import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { crawlStockNewsRange } from "../app/api/ingestion/_lib/naver-stock-news";
import { connectNewsClient } from "../app/api/ingestion/_lib/news-collect";

const HEAP_RESTART_BYTES = 1200 * 1024 * 1024;
const RESTART_EXIT = 75;

const startDate = process.argv[2] ?? "";
const endDate = process.argv[3] ?? "";
const settingRaw = Number(process.argv[4] ?? "");
const progressPath = process.argv[5] ?? "";
const startedAt = Number(process.argv[6] ?? Date.now());
const dbSettingId = Number.isFinite(settingRaw) && settingRaw > 0 ? settingRaw : null;

type CollectStatus = "running" | "done" | "error";

const isDroppedConnection = (message: string) =>
  /connection terminated|econnreset|econnrefused|connection ended|connection error|timeout expired|sorry, too many clients/i.test(
    message,
  );

const saveCollectJob = async (status: CollectStatus, message: string) => {
  const client = await connectNewsClient(dbSettingId);
  try {
    await client.query(
      `insert into dp.news_stock_collect_job (
         id, start_date, end_date, db_setting_id, status, message, updated_at
       )
       values (1, $1::date, $2::date, $3, $4, $5, now())
       on conflict (id) do update
         set start_date = excluded.start_date,
             end_date = excluded.end_date,
             db_setting_id = excluded.db_setting_id,
             status = excluded.status,
             message = excluded.message,
             updated_at = now()`,
      [startDate, endDate, dbSettingId, status, message.slice(0, 500)],
    );
  } finally {
    await client.end();
  }
};

let restartRequested = false;

const writeProgress = (progress: {
  date: string;
  startDate: string;
  endDate: string;
  dayIndex: number;
  dayCount: number;
  phase: string;
  listCount: number;
  bodyTotal: number;
  bodyDone: number;
  bodyOk: number;
  elapsedMs: number;
  message: string;
  error: string;
}) => {
  if (!progressPath || restartRequested) return;
  mkdirSync(path.dirname(progressPath), { recursive: true });
  writeFileSync(
    progressPath,
    JSON.stringify({
      ...progress,
      running: progress.phase !== "done" && progress.phase !== "error",
      startedAt,
      dbSettingId,
      elapsedMs: Date.now() - startedAt,
    }),
  );
  if (v8.getHeapStatistics().used_heap_size > HEAP_RESTART_BYTES) {
    restartRequested = true;
    process.exit(RESTART_EXIT);
  }
};

const main = async () => {
  const progress = await crawlStockNewsRange({
    startDate,
    endDate,
    dbSettingId,
    onProgress: (next) => {
      writeProgress(next);
    },
  });
  const dropped = progress.phase === "error" && isDroppedConnection(progress.error);
  const status: CollectStatus = progress.phase === "error" && !dropped ? "error" : progress.phase === "done" ? "done" : "running";
  await saveCollectJob(status, progress.message);
  writeProgress(progress);
  process.exit(dropped ? RESTART_EXIT : 0);
};

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "뉴스 수집에 실패했습니다.";
  const status: CollectStatus = isDroppedConnection(message) ? "running" : "error";
  try {
    await saveCollectJob(status, message);
  } catch {
    process.exit(RESTART_EXIT);
  }
  process.exit(status === "running" ? RESTART_EXIT : 1);
});
