import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClient } from "../_lib/db";

export const runtime = "nodejs";

type AggregatePayload = {
  marketCode?: string;
  bucketMinutes?: number;
  lookbackHours?: number;
};

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) return fallback;
  return normalized;
};

export async function POST(request: Request) {
  let payload: AggregatePayload | null = null;
  try {
    payload = (await request.json()) as AggregatePayload;
  } catch {
    payload = {};
  }

  const marketCode = (payload?.marketCode ?? "KOSPI").trim() || "KOSPI";
  const bucketMinutes = toPositiveInt(payload?.bucketMinutes, 120);
  const lookbackHours = toPositiveInt(payload?.lookbackHours, 24 * 30);

  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const client = createDbClient();
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const upsertSql = `
    WITH base AS (
      SELECT
        r.market_code,
        r.published_at,
        e.sentiment_score,
        e.impact_score,
        e.topic_macro,
        e.topic_rate,
        e.topic_semiconductor,
        e.topic_fx,
        e.topic_oil
      FROM dp.news_raw r
      JOIN dp.news_enriched e ON e.news_id = r.news_id
      WHERE r.market_code = $1
        AND r.published_at >= now() - ($3::text || ' hours')::interval
        AND COALESCE(e.is_duplicate, false) = false
        AND COALESCE(e.quality_flag, 'normal') <> 'low_quality'
    ),
    bucketed AS (
      SELECT
        market_code,
        to_timestamp(
          floor(extract(epoch from published_at) / ($2::numeric * 60)) * ($2::numeric * 60)
          + ($2::numeric * 60)
        )::timestamptz AS feature_ts,
        sentiment_score,
        impact_score,
        topic_macro,
        topic_rate,
        topic_semiconductor,
        topic_fx,
        topic_oil
      FROM base
    ),
    agg AS (
      SELECT
        feature_ts,
        market_code,
        $2::int AS bucket_minutes,
        count(*)::int AS news_cnt_total,
        count(*) FILTER (WHERE sentiment_score > 0.05)::int AS news_cnt_pos,
        count(*) FILTER (WHERE sentiment_score < -0.05)::int AS news_cnt_neg,
        avg(sentiment_score)::numeric(14,8) AS sent_mean,
        stddev_samp(sentiment_score)::numeric(14,8) AS sent_std,
        sum(impact_score)::numeric(20,8) AS impact_sum,
        avg(impact_score)::numeric(20,8) AS impact_mean,
        avg(topic_macro)::numeric(14,8) AS topic_macro_mean,
        avg(topic_rate)::numeric(14,8) AS topic_rate_mean,
        avg(topic_semiconductor)::numeric(14,8) AS topic_semiconductor_mean,
        avg(topic_fx)::numeric(14,8) AS topic_fx_mean,
        avg(topic_oil)::numeric(14,8) AS topic_oil_mean
      FROM bucketed
      GROUP BY feature_ts, market_code
    )
    INSERT INTO dp.news_feature_hourly (
      feature_ts, market_code, bucket_minutes,
      news_cnt_total, news_cnt_pos, news_cnt_neg,
      sent_mean, sent_std, impact_sum, impact_mean,
      topic_macro_mean, topic_rate_mean, topic_semiconductor_mean, topic_fx_mean, topic_oil_mean,
      surprise_ratio
    )
    SELECT
      feature_ts, market_code, bucket_minutes,
      news_cnt_total, news_cnt_pos, news_cnt_neg,
      sent_mean, sent_std, impact_sum, impact_mean,
      topic_macro_mean, topic_rate_mean, topic_semiconductor_mean, topic_fx_mean, topic_oil_mean,
      NULL::numeric
    FROM agg
    ON CONFLICT (feature_ts, market_code, bucket_minutes)
    DO UPDATE SET
      news_cnt_total = EXCLUDED.news_cnt_total,
      news_cnt_pos = EXCLUDED.news_cnt_pos,
      news_cnt_neg = EXCLUDED.news_cnt_neg,
      sent_mean = EXCLUDED.sent_mean,
      sent_std = EXCLUDED.sent_std,
      impact_sum = EXCLUDED.impact_sum,
      impact_mean = EXCLUDED.impact_mean,
      topic_macro_mean = EXCLUDED.topic_macro_mean,
      topic_rate_mean = EXCLUDED.topic_rate_mean,
      topic_semiconductor_mean = EXCLUDED.topic_semiconductor_mean,
      topic_fx_mean = EXCLUDED.topic_fx_mean,
      topic_oil_mean = EXCLUDED.topic_oil_mean
    RETURNING feature_ts
  `;

  const surpriseSql = `
    WITH base AS (
      SELECT
        feature_ts,
        market_code,
        bucket_minutes,
        news_cnt_total,
        (extract(hour from feature_ts)::int * 60 + extract(minute from feature_ts)::int) AS slot_minute
      FROM dp.news_feature_hourly
      WHERE market_code = $1
        AND bucket_minutes = $2
    ),
    scored AS (
      SELECT
        feature_ts,
        market_code,
        bucket_minutes,
        CASE
          WHEN avg(news_cnt_total::numeric) OVER (
            PARTITION BY market_code, bucket_minutes, slot_minute
            ORDER BY feature_ts
            ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING
          ) > 0
            THEN (news_cnt_total::numeric /
              avg(news_cnt_total::numeric) OVER (
                PARTITION BY market_code, bucket_minutes, slot_minute
                ORDER BY feature_ts
                ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING
              )
            )::numeric(14,8)
          ELSE NULL
        END AS surprise_ratio
      FROM base
    )
    UPDATE dp.news_feature_hourly t
    SET surprise_ratio = s.surprise_ratio
    FROM scored s
    WHERE t.feature_ts = s.feature_ts
      AND t.market_code = s.market_code
      AND t.bucket_minutes = s.bucket_minutes
      AND t.market_code = $1
      AND t.bucket_minutes = $2
  `;

  try {
    await connectWithTimeout(client);
    await client.query("BEGIN");

    const upsertResult = await client.query(upsertSql, [marketCode, bucketMinutes, lookbackHours]);
    await client.query(surpriseSql, [marketCode, bucketMinutes]);

    await client.query("COMMIT");

    return NextResponse.json({
      ok: true,
      marketCode,
      bucketMinutes,
      lookbackHours,
      upsertedCount: upsertResult.rowCount ?? 0,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    const message = error instanceof Error ? error.message : "뉴스 집계 실행에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
