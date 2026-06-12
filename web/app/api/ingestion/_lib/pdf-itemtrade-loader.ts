// 산업부 수출입동향 PDF → dp.pdf_itemtrade 적재 공유 로직 (수동 라우트 + 크론 공용).
import { Client } from "pg";
import { buildConnectionString, resolveDbConfig } from "../../db/_lib/connection";
import { fetchItemTradePdf } from "./motie-trade";
import { extractItemTradeTable, type ItemTradeRow } from "./pdf-table";

const CONNECT_TIMEOUT_MS = 5000;

// 공용 PDF 수집 테이블(dp.pdf_ingest_schedule / dp.pdf_ingest_run_log)에서
// 이 작업(산업부 수출입동향 20대 품목)을 구분하는 키.
export const ITEMTRADE_JOB_KEY = "itemtrade";

export type ReportTarget = { year: number; month: number };
export type TriggerType = "manual" | "schedule";

export type PreviewResult = {
  reportMonth: string;
  sourceFile: string;
  postUrl: string;
  items: ItemTradeRow[];
  count: number;
  note: string | null;
};

export type LoadResult = {
  reportMonth: string;
  sourceFile: string;
  postUrl: string;
  inserted: number;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

// 오늘 기준 전월(보고월). 예) 7/1 실행 → 6월 보고서.
export const previousReportMonth = (): ReportTarget => {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: prev.getFullYear(), month: prev.getMonth() + 1 };
};

// 플랫폼 DB(dp 스키마) 연결 문자열. settingId 지정 시 저장된 설정, 아니면 DP_DB_* env.
const resolveConnString = async (
  settingId?: number | null,
): Promise<string | null> => {
  if (typeof settingId === "number" && Number.isFinite(settingId) && settingId > 0) {
    const resolved = await resolveDbConfig({ settingId });
    return resolved ? buildConnectionString(resolved) : null;
  }
  return buildConnectionString({
    dbType: "postgres",
    url: process.env.DP_DB_URL,
    database: process.env.DP_DB_NAME,
    user: process.env.DP_DB_USER,
    password: process.env.DP_DB_PASSWORD,
  });
};

export const connectPlatformClient = async (
  settingId?: number | null,
): Promise<Client> => {
  const connectionString = await resolveConnString(settingId);
  if (!connectionString) {
    throw new Error("DB 연결 설정을 찾을 수 없습니다. (DP_DB_* 환경변수 또는 DB 설정 확인)");
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  let timeoutId: NodeJS.Timeout | null = null;
  await Promise.race([
    client.connect(),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("DB 연결 시간이 초과되었습니다.")), CONNECT_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return client;
};

// 미리보기: DB 미기록. 산업부에서 받아 파싱만.
export const runItemTradePreview = async (
  target: ReportTarget,
): Promise<PreviewResult> => {
  const pdf = await fetchItemTradePdf(target.year, target.month);
  const parsed = await extractItemTradeTable(pdf.buffer);
  return {
    reportMonth: pdf.reportMonth,
    sourceFile: pdf.fileName,
    postUrl: pdf.postUrl,
    items: parsed.items,
    count: parsed.items.length,
    note: parsed.note,
  };
};

const insertRows = async (
  client: Client,
  reportMonth: string,
  rows: ItemTradeRow[],
) => {
  await client.query("begin");
  try {
    await client.query(`delete from dp.pdf_itemtrade where obs_date = $1`, [reportMonth]);
    if (rows.length > 0) {
      const values: unknown[] = [];
      const placeholders = rows
        .map((row, index) => {
          const base = index * 3;
          values.push(reportMonth, row.item, row.obsValue);
          return `($${base + 1}, $${base + 2}, $${base + 3})`;
        })
        .join(", ");
      await client.query(
        `insert into dp.pdf_itemtrade (obs_date, item, obs_value) values ${placeholders}`,
        values,
      );
    }
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    throw error;
  }
};

/**
 * 산업부 PDF 를 받아 파싱 후 dp.pdf_itemtrade 에 해당 월 삭제 후 재적재하고 run_log 를 남긴다.
 */
export const runItemTradeLoad = async (opts: {
  year: number;
  month: number;
  settingId?: number | null;
  triggerType?: TriggerType;
}): Promise<LoadResult> => {
  const triggerType: TriggerType = opts.triggerType ?? "manual";
  const reportMonth = `${opts.year}-${pad2(opts.month)}-01`;
  const startedMs = Date.now();
  const client = await connectPlatformClient(opts.settingId);
  let runLogId: number | null = null;
  try {
    const logResult = await client.query<{ run_log_id: number }>(
      `insert into dp.pdf_ingest_run_log (job_key, trigger_type, status, report_month)
       values ($1, $2, 'running', $3)
       returning run_log_id`,
      [ITEMTRADE_JOB_KEY, triggerType, reportMonth],
    );
    runLogId = logResult.rows[0]?.run_log_id ?? null;

    const pdf = await fetchItemTradePdf(opts.year, opts.month);
    const parsed = await extractItemTradeTable(pdf.buffer);
    if (parsed.items.length === 0) {
      throw new Error(parsed.note || "추출된 데이터가 없습니다.");
    }
    await insertRows(client, pdf.reportMonth, parsed.items);

    if (runLogId != null) {
      await client.query(
        `update dp.pdf_ingest_run_log
         set status = 'success', source_file = $2, post_url = $3,
             inserted_count = $4, finished_at = now(), elapsed_ms = $5
         where run_log_id = $1`,
        [runLogId, pdf.fileName, pdf.postUrl, parsed.items.length, Date.now() - startedMs],
      );
    }
    return {
      reportMonth: pdf.reportMonth,
      sourceFile: pdf.fileName,
      postUrl: pdf.postUrl,
      inserted: parsed.items.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "PDF 적재에 실패했습니다.";
    if (runLogId != null) {
      try {
        await client.query(
          `update dp.pdf_ingest_run_log
           set status = 'error', error_message = $2, finished_at = now(), elapsed_ms = $3
           where run_log_id = $1`,
          [runLogId, message, Date.now() - startedMs],
        );
      } catch {
        // ignore log update errors
      }
    }
    throw error;
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};
