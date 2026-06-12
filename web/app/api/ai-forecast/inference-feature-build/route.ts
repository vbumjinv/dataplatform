import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";

export const runtime = "nodejs";

type InferenceFeaturePayload = {
  marketCode?: string;
  sourceMapId?: number;
  bucketMinutes?: number;
  featureVersion?: string;
  targetTradeDate?: string;
  cutoffTs?: string;
};

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) return fallback;
  return normalized;
};

const toKstDateText = (value: Date) => {
  const kstTime = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  return kstTime.toISOString().slice(0, 10);
};

const isDateText = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export async function POST(request: Request) {
  let payload: InferenceFeaturePayload | null = null;
  try {
    payload = (await request.json()) as InferenceFeaturePayload;
  } catch {
    payload = {};
  }

  const marketCode = (payload?.marketCode ?? "KOSPI").trim() || "KOSPI";
  const sourceMapId = toPositiveInt(payload?.sourceMapId, 2);
  const bucketMinutes = toPositiveInt(payload?.bucketMinutes, 120);
  const featureVersion = (payload?.featureVersion ?? "v1").trim() || "v1";
  const cutoffTs = payload?.cutoffTs ? new Date(payload.cutoffTs) : new Date();
  if (Number.isNaN(cutoffTs.getTime())) {
    return NextResponse.json(
      { ok: false, error: "cutoffTs 형식이 올바르지 않습니다. (ISO timestamp)" },
      { status: 400 },
    );
  }

  const targetTradeDate = (payload?.targetTradeDate ?? toKstDateText(cutoffTs)).trim();
  if (!isDateText(targetTradeDate)) {
    return NextResponse.json(
      { ok: false, error: "targetTradeDate 형식이 올바르지 않습니다. (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const client = createDbClient();
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const sql = `
    WITH price_raw AS (
      SELECT
        obs_date::date AS trade_date,
        obs_value::numeric(20,8) AS close_price
      FROM dp.viz_map_data
      WHERE map_id = $2
        AND obs_value IS NOT NULL
        AND obs_date::date <= $4::date
    ),
    price_feat AS (
      SELECT
        trade_date,
        close_price AS close_t,
        ln(close_price / NULLIF(lag(close_price, 1) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_1d,
        ln(close_price / NULLIF(lag(close_price, 2) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_2d,
        ln(close_price / NULLIF(lag(close_price, 3) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_3d,
        ln(close_price / NULLIF(lag(close_price, 5) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_5d,
        ln(close_price / NULLIF(lag(close_price, 10) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_10d,
        ln(close_price / NULLIF(lag(close_price, 20) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_20d,
        avg(close_price) OVER (ORDER BY trade_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW)::numeric(20,8) AS ma_5,
        avg(close_price) OVER (ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)::numeric(20,8) AS ma_20,
        stddev_samp(close_price) OVER (ORDER BY trade_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW)::numeric(20,12) AS std_5,
        stddev_samp(close_price) OVER (ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)::numeric(20,12) AS std_20
      FROM price_raw
    ),
    anchor_base AS (
      SELECT
        p.trade_date AS anchor_trade_date,
        ((p.trade_date::timestamp + time '15:30') AT TIME ZONE 'Asia/Seoul') AS anchor_as_of_ts,
        p.close_t,
        p.ret_1d, p.ret_2d, p.ret_3d, p.ret_5d, p.ret_10d, p.ret_20d,
        p.ma_5, p.ma_20, p.std_5, p.std_20,
        CASE
          WHEN p.ma_20 IS NULL OR p.ma_20 = 0 THEN NULL
          ELSE (p.ma_5 / p.ma_20 - 1)::numeric(20,12)
        END AS momentum_5_20
      FROM price_feat p
      ORDER BY p.trade_date DESC
      LIMIT 1
    ),
    snapshot_base AS (
      SELECT
        $1::text AS market_code,
        $2::bigint AS source_map_id,
        $3::int AS bucket_minutes,
        $4::date AS target_trade_date,
        $5::timestamptz AS cutoff_ts,
        $6::text AS feature_version,
        a.anchor_trade_date,
        a.anchor_as_of_ts,
        a.close_t,
        a.ret_1d, a.ret_2d, a.ret_3d, a.ret_5d, a.ret_10d, a.ret_20d,
        a.ma_5, a.ma_20, a.std_5, a.std_20, a.momentum_5_20
      FROM anchor_base a
    )
    SELECT
      s.market_code,
      s.source_map_id,
      s.bucket_minutes,
      s.target_trade_date,
      s.cutoff_ts,
      s.feature_version,
      s.anchor_trade_date,
      s.anchor_as_of_ts,
      s.close_t,
      s.ret_1d, s.ret_2d, s.ret_3d, s.ret_5d, s.ret_10d, s.ret_20d,
      s.ma_5, s.ma_20, s.std_5, s.std_20, s.momentum_5_20,
      n2.news_cnt_total AS news_cnt_total_2h,
      n2.news_cnt_pos AS news_cnt_pos_2h,
      n2.news_cnt_neg AS news_cnt_neg_2h,
      n2.sent_mean AS sent_mean_2h,
      n2.sent_std AS sent_std_2h,
      n2.impact_sum AS impact_sum_2h,
      n2.impact_mean AS impact_mean_2h,
      n2.topic_macro_mean AS topic_macro_mean_2h,
      n2.topic_rate_mean AS topic_rate_mean_2h,
      n2.topic_semiconductor_mean AS topic_semiconductor_mean_2h,
      n2.topic_fx_mean AS topic_fx_mean_2h,
      n2.topic_oil_mean AS topic_oil_mean_2h,
      n2.surprise_ratio AS surprise_ratio_2h,
      n24.news_cnt_total_24h,
      n24.news_cnt_pos_24h,
      n24.news_cnt_neg_24h,
      n24.sent_mean_24h,
      n24.impact_sum_24h,
      n24.impact_mean_24h,
      n24.topic_macro_mean_24h,
      n24.topic_rate_mean_24h,
      n24.topic_semiconductor_mean_24h,
      n24.topic_fx_mean_24h,
      n24.topic_oil_mean_24h,
      (
        (s.ret_1d IS NULL)::int +
        (s.ret_5d IS NULL)::int +
        (s.ret_20d IS NULL)::int +
        (n2.news_cnt_total IS NULL)::int +
        (n24.news_cnt_total_24h IS NULL)::int
      )::int AS missing_feature_count
    FROM snapshot_base s
    LEFT JOIN LATERAL (
      SELECT
        n.news_cnt_total, n.news_cnt_pos, n.news_cnt_neg,
        n.sent_mean, n.sent_std, n.impact_sum, n.impact_mean,
        n.topic_macro_mean, n.topic_rate_mean, n.topic_semiconductor_mean, n.topic_fx_mean, n.topic_oil_mean,
        n.surprise_ratio
      FROM dp.news_feature_hourly n
      WHERE n.market_code = s.market_code
        AND n.bucket_minutes = s.bucket_minutes
        AND n.feature_ts <= s.cutoff_ts
      ORDER BY n.feature_ts DESC
      LIMIT 1
    ) n2 ON true
    LEFT JOIN LATERAL (
      SELECT
        sum(n.news_cnt_total)::int AS news_cnt_total_24h,
        sum(n.news_cnt_pos)::int AS news_cnt_pos_24h,
        sum(n.news_cnt_neg)::int AS news_cnt_neg_24h,
        avg(n.sent_mean)::numeric(14,8) AS sent_mean_24h,
        sum(n.impact_sum)::numeric(20,8) AS impact_sum_24h,
        avg(n.impact_mean)::numeric(20,8) AS impact_mean_24h,
        avg(n.topic_macro_mean)::numeric(14,8) AS topic_macro_mean_24h,
        avg(n.topic_rate_mean)::numeric(14,8) AS topic_rate_mean_24h,
        avg(n.topic_semiconductor_mean)::numeric(14,8) AS topic_semiconductor_mean_24h,
        avg(n.topic_fx_mean)::numeric(14,8) AS topic_fx_mean_24h,
        avg(n.topic_oil_mean)::numeric(14,8) AS topic_oil_mean_24h
      FROM dp.news_feature_hourly n
      WHERE n.market_code = s.market_code
        AND n.bucket_minutes = s.bucket_minutes
        AND n.feature_ts <= s.cutoff_ts
        AND n.feature_ts > s.cutoff_ts - interval '24 hours'
    ) n24 ON true
  `;

  try {
    await connectWithTimeout(client);
    const result = await client.query(sql, [
      marketCode,
      sourceMapId,
      bucketMinutes,
      targetTradeDate,
      cutoffTs.toISOString(),
      featureVersion,
    ]);

    if (!result.rowCount) {
      return NextResponse.json(
        {
          ok: false,
          error: "타깃 거래일 이전 가격 데이터가 없습니다. sourceMapId/targetTradeDate를 확인해주세요.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      mode: "inference_feature_snapshot",
      marketCode,
      sourceMapId,
      bucketMinutes,
      featureVersion,
      targetTradeDate,
      cutoffTs: cutoffTs.toISOString(),
      snapshot: result.rows[0],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "운영 예측용 피처 생성에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
