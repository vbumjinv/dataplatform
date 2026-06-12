import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";

export const runtime = "nodejs";

type PredictPayload = {
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
  return normalized > 0 ? normalized : fallback;
};

const toKstDateText = (value: Date) => {
  const kst = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
};

const isDateText = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export async function POST(request: Request) {
  let payload: PredictPayload | null = null;
  try {
    payload = (await request.json()) as PredictPayload;
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
        ln(close_price / NULLIF(lag(close_price, 5) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_5d,
        ln(close_price / NULLIF(lag(close_price, 20) OVER (ORDER BY trade_date), 0))::numeric(20,12) AS ret_20d,
        avg(close_price) OVER (ORDER BY trade_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW)::numeric(20,8) AS ma_5,
        avg(close_price) OVER (ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)::numeric(20,8) AS ma_20,
        stddev_samp(close_price) OVER (ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)::numeric(20,12) AS std_20
      FROM price_raw
    ),
    anchor_base AS (
      SELECT
        p.trade_date AS anchor_trade_date,
        ((p.trade_date::timestamp + time '15:30') AT TIME ZONE 'Asia/Seoul') AS anchor_as_of_ts,
        p.close_t,
        p.ret_1d,
        p.ret_5d,
        p.ret_20d,
        p.std_20,
        CASE
          WHEN p.ma_20 IS NULL OR p.ma_20 = 0 THEN NULL
          ELSE (p.ma_5 / p.ma_20 - 1)::numeric(20,12)
        END AS momentum_5_20
      FROM price_feat p
      ORDER BY p.trade_date DESC
      LIMIT 1
    ),
    macro_snapshot AS (
      SELECT
        a.anchor_trade_date,
        fx.level AS krwusd_level,
        fx.ret_1d AS krwusd_ret_1d,
        us10y.level AS us10y_level,
        us10y.ret_1d AS us10y_ret_1d,
        nasdaq.level AS nasdaq_level,
        nasdaq.ret_1d AS nasdaq_ret_1d,
        spx.level AS sp500_level,
        spx.ret_1d AS sp500_ret_1d,
        vix.level AS vix_level,
        wti.level AS wti_level,
        wti.ret_1d AS wti_ret_1d,
        dxy.level AS dxy_level,
        dxy.ret_1d AS dxy_ret_1d
      FROM anchor_base a
      LEFT JOIN LATERAL (
        SELECT
          cur.obs_value::numeric AS level,
          CASE WHEN prev.obs_value IS NULL OR prev.obs_value = 0 THEN NULL
            ELSE ln(cur.obs_value / prev.obs_value)::numeric(20,12)
          END AS ret_1d
        FROM (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 9
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          LIMIT 1
        ) cur
        LEFT JOIN (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 9
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          OFFSET 1 LIMIT 1
        ) prev ON true
      ) fx ON true
      LEFT JOIN LATERAL (
        SELECT
          cur.obs_value::numeric AS level,
          CASE WHEN prev.obs_value IS NULL OR prev.obs_value = 0 THEN NULL
            ELSE ln(cur.obs_value / prev.obs_value)::numeric(20,12)
          END AS ret_1d
        FROM (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 16
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          LIMIT 1
        ) cur
        LEFT JOIN (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 16
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          OFFSET 1 LIMIT 1
        ) prev ON true
      ) us10y ON true
      LEFT JOIN LATERAL (
        SELECT
          cur.obs_value::numeric AS level,
          CASE WHEN prev.obs_value IS NULL OR prev.obs_value = 0 THEN NULL
            ELSE ln(cur.obs_value / prev.obs_value)::numeric(20,12)
          END AS ret_1d
        FROM (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 19
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          LIMIT 1
        ) cur
        LEFT JOIN (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 19
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          OFFSET 1 LIMIT 1
        ) prev ON true
      ) nasdaq ON true
      LEFT JOIN LATERAL (
        SELECT
          cur.obs_value::numeric AS level,
          CASE WHEN prev.obs_value IS NULL OR prev.obs_value = 0 THEN NULL
            ELSE ln(cur.obs_value / prev.obs_value)::numeric(20,12)
          END AS ret_1d
        FROM (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 20
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          LIMIT 1
        ) cur
        LEFT JOIN (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 20
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          OFFSET 1 LIMIT 1
        ) prev ON true
      ) spx ON true
      LEFT JOIN LATERAL (
        SELECT cur.obs_value::numeric AS level
        FROM (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 21
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          LIMIT 1
        ) cur
      ) vix ON true
      LEFT JOIN LATERAL (
        SELECT
          cur.obs_value::numeric AS level,
          CASE WHEN prev.obs_value IS NULL OR prev.obs_value = 0 THEN NULL
            ELSE ln(cur.obs_value / prev.obs_value)::numeric(20,12)
          END AS ret_1d
        FROM (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 12
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          LIMIT 1
        ) cur
        LEFT JOIN (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 12
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          OFFSET 1 LIMIT 1
        ) prev ON true
      ) wti ON true
      LEFT JOIN LATERAL (
        SELECT
          cur.obs_value::numeric AS level,
          CASE WHEN prev.obs_value IS NULL OR prev.obs_value = 0 THEN NULL
            ELSE ln(cur.obs_value / prev.obs_value)::numeric(20,12)
          END AS ret_1d
        FROM (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 18
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          LIMIT 1
        ) cur
        LEFT JOIN (
          SELECT obs_value
          FROM dp.viz_map_data
          WHERE map_id = 18
            AND obs_value IS NOT NULL
            AND obs_date <= a.anchor_trade_date
          ORDER BY obs_date DESC
          OFFSET 1 LIMIT 1
        ) prev ON true
      ) dxy ON true
    ),
    snapshot AS (
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
        a.ret_1d,
        a.ret_5d,
        a.ret_20d,
        a.std_20,
        a.momentum_5_20,
        m.krwusd_level,
        m.krwusd_ret_1d,
        m.us10y_level,
        m.us10y_ret_1d,
        m.nasdaq_level,
        m.nasdaq_ret_1d,
        m.sp500_level,
        m.sp500_ret_1d,
        m.vix_level,
        m.wti_level,
        m.wti_ret_1d,
        m.dxy_level,
        m.dxy_ret_1d,
        n2.news_cnt_total AS news_cnt_total_2h,
        n2.news_cnt_pos AS news_cnt_pos_2h,
        n2.news_cnt_neg AS news_cnt_neg_2h,
        n2.sent_mean AS sent_mean_2h,
        n24.news_cnt_total_24h,
        n24.news_cnt_pos_24h,
        n24.news_cnt_neg_24h,
        n24.sent_mean_24h,
        n24.topic_semiconductor_mean_24h
      FROM anchor_base a
      LEFT JOIN LATERAL (
        SELECT
          n.news_cnt_total, n.news_cnt_pos, n.news_cnt_neg, n.sent_mean
        FROM dp.news_feature_hourly n
        WHERE n.market_code = $1
          AND n.bucket_minutes = $3
          AND n.feature_ts <= $5::timestamptz
        ORDER BY n.feature_ts DESC
        LIMIT 1
      ) n2 ON true
      LEFT JOIN LATERAL (
        SELECT
          sum(n.news_cnt_total)::int AS news_cnt_total_24h,
          sum(n.news_cnt_pos)::int AS news_cnt_pos_24h,
          sum(n.news_cnt_neg)::int AS news_cnt_neg_24h,
          avg(n.sent_mean)::numeric(14,8) AS sent_mean_24h,
          avg(n.topic_semiconductor_mean)::numeric(14,8) AS topic_semiconductor_mean_24h
        FROM dp.news_feature_hourly n
        WHERE n.market_code = $1
          AND n.bucket_minutes = $3
          AND n.feature_ts <= $5::timestamptz
          AND n.feature_ts > $5::timestamptz - interval '24 hours'
      ) n24 ON true
      LEFT JOIN macro_snapshot m ON m.anchor_trade_date = a.anchor_trade_date
    ),
    horizons AS (
      SELECT unnest(ARRAY[1,5,20])::int AS horizon_days
    ),
    neighbors AS (
      SELECT
        h.horizon_days,
        l.target_return,
        (
          abs(coalesce(f.ret_1d, 0) - coalesce(s.ret_1d, 0)) * 2.0 +
          abs(coalesce(f.ret_5d, 0) - coalesce(s.ret_5d, 0)) * 1.5 +
          abs(coalesce(f.ret_20d, 0) - coalesce(s.ret_20d, 0)) * 1.0 +
          abs(coalesce(f.momentum_5_20, 0) - coalesce(s.momentum_5_20, 0)) * 1.0 +
          abs(coalesce(f.std_20, 0) - coalesce(s.std_20, 0)) * 0.2
        ) AS distance
      FROM snapshot s
      CROSS JOIN horizons h
      JOIN dp.feature_store_kospi f
        ON f.market_code = s.market_code
       AND f.bucket_minutes = s.bucket_minutes
      JOIN dp.label_store_kospi l
        ON l.as_of_date = f.as_of_date
       AND l.horizon_days = h.horizon_days
      WHERE f.ret_1d IS NOT NULL
        AND f.ret_5d IS NOT NULL
        AND f.ret_20d IS NOT NULL
    ),
    ranked AS (
      SELECT
        horizon_days,
        target_return,
        row_number() OVER (PARTITION BY horizon_days ORDER BY distance ASC) AS rn
      FROM neighbors
    ),
    base_pred AS (
      SELECT
        horizon_days,
        avg(target_return)::numeric(20,12) AS pred_return_base,
        count(*)::int AS neighbor_count
      FROM ranked
      WHERE rn <= 120
      GROUP BY horizon_days
    ),
    final_pred AS (
      SELECT
        s.target_trade_date,
        s.cutoff_ts,
        s.anchor_trade_date,
        s.anchor_as_of_ts,
        s.close_t AS anchor_close,
        s.krwusd_ret_1d,
        s.us10y_ret_1d,
        s.nasdaq_ret_1d,
        s.sp500_ret_1d,
        s.vix_level,
        s.wti_ret_1d,
        s.dxy_ret_1d,
        b.horizon_days,
        b.neighbor_count,
        (
          coalesce(s.sent_mean_24h, 0) * 0.006 +
          ((coalesce(s.news_cnt_pos_24h, 0) - coalesce(s.news_cnt_neg_24h, 0))::numeric / greatest(coalesce(s.news_cnt_total_24h, 0), 1)) * 0.004 +
          coalesce(s.topic_semiconductor_mean_24h, 0) * 0.002
        )::numeric(20,12) AS news_signal,
        (
          coalesce(s.nasdaq_ret_1d, 0) * 0.35 +
          coalesce(s.sp500_ret_1d, 0) * 0.25 -
          coalesce(s.krwusd_ret_1d, 0) * 0.20 -
          coalesce(s.us10y_ret_1d, 0) * 0.10 -
          coalesce(s.wti_ret_1d, 0) * 0.05 -
          coalesce(s.dxy_ret_1d, 0) * 0.08 -
          greatest(coalesce(s.vix_level, 20) - 20, 0) / 100.0
        )::numeric(20,12) AS macro_signal,
        (
          b.pred_return_base +
          (
            (
              coalesce(s.sent_mean_24h, 0) * 0.006 +
              ((coalesce(s.news_cnt_pos_24h, 0) - coalesce(s.news_cnt_neg_24h, 0))::numeric / greatest(coalesce(s.news_cnt_total_24h, 0), 1)) * 0.004 +
              coalesce(s.topic_semiconductor_mean_24h, 0) * 0.002
            ) *
            CASE b.horizon_days WHEN 1 THEN 1.00 WHEN 5 THEN 0.70 ELSE 0.40 END
          )
          +
          (
            (
              coalesce(s.nasdaq_ret_1d, 0) * 0.35 +
              coalesce(s.sp500_ret_1d, 0) * 0.25 -
              coalesce(s.krwusd_ret_1d, 0) * 0.20 -
              coalesce(s.us10y_ret_1d, 0) * 0.10 -
              coalesce(s.wti_ret_1d, 0) * 0.05 -
              coalesce(s.dxy_ret_1d, 0) * 0.08 -
              greatest(coalesce(s.vix_level, 20) - 20, 0) / 100.0
            ) *
            CASE b.horizon_days WHEN 1 THEN 0.60 WHEN 5 THEN 0.45 ELSE 0.30 END
          )
        )::numeric(20,12) AS pred_return,
        (
          s.close_t *
          exp(
            b.pred_return_base +
            (
              (
                coalesce(s.sent_mean_24h, 0) * 0.006 +
                ((coalesce(s.news_cnt_pos_24h, 0) - coalesce(s.news_cnt_neg_24h, 0))::numeric / greatest(coalesce(s.news_cnt_total_24h, 0), 1)) * 0.004 +
                coalesce(s.topic_semiconductor_mean_24h, 0) * 0.002
              ) *
              CASE b.horizon_days WHEN 1 THEN 1.00 WHEN 5 THEN 0.70 ELSE 0.40 END
            )
            +
            (
              (
                coalesce(s.nasdaq_ret_1d, 0) * 0.35 +
                coalesce(s.sp500_ret_1d, 0) * 0.25 -
                coalesce(s.krwusd_ret_1d, 0) * 0.20 -
                coalesce(s.us10y_ret_1d, 0) * 0.10 -
                coalesce(s.wti_ret_1d, 0) * 0.05 -
                coalesce(s.dxy_ret_1d, 0) * 0.08 -
                greatest(coalesce(s.vix_level, 20) - 20, 0) / 100.0
              ) *
              CASE b.horizon_days WHEN 1 THEN 0.60 WHEN 5 THEN 0.45 ELSE 0.30 END
            )
          )
        )::numeric(20,8) AS pred_close,
        (
          1.0 / (
            1.0 + exp(
              -1.0 * (
                (
                  b.pred_return_base +
                  (
                    (
                      coalesce(s.sent_mean_24h, 0) * 0.006 +
                      ((coalesce(s.news_cnt_pos_24h, 0) - coalesce(s.news_cnt_neg_24h, 0))::numeric / greatest(coalesce(s.news_cnt_total_24h, 0), 1)) * 0.004 +
                      coalesce(s.topic_semiconductor_mean_24h, 0) * 0.002
                    ) *
                    CASE b.horizon_days WHEN 1 THEN 1.00 WHEN 5 THEN 0.70 ELSE 0.40 END
                  )
                  +
                  (
                    (
                      coalesce(s.nasdaq_ret_1d, 0) * 0.35 +
                      coalesce(s.sp500_ret_1d, 0) * 0.25 -
                      coalesce(s.krwusd_ret_1d, 0) * 0.20 -
                      coalesce(s.us10y_ret_1d, 0) * 0.10 -
                      coalesce(s.wti_ret_1d, 0) * 0.05 -
                      coalesce(s.dxy_ret_1d, 0) * 0.08 -
                      greatest(coalesce(s.vix_level, 20) - 20, 0) / 100.0
                    ) *
                    CASE b.horizon_days WHEN 1 THEN 0.60 WHEN 5 THEN 0.45 ELSE 0.30 END
                  )
                ) / greatest(coalesce(s.std_20 / nullif(s.close_t, 0), 0.0), 0.002)
              )
            )
          )
        )::numeric(10,6) AS up_prob
      FROM snapshot s
      JOIN base_pred b ON true
    )
    SELECT
      to_char(target_trade_date, 'YYYY-MM-DD') AS target_trade_date,
      cutoff_ts,
      to_char(anchor_trade_date, 'YYYY-MM-DD') AS anchor_trade_date,
      anchor_as_of_ts,
      anchor_close,
      horizon_days, neighbor_count, news_signal, macro_signal, pred_return, pred_close, up_prob,
      krwusd_ret_1d, us10y_ret_1d, nasdaq_ret_1d, sp500_ret_1d, vix_level, wti_ret_1d, dxy_ret_1d
    FROM final_pred
    ORDER BY horizon_days ASC
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
        { ok: false, error: "예측에 필요한 학습 이웃을 찾지 못했습니다." },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      model: "baseline_knn_news_adjusted_v1",
      marketCode,
      sourceMapId,
      bucketMinutes,
      featureVersion,
      targetTradeDate,
      cutoffTs: cutoffTs.toISOString(),
      predictions: result.rows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "코스피 자동 예측에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
