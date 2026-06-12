import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";

export const runtime = "nodejs";

type RefreshPayload = {
  marketCode?: string;
  sourceMapId?: number;
  bucketMinutes?: number;
  featureVersion?: string;
};

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) return fallback;
  return normalized;
};

export async function POST(request: Request) {
  let payload: RefreshPayload | null = null;
  try {
    payload = (await request.json()) as RefreshPayload;
  } catch {
    payload = {};
  }

  const marketCode = (payload?.marketCode ?? "KOSPI").trim() || "KOSPI";
  const sourceMapId = toPositiveInt(payload?.sourceMapId, 2);
  const bucketMinutes = toPositiveInt(payload?.bucketMinutes, 120);
  const featureVersion = (payload?.featureVersion ?? "v1").trim() || "v1";

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
      WHERE map_id = $1
        AND obs_value IS NOT NULL
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
    asof_base AS (
      SELECT
        (trade_date::timestamp + time '15:30') AT TIME ZONE 'Asia/Seoul' AS as_of_ts,
        trade_date AS as_of_date,
        close_t,
        ret_1d, ret_2d, ret_3d, ret_5d, ret_10d, ret_20d,
        ma_5, ma_20, std_5, std_20,
        CASE WHEN ma_20 IS NULL OR ma_20 = 0 THEN NULL ELSE (ma_5 / ma_20 - 1)::numeric(20,12) END AS momentum_5_20
      FROM price_feat
    ),
    final_rows AS (
      SELECT
        a.as_of_ts,
        a.as_of_date,
        $2::text AS market_code,
        $1::bigint AS source_map_id,
        $3::int AS bucket_minutes,
        a.close_t,
        a.ret_1d, a.ret_2d, a.ret_3d, a.ret_5d, a.ret_10d, a.ret_20d,
        a.ma_5, a.ma_20, a.std_5, a.std_20, a.momentum_5_20,

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

        n6.news_cnt_total_6h,
        n6.news_cnt_pos_6h,
        n6.news_cnt_neg_6h,
        n6.sent_mean_6h,
        n6.impact_sum_6h,
        n6.impact_mean_6h,

        n6.news_cnt_total_24h,
        n6.news_cnt_pos_24h,
        n6.news_cnt_neg_24h,
        n6.sent_mean_24h,
        n6.impact_sum_24h,
        n6.impact_mean_24h,
        n6.topic_macro_mean_24h,
        n6.topic_rate_mean_24h,
        n6.topic_semiconductor_mean_24h,
        n6.topic_fx_mean_24h,
        n6.topic_oil_mean_24h,

        (
          (a.ret_1d IS NULL)::int +
          (a.ret_5d IS NULL)::int +
          (a.ret_20d IS NULL)::int +
          (n2.news_cnt_total IS NULL)::int +
          (n6.news_cnt_total_24h IS NULL)::int
        )::int AS missing_feature_count,
        $4::text AS feature_version
      FROM asof_base a
      LEFT JOIN LATERAL (
        SELECT
          n.news_cnt_total, n.news_cnt_pos, n.news_cnt_neg,
          n.sent_mean, n.sent_std, n.impact_sum, n.impact_mean,
          n.topic_macro_mean, n.topic_rate_mean, n.topic_semiconductor_mean, n.topic_fx_mean, n.topic_oil_mean,
          n.surprise_ratio
        FROM dp.news_feature_hourly n
        WHERE n.market_code = $2
          AND n.bucket_minutes = $3
          AND n.feature_ts <= a.as_of_ts
        ORDER BY n.feature_ts DESC
        LIMIT 1
      ) n2 ON true
      LEFT JOIN LATERAL (
        SELECT
          sum(n.news_cnt_total)::int AS news_cnt_total_6h,
          sum(n.news_cnt_pos)::int AS news_cnt_pos_6h,
          sum(n.news_cnt_neg)::int AS news_cnt_neg_6h,
          avg(n.sent_mean)::numeric(14,8) AS sent_mean_6h,
          sum(n.impact_sum)::numeric(20,8) AS impact_sum_6h,
          avg(n.impact_mean)::numeric(20,8) AS impact_mean_6h,
          sum(n.news_cnt_total) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::int AS news_cnt_total_24h,
          sum(n.news_cnt_pos) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::int AS news_cnt_pos_24h,
          sum(n.news_cnt_neg) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::int AS news_cnt_neg_24h,
          avg(n.sent_mean) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(14,8) AS sent_mean_24h,
          sum(n.impact_sum) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(20,8) AS impact_sum_24h,
          avg(n.impact_mean) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(20,8) AS impact_mean_24h,
          avg(n.topic_macro_mean) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(14,8) AS topic_macro_mean_24h,
          avg(n.topic_rate_mean) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(14,8) AS topic_rate_mean_24h,
          avg(n.topic_semiconductor_mean) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(14,8) AS topic_semiconductor_mean_24h,
          avg(n.topic_fx_mean) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(14,8) AS topic_fx_mean_24h,
          avg(n.topic_oil_mean) FILTER (WHERE n.feature_ts > a.as_of_ts - interval '24 hours')::numeric(14,8) AS topic_oil_mean_24h
        FROM dp.news_feature_hourly n
        WHERE n.market_code = $2
          AND n.bucket_minutes = $3
          AND n.feature_ts <= a.as_of_ts
          AND n.feature_ts > a.as_of_ts - interval '24 hours'
      ) n6 ON true
    )
    INSERT INTO dp.feature_store_kospi (
      as_of_ts, as_of_date, market_code, source_map_id, bucket_minutes,
      close_t, ret_1d, ret_2d, ret_3d, ret_5d, ret_10d, ret_20d,
      ma_5, ma_20, std_5, std_20, momentum_5_20,
      news_cnt_total_2h, news_cnt_pos_2h, news_cnt_neg_2h, sent_mean_2h, sent_std_2h, impact_sum_2h, impact_mean_2h,
      topic_macro_mean_2h, topic_rate_mean_2h, topic_semiconductor_mean_2h, topic_fx_mean_2h, topic_oil_mean_2h,
      surprise_ratio_2h,
      news_cnt_total_6h, news_cnt_pos_6h, news_cnt_neg_6h, sent_mean_6h, impact_sum_6h, impact_mean_6h,
      news_cnt_total_24h, news_cnt_pos_24h, news_cnt_neg_24h, sent_mean_24h, impact_sum_24h, impact_mean_24h,
      topic_macro_mean_24h, topic_rate_mean_24h, topic_semiconductor_mean_24h, topic_fx_mean_24h, topic_oil_mean_24h,
      missing_feature_count, feature_version
    )
    SELECT
      as_of_ts, as_of_date, market_code, source_map_id, bucket_minutes,
      close_t, ret_1d, ret_2d, ret_3d, ret_5d, ret_10d, ret_20d,
      ma_5, ma_20, std_5, std_20, momentum_5_20,
      news_cnt_total_2h, news_cnt_pos_2h, news_cnt_neg_2h, sent_mean_2h, sent_std_2h, impact_sum_2h, impact_mean_2h,
      topic_macro_mean_2h, topic_rate_mean_2h, topic_semiconductor_mean_2h, topic_fx_mean_2h, topic_oil_mean_2h,
      surprise_ratio_2h,
      news_cnt_total_6h, news_cnt_pos_6h, news_cnt_neg_6h, sent_mean_6h, impact_sum_6h, impact_mean_6h,
      news_cnt_total_24h, news_cnt_pos_24h, news_cnt_neg_24h, sent_mean_24h, impact_sum_24h, impact_mean_24h,
      topic_macro_mean_24h, topic_rate_mean_24h, topic_semiconductor_mean_24h, topic_fx_mean_24h, topic_oil_mean_24h,
      missing_feature_count, feature_version
    FROM final_rows
    ON CONFLICT (as_of_ts, market_code, bucket_minutes)
    DO UPDATE SET
      as_of_date = EXCLUDED.as_of_date,
      source_map_id = EXCLUDED.source_map_id,
      close_t = EXCLUDED.close_t,
      ret_1d = EXCLUDED.ret_1d,
      ret_2d = EXCLUDED.ret_2d,
      ret_3d = EXCLUDED.ret_3d,
      ret_5d = EXCLUDED.ret_5d,
      ret_10d = EXCLUDED.ret_10d,
      ret_20d = EXCLUDED.ret_20d,
      ma_5 = EXCLUDED.ma_5,
      ma_20 = EXCLUDED.ma_20,
      std_5 = EXCLUDED.std_5,
      std_20 = EXCLUDED.std_20,
      momentum_5_20 = EXCLUDED.momentum_5_20,
      news_cnt_total_2h = EXCLUDED.news_cnt_total_2h,
      news_cnt_pos_2h = EXCLUDED.news_cnt_pos_2h,
      news_cnt_neg_2h = EXCLUDED.news_cnt_neg_2h,
      sent_mean_2h = EXCLUDED.sent_mean_2h,
      sent_std_2h = EXCLUDED.sent_std_2h,
      impact_sum_2h = EXCLUDED.impact_sum_2h,
      impact_mean_2h = EXCLUDED.impact_mean_2h,
      topic_macro_mean_2h = EXCLUDED.topic_macro_mean_2h,
      topic_rate_mean_2h = EXCLUDED.topic_rate_mean_2h,
      topic_semiconductor_mean_2h = EXCLUDED.topic_semiconductor_mean_2h,
      topic_fx_mean_2h = EXCLUDED.topic_fx_mean_2h,
      topic_oil_mean_2h = EXCLUDED.topic_oil_mean_2h,
      surprise_ratio_2h = EXCLUDED.surprise_ratio_2h,
      news_cnt_total_6h = EXCLUDED.news_cnt_total_6h,
      news_cnt_pos_6h = EXCLUDED.news_cnt_pos_6h,
      news_cnt_neg_6h = EXCLUDED.news_cnt_neg_6h,
      sent_mean_6h = EXCLUDED.sent_mean_6h,
      impact_sum_6h = EXCLUDED.impact_sum_6h,
      impact_mean_6h = EXCLUDED.impact_mean_6h,
      news_cnt_total_24h = EXCLUDED.news_cnt_total_24h,
      news_cnt_pos_24h = EXCLUDED.news_cnt_pos_24h,
      news_cnt_neg_24h = EXCLUDED.news_cnt_neg_24h,
      sent_mean_24h = EXCLUDED.sent_mean_24h,
      impact_sum_24h = EXCLUDED.impact_sum_24h,
      impact_mean_24h = EXCLUDED.impact_mean_24h,
      topic_macro_mean_24h = EXCLUDED.topic_macro_mean_24h,
      topic_rate_mean_24h = EXCLUDED.topic_rate_mean_24h,
      topic_semiconductor_mean_24h = EXCLUDED.topic_semiconductor_mean_24h,
      topic_fx_mean_24h = EXCLUDED.topic_fx_mean_24h,
      topic_oil_mean_24h = EXCLUDED.topic_oil_mean_24h,
      missing_feature_count = EXCLUDED.missing_feature_count,
      feature_version = EXCLUDED.feature_version
    RETURNING as_of_ts
  `;

  try {
    await connectWithTimeout(client);
    const result = await client.query(sql, [sourceMapId, marketCode, bucketMinutes, featureVersion]);
    return NextResponse.json({
      ok: true,
      marketCode,
      sourceMapId,
      bucketMinutes,
      featureVersion,
      refreshedCount: result.rowCount ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "feature_store 재생성에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
