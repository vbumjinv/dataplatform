import type { Client } from "pg";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveDbConfig } from "../../db/_lib/connection";
import { resolveNewsDateToken } from "../../ingestion/_lib/news-date-token";
import { runPythonTransform, type SeriesPoint } from "./python-client";
import {
  buildTransformSelect,
  isNewsFeatureTransform,
  isPythonTransform,
  validateUserPython,
  type TransformConfig,
  type TransformType,
} from "./sql-builder";

type TransformRow = {
  transform_id: number;
  transform_type: TransformType;
  source_map_id: number | null;
  output_map_id: number | null;
  config: TransformConfig | null;
  output_name: string | null;
  output_unit: string | null;
  output_freq: string | null;
  db_setting_id: number | null;
};

const resolveWebDir = () => {
  if (existsSync(path.join(process.cwd(), "scripts", "news-feature", "news_to_feature.py"))) return process.cwd();
  return path.join(process.cwd(), "web");
};
const WEB_DIR = resolveWebDir();
const NEWS_FEATURE_SCRIPT = path.join(WEB_DIR, "scripts", "news-feature", "news_to_feature.py");

// 입력 시리즈의 freq (보간 시 앵커 기준에 사용)
const fetchSourceFreq = async (client: Client, mapId: number): Promise<string | null> => {
  try {
    const res = await client.query<{ freq: string | null }>(
      `select freq from dp.viz_map_mst where map_id = $1`,
      [mapId],
    );
    return res.rows[0]?.freq ?? null;
  } catch {
    return null;
  }
};

// 입력 시리즈(viz_map_data)를 ds/y 시계열로 읽어온다 (python 가공 입력용)
const fetchSourceSeries = async (
  client: Client,
  mapId: number,
): Promise<SeriesPoint[]> => {
  const res = await client.query<{ ds: string; y: string | number }>(
    `select to_char(obs_date::date, 'YYYY-MM-DD') as ds, obs_value::float8 as y
     from dp.viz_map_data
     where map_id = $1 and obs_date is not null and obs_value is not null
     order by obs_date`,
    [mapId],
  );
  return res.rows
    .map((row) => ({ ds: String(row.ds), y: Number(row.y) }))
    .filter((row) => row.ds.length > 0 && Number.isFinite(row.y));
};

// python 가공: 입력 시리즈를 읽어 Python 서비스로 변환한 결과 행을 반환
const computePythonRows = async (
  client: Client,
  config: TransformConfig,
  sourceMapId: number,
): Promise<SeriesPoint[]> => {
  const code = validateUserPython(config.code);
  const source = await fetchSourceSeries(client, sourceMapId);
  if (source.length === 0) throw new Error("입력 시리즈에 데이터가 없습니다.");
  // 보조 시리즈(config.secondMapId)가 지정되면 함께 읽어 df2 로 넘긴다.
  const secondMapId = Number(config.secondMapId);
  const source2 =
    Number.isFinite(secondMapId) && secondMapId > 0
      ? await fetchSourceSeries(client, secondMapId)
      : null;
  return runPythonTransform(code, source, source2);
};

export const loadTransform = async (
  client: Client,
  transformId: number,
): Promise<TransformRow | null> => {
  const res = await client.query<TransformRow>(
    `select transform_id, transform_type, source_map_id, output_map_id,
            config, output_name, output_unit, output_freq, db_setting_id
     from dp.api_transform
     where transform_id = $1`,
    [transformId],
  );
  return res.rows[0] ?? null;
};

const dbEnvFromConfig = async (settingId: number | null | undefined) => {
  const resolved = await resolveDbConfig({ settingId: settingId ?? null });
  if (!resolved) throw new Error("DB 연결 설정을 찾을 수 없습니다.");
  const normalized = resolved.url.startsWith("jdbc:") ? resolved.url.replace(/^jdbc:/, "") : resolved.url;
  const parsed = new URL(normalized);
  return {
    DB_HOST: parsed.hostname,
    DB_PORT: parsed.port || "5432",
    DB_NAME: resolved.database,
    DB_USER: resolved.user,
    DB_PASSWORD: resolved.password,
  };
};

const parseWrittenCount = (output: string) => {
  const currentMatch = /DB\s*적재\s*건수\(이번\s*실행\):\s*(\d+)/.exec(output);
  if (currentMatch) return Number(currentMatch[1]);
  const scratchMatch = /DB\s*적재\s+(\d+)건/.exec(output);
  return scratchMatch ? Number(scratchMatch[1]) : 0;
};

const runNewsFeaturePython = async (config: TransformConfig, settingId: number | null | undefined) => {
  if ((config.newsSource ?? "naver_pay") !== "naver_pay") {
    throw new Error("뉴스 변수 추출은 네이버페이 증권뉴스만 지원합니다.");
  }
  const startDate = resolveNewsDateToken(config.newsStartExpr ?? "");
  const endDate = resolveNewsDateToken(config.newsEndExpr ?? "");
  if (!startDate || !endDate) throw new Error("뉴스 시작일/종료일을 확인하세요.");
  const dbEnv = await dbEnvFromConfig(settingId);
  const python = process.env.NEWS_FEATURE_PYTHON || "python";
  const args = [NEWS_FEATURE_SCRIPT, "--start", startDate, "--end", endDate];
  const env = {
    ...process.env,
    ...dbEnv,
    PYTHONIOENCODING: "utf-8",
  };
  if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY가 설정되어 있지 않습니다.");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: path.dirname(NEWS_FEATURE_SCRIPT),
      env,
      windowsHide: true,
    });
    const chunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = chunks.join("");
      if (code === 0) resolve(text);
      else reject(new Error(text.trim() || `뉴스 변수 추출 Python 실행 실패 (${code})`));
    });
  });
  return { affectedCount: parseWrittenCount(output), startDate, endDate };
};

const isNewsFeatureConfig = (transform: TransformRow) =>
  isNewsFeatureTransform(transform.transform_type) || Boolean(transform.config?.newsFeature);

export type RunTransformResult = {
  ok: boolean;
  affectedCount: number;
  startDate: string | null;
  endDate: string | null;
};

// 가공 실행: 입력 시리즈 → 변환 SELECT → 출력 파생 시리즈(viz_map_data) 재적재
export const runTransform = async (
  client: Client,
  transformId: number,
  triggerType: "manual" | "schedule",
): Promise<RunTransformResult> => {
  const transform = await loadTransform(client, transformId);
  if (!transform) throw new Error("가공 정의를 찾을 수 없습니다.");

  const startedAt = Date.now();
  const runLogRes = await client.query<{ run_log_id: number }>(
    `insert into dp.api_transform_run_log (transform_id, trigger_type, status)
     values ($1, $2, 'running')
     returning run_log_id`,
    [transformId, triggerType],
  );
  const runLogId = Number(runLogRes.rows[0]?.run_log_id);

  try {
    if (isNewsFeatureConfig(transform)) {
      const result = await runNewsFeaturePython(transform.config ?? {}, transform.db_setting_id);
      await client.query(
        `update dp.api_transform_run_log
         set status = 'success', finished_at = now(), elapsed_ms = $2, affected_count = $3
         where run_log_id = $1`,
        [runLogId, Date.now() - startedAt, result.affectedCount],
      );
      return {
        ok: true,
        affectedCount: result.affectedCount,
        startDate: result.startDate,
        endDate: result.endDate,
      };
    }
    if (!transform.source_map_id) throw new Error("입력 시리즈가 설정되지 않았습니다.");
    if (!transform.output_map_id) throw new Error("출력 시리즈가 설정되지 않았습니다.");

    const isPython = isPythonTransform(transform.transform_type);
    const sourceFreq = await fetchSourceFreq(client, Number(transform.source_map_id));
    // 비-python: 변환 SELECT 생성(검증 겸). python: SQL이 아니므로 생성하지 않는다.
    const transformSelect = isPython
      ? null
      : buildTransformSelect(
          transform.transform_type,
          transform.config ?? {},
          Number(transform.source_map_id),
          sourceFreq,
        );
    const outputMapId = Number(transform.output_map_id);
    const outputFreq = ((transform.output_freq ?? "M").trim() || "M").toUpperCase();
    // python 가공은 외부 서비스 호출(네트워크)이므로 트랜잭션을 열기 전에 먼저 계산한다.
    const pythonRows = isPython
      ? await computePythonRows(client, transform.config ?? {}, Number(transform.source_map_id))
      : null;

    await client.query("begin");
    await client.query(`delete from dp.viz_map_data where map_id = $1`, [outputMapId]);
    let affectedCount = 0;
    if (isPython) {
      const dates = (pythonRows ?? []).map((row) => row.ds);
      const values = (pythonRows ?? []).map((row) => row.y);
      const insertRes = await client.query(
        `insert into dp.viz_map_data (
           map_id, obs_date, obs_value, freq, series_key, series_name, unit_name, updated_at
         )
         select $1, d::date, v::numeric, $2, null, $3, $4, now()
         from unnest($5::text[], $6::float8[]) as t(d, v)
         where d is not null and v is not null
         on conflict (map_id, obs_date, freq) do update
         set obs_value = excluded.obs_value,
             series_name = excluded.series_name,
             unit_name = excluded.unit_name,
             updated_at = now()`,
        [outputMapId, outputFreq, transform.output_name ?? "", transform.output_unit ?? null, dates, values],
      );
      affectedCount = insertRes.rowCount ?? 0;
    } else {
      // 선형보간 출력은 추정값이므로 is_interpolated = true 로 표시한다.
      const isInterpolated = transform.transform_type === "interpolate";
      const insertRes = await client.query(
        `insert into dp.viz_map_data (
           map_id, obs_date, obs_value, freq, series_key, series_name, unit_name, is_interpolated, updated_at
         )
         select $1, t.obs_date::date, t.obs_value::numeric, $2, null, $3, $4, $5, now()
         from ( ${transformSelect} ) t
         where t.obs_date is not null and t.obs_value is not null
         on conflict (map_id, obs_date, freq) do update
         set obs_value = excluded.obs_value,
             series_name = excluded.series_name,
             unit_name = excluded.unit_name,
             is_interpolated = excluded.is_interpolated,
             updated_at = now()`,
        [outputMapId, outputFreq, transform.output_name ?? "", transform.output_unit ?? null, isInterpolated],
      );
      affectedCount = insertRes.rowCount ?? 0;
    }
    const rangeRes = await client.query<{ start_date: string | null; end_date: string | null }>(
      `select min(obs_date)::text as start_date, max(obs_date)::text as end_date
       from dp.viz_map_data where map_id = $1`,
      [outputMapId],
    );
    await client.query("commit");

    await client.query(
      `update dp.api_transform_run_log
       set status = 'success', finished_at = now(), elapsed_ms = $2, affected_count = $3
       where run_log_id = $1`,
      [runLogId, Date.now() - startedAt, affectedCount],
    );
    return {
      ok: true,
      affectedCount,
      startDate: rangeRes.rows[0]?.start_date ?? null,
      endDate: rangeRes.rows[0]?.end_date ?? null,
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await client.query(
        `update dp.api_transform_run_log
         set status = 'error', finished_at = now(), elapsed_ms = $2, error_message = $3
         where run_log_id = $1`,
        [runLogId, Date.now() - startedAt, message.slice(0, 1000)],
      );
    } catch {
      // ignore log update errors
    }
    throw error;
  }
};

export type PreviewRow = { obsDate: string; obsValue: number | null };

// 저장 없이 변환 결과 미리보기 (최근 N건)
export const runTransformPreview = async (
  client: Client,
  type: TransformType,
  config: TransformConfig,
  sourceMapId: number,
  limit = 15,
): Promise<PreviewRow[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 15;
  if (isPythonTransform(type)) {
    const rows = await computePythonRows(client, config, sourceMapId);
    // 최근 N건만 (날짜 내림차순)
    return rows
      .slice(-safeLimit)
      .reverse()
      .map((row) => ({ obsDate: row.ds, obsValue: Number.isFinite(row.y) ? row.y : null }));
  }
  const sourceFreq = await fetchSourceFreq(client, sourceMapId);
  const transformSelect = buildTransformSelect(type, config, sourceMapId, sourceFreq);
  const res = await client.query<{ obs_date: string | null; obs_value: unknown }>(
    `select to_char(t.obs_date::date, 'YYYY-MM-DD') as obs_date, t.obs_value::numeric as obs_value
     from ( ${transformSelect} ) t
     where t.obs_date is not null and t.obs_value is not null
     order by t.obs_date desc
     limit ${safeLimit}`,
  );
  return res.rows.map((row) => ({
    obsDate: row.obs_date == null ? "" : String(row.obs_date),
    obsValue:
      row.obs_value == null || Number.isNaN(Number(row.obs_value))
        ? null
        : Number(row.obs_value),
  }));
};
