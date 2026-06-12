 "use client";

import { useEffect, useMemo, useState } from "react";

type Point = {
  ds: string;
  y: number;
};

type PredictionRow = {
  target_trade_date: string;
  cutoff_ts: string;
  anchor_trade_date: string;
  anchor_as_of_ts: string;
  anchor_close: string | number;
  horizon_days: number;
  neighbor_count: number;
  news_signal: string | number;
  macro_signal: string | number;
  pred_return: string | number;
  pred_close: string | number;
  up_prob: string | number;
  krwusd_ret_1d?: string | number | null;
  us10y_ret_1d?: string | number | null;
  nasdaq_ret_1d?: string | number | null;
  sp500_ret_1d?: string | number | null;
  vix_level?: string | number | null;
  wti_ret_1d?: string | number | null;
  dxy_ret_1d?: string | number | null;
};

const chartWidth = 980;
const chartHeight = 340;
const padding = { top: 20, right: 52, bottom: 36, left: 52 };

const toKstDateText = (value: Date) => {
  const kst = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
};

const formatNum = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value)
    : "-";

const horizonWeight = (horizonDays: number, type: "news" | "macro") => {
  if (type === "news") {
    if (horizonDays === 1) return 1.0;
    if (horizonDays === 5) return 0.7;
    return 0.4;
  }
  if (horizonDays === 1) return 0.6;
  if (horizonDays === 5) return 0.45;
  return 0.3;
};

const toPctText = (value: number) => `${formatNum(value * 100)}%`;

export default function AnalysisPage() {
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState("");
  const [pipelineError, setPipelineError] = useState("");
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState("");
  const [series, setSeries] = useState<Point[]>([]);
  const [predRunning, setPredRunning] = useState(false);
  const [predError, setPredError] = useState("");
  const [predTargetDate, setPredTargetDate] = useState(toKstDateText(new Date()));
  const [predictions, setPredictions] = useState<PredictionRow[]>([]);

  const runNewsPipelineStep = async (
    step: "ingest" | "aggregate" | "feature" | "inference",
  ) => {
    setPipelineRunning(true);
    setPipelineError("");
    setPipelineStatus("");
    try {
      const endpoint =
        step === "ingest"
          ? "/api/ai-forecast/news-ingest"
          : step === "aggregate"
            ? "/api/ai-forecast/news-aggregate"
            : step === "feature"
              ? "/api/ai-forecast/feature-refresh"
              : "/api/ai-forecast/inference-feature-build";
      const body =
        step === "ingest"
          ? { provider: "auto", displayPerQuery: 5 }
          : step === "aggregate"
            ? { marketCode: "KOSPI", bucketMinutes: 120, lookbackHours: 24 * 30 }
            : step === "feature"
              ? { marketCode: "KOSPI", sourceMapId: 2, bucketMinutes: 120, featureVersion: "v1" }
              : {
                  marketCode: "KOSPI",
                  sourceMapId: 2,
                  bucketMinutes: 120,
                  featureVersion: "v1",
                  cutoffTs: new Date().toISOString(),
                };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        snapshot?: {
          target_trade_date?: string;
          anchor_trade_date?: string;
          missing_feature_count?: number;
        };
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "파이프라인 단계 실행에 실패했습니다.");
      }
      setPipelineStatus(
        step === "ingest"
          ? "뉴스 수집/수치화 완료"
          : step === "aggregate"
            ? "뉴스 시간집계 완료"
            : step === "feature"
              ? "feature_store 재생성 완료"
              : `운영 예측 피처 생성 완료 (target: ${payload.snapshot?.target_trade_date ?? "-"}, anchor: ${
                  payload.snapshot?.anchor_trade_date ?? "-"
                }, missing: ${payload.snapshot?.missing_feature_count ?? "-"})`,
      );
    } catch (error) {
      setPipelineError(
        error instanceof Error ? error.message : "파이프라인 단계 실행에 실패했습니다.",
      );
    } finally {
      setPipelineRunning(false);
    }
  };

  const runNewsPipelineAll = async () => {
    setPipelineRunning(true);
    setPipelineError("");
    setPipelineStatus("");
    try {
      const response = await fetch("/api/ai-forecast/news-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stopOnError: true,
          ingest: { provider: "auto", displayPerQuery: 5 },
          aggregate: { marketCode: "KOSPI", bucketMinutes: 120, lookbackHours: 24 * 30 },
          featureRefresh: { marketCode: "KOSPI", sourceMapId: 2, bucketMinutes: 120, featureVersion: "v1" },
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        results?: Array<{ step: string; ok: boolean }>;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "뉴스 파이프라인 전체 실행에 실패했습니다.");
      }
      const successSteps = (payload.results ?? []).filter((item) => item.ok).map((item) => item.step);
      setPipelineStatus(`뉴스 파이프라인 완료: ${successSteps.join(" -> ")}`);
    } catch (error) {
      setPipelineError(
        error instanceof Error ? error.message : "뉴스 파이프라인 전체 실행에 실패했습니다.",
      );
    } finally {
      setPipelineRunning(false);
    }
  };

  const fetchKospiSeries = async () => {
    setSeriesLoading(true);
    setSeriesError("");
    try {
      const response = await fetch("/api/ai-forecast/kospi-series?mapId=2&lookbackDays=365");
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        points?: Point[];
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "코스피 시계열 조회에 실패했습니다.");
      }
      setSeries(payload.points ?? []);
    } catch (error) {
      setSeriesError(error instanceof Error ? error.message : "코스피 시계열 조회에 실패했습니다.");
    } finally {
      setSeriesLoading(false);
    }
  };

  useEffect(() => {
    void fetchKospiSeries();
  }, []);

  const runKospiPrediction = async () => {
    setPredRunning(true);
    setPredError("");
    try {
      const response = await fetch("/api/ai-forecast/kospi-predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketCode: "KOSPI",
          sourceMapId: 2,
          bucketMinutes: 120,
          featureVersion: "v1",
          targetTradeDate: predTargetDate,
          cutoffTs: new Date().toISOString(),
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        predictions?: PredictionRow[];
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "코스피 자동 예측 실행에 실패했습니다.");
      }
      setPredictions(payload.predictions ?? []);
    } catch (error) {
      setPredError(error instanceof Error ? error.message : "코스피 자동 예측 실행에 실패했습니다.");
    } finally {
      setPredRunning(false);
    }
  };

  const chartModel = useMemo(() => {
    if (!series.length) return null;
    const oneDay = predictions.find((item) => Number(item.horizon_days) === 1);
    const predNum = oneDay ? Number(oneDay.pred_close) : Number.NaN;
    const predDate = oneDay ? String(oneDay.target_trade_date).slice(0, 10) : "";
    const hasPred = Number.isFinite(predNum) && /^\d{4}-\d{2}-\d{2}$/.test(predDate);
    const allValues = hasPred ? [...series.map((item) => item.y), predNum] : series.map((item) => item.y);
    const yMin = Math.min(...allValues);
    const yMax = Math.max(...allValues);
    const span = Math.max(1e-6, yMax - yMin);
    const xStep = (chartWidth - padding.left - padding.right) / Math.max(1, series.length - 1);
    const toY = (value: number) =>
      padding.top + ((yMax - value) / span) * (chartHeight - padding.top - padding.bottom);

    const actualPoints = series
      .map((item, index) => `${padding.left + index * xStep},${toY(item.y)}`)
      .join(" ");

    const last = series[series.length - 1];
    const predX = padding.left + (series.length - 1) * xStep + xStep;
    const predictionSegment =
      hasPred && last
        ? {
            fromX: padding.left + (series.length - 1) * xStep,
            fromY: toY(last.y),
            toX: predX,
            toY: toY(predNum),
            predNum,
            predDate,
          }
        : null;

    return {
      min: yMin,
      max: yMax,
      actualPoints,
      xStep,
      toY,
      predictionSegment,
    };
  }, [predictions, series]);

  const explanations = useMemo(() => {
    return predictions.map((row) => {
      const horizon = Number(row.horizon_days);
      const predReturn = Number(row.pred_return);
      const newsSignal = Number(row.news_signal);
      const macroSignal = Number(row.macro_signal);
      const newsContrib = newsSignal * horizonWeight(horizon, "news");
      const macroContrib = macroSignal * horizonWeight(horizon, "macro");
      const baseReturn = predReturn - newsContrib - macroContrib;

      const macroContribParts = [
        { key: "NASDAQ", value: Number(row.nasdaq_ret_1d) * 0.35 },
        { key: "SP500", value: Number(row.sp500_ret_1d) * 0.25 },
        { key: "KRWUSD", value: Number(row.krwusd_ret_1d) * -0.2 },
        { key: "US10Y", value: Number(row.us10y_ret_1d) * -0.1 },
        { key: "WTI", value: Number(row.wti_ret_1d) * -0.05 },
        { key: "DXY", value: Number(row.dxy_ret_1d) * -0.08 },
        { key: "VIX", value: -(Math.max(Number(row.vix_level) - 20, 0) / 100.0) },
      ];
      const topMacro = [...macroContribParts]
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, 2);

      const direction = predReturn >= 0 ? "상승" : "하락";
      const newsDirection = newsContrib >= 0 ? "상방" : "하방";
      const macroDirection = macroContrib >= 0 ? "상방" : "하방";

      return {
        horizon,
        direction,
        predReturn,
        baseReturn,
        newsContrib,
        macroContrib,
        newsDirection,
        macroDirection,
        topMacro,
      };
    });
  }, [predictions]);

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">
          코스피 예측
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          뉴스 수집/수치화 파이프라인을 실행하고 운영 예측용 피처 생성을 확인합니다.
        </p>
      </header>

      <div className="rounded-3xl border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-semibold text-slate-900">뉴스 고도화 파이프라인</h3>
        <p className="mt-1 text-xs text-slate-600">
          실제 뉴스 수집 → LLM 수치화 적재 → 시간집계 → feature_store 재생성 순서로 실행합니다.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => void runNewsPipelineStep("ingest")}
            disabled={pipelineRunning}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            뉴스 수집/수치화
          </button>
          <button
            onClick={() => void runNewsPipelineStep("aggregate")}
            disabled={pipelineRunning}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            뉴스 시간집계
          </button>
          <button
            onClick={() => void runNewsPipelineStep("feature")}
            disabled={pipelineRunning}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            feature_store 재생성
          </button>
          <button
            onClick={() => void runNewsPipelineStep("inference")}
            disabled={pipelineRunning}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            운영 예측 피처 생성
          </button>
          <button
            onClick={() => void runNewsPipelineAll()}
            disabled={pipelineRunning}
            className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {pipelineRunning ? "실행 중..." : "전체 실행"}
          </button>
        </div>
        {pipelineStatus ? <p className="mt-2 text-xs text-emerald-700">{pipelineStatus}</p> : null}
        {pipelineError ? <p className="mt-2 text-xs text-rose-600">{pipelineError}</p> : null}
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">코스피 실제 + 예측 그래프</h3>
          <button
            onClick={() => void fetchKospiSeries()}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            disabled={seriesLoading}
          >
            {seriesLoading ? "조회 중..." : "실제 데이터 새로고침"}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-600">
          실제 데이터(map_id=2)와 자동 예측값(1일)을 이어서 시각화합니다.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[180px_auto_auto]">
          <input
            type="date"
            value={predTargetDate}
            onChange={(e) => setPredTargetDate(e.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <button
            onClick={() => void runKospiPrediction()}
            disabled={predRunning}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {predRunning ? "예측 실행 중..." : "코스피 자동 예측 실행"}
          </button>
          <div className="text-xs text-slate-500">문서 기준 자동 변수(가격+뉴스+환율/금리/미국지수/VIX/WTI)로 1/5/20일 예측을 계산합니다.</div>
        </div>
        {seriesError ? <p className="mt-2 text-xs text-rose-600">{seriesError}</p> : null}
        {predError ? <p className="mt-2 text-xs text-rose-600">{predError}</p> : null}
        {chartModel ? (
          <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="mt-4 w-full rounded-xl border border-slate-200 bg-white">
            <line
              x1={padding.left}
              y1={padding.top}
              x2={padding.left}
              y2={chartHeight - padding.bottom}
              stroke="#cbd5e1"
            />
            <line
              x1={padding.left}
              y1={chartHeight - padding.bottom}
              x2={chartWidth - padding.right}
              y2={chartHeight - padding.bottom}
              stroke="#cbd5e1"
            />
            <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={chartModel.actualPoints} />
            {chartModel.predictionSegment ? (
              <>
                <line
                  x1={chartModel.predictionSegment.fromX}
                  y1={chartModel.predictionSegment.fromY}
                  x2={chartModel.predictionSegment.toX}
                  y2={chartModel.predictionSegment.toY}
                  stroke="#dc2626"
                  strokeWidth="2"
                  strokeDasharray="6 4"
                />
                <circle
                  cx={chartModel.predictionSegment.toX}
                  cy={chartModel.predictionSegment.toY}
                  r="4"
                  fill="#dc2626"
                />
                <text x={chartModel.predictionSegment.toX - 16} y={chartModel.predictionSegment.toY - 8} fontSize="10" fill="#dc2626">
                  {chartModel.predictionSegment.predDate}
                </text>
              </>
            ) : null}
            <text x={padding.left} y={14} fontSize="10" fill="#2563eb">actual</text>
            <text x={padding.left + 55} y={14} fontSize="10" fill="#dc2626">prediction</text>
            {series.map((item, idx) => {
              const labelStep = Math.max(1, Math.floor(series.length / 8));
              if (idx % labelStep !== 0) return null;
              const x = padding.left + idx * chartModel.xStep;
              return (
                <text key={item.ds} x={x - 14} y={chartHeight - 10} fontSize="10" fill="#64748b">
                  {item.ds.slice(5)}
                </text>
              );
            })}
            <text x={padding.left - 10} y={padding.top + 6} textAnchor="end" fontSize="10" fill="#64748b">
              {formatNum(chartModel.max)}
            </text>
            <text x={padding.left - 10} y={chartHeight - padding.bottom + 4} textAnchor="end" fontSize="10" fill="#64748b">
              {formatNum(chartModel.min)}
            </text>
          </svg>
        ) : (
          <p className="mt-4 text-sm text-slate-500">실제 코스피 데이터가 없습니다.</p>
        )}

        {predictions.length ? (
          <div className="mt-4 rounded-xl border border-slate-200">
            <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              거시 입력(최근 1일): KRWUSD {formatNum(Number(predictions[0]?.krwusd_ret_1d) * 100)}%, US10Y {formatNum(Number(predictions[0]?.us10y_ret_1d) * 100)}%, NASDAQ {formatNum(Number(predictions[0]?.nasdaq_ret_1d) * 100)}%, SP500 {formatNum(Number(predictions[0]?.sp500_ret_1d) * 100)}%, VIX {formatNum(Number(predictions[0]?.vix_level))}, WTI {formatNum(Number(predictions[0]?.wti_ret_1d) * 100)}%, DXY {formatNum(Number(predictions[0]?.dxy_ret_1d) * 100)}%
            </div>
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-2">target</th>
                  <th className="px-2 py-2">horizon</th>
                  <th className="px-2 py-2">뉴스신호</th>
                  <th className="px-2 py-2">거시신호</th>
                  <th className="px-2 py-2">예상 수익률</th>
                  <th className="px-2 py-2">예상 종가</th>
                  <th className="px-2 py-2">상승확률</th>
                  <th className="px-2 py-2">이웃수</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((row) => (
                  <tr key={row.horizon_days} className="border-t border-slate-100">
                    <td className="px-2 py-2">{String(row.target_trade_date).slice(0, 10)}</td>
                    <td className="px-2 py-2">{row.horizon_days}일</td>
                    <td className="px-2 py-2">{formatNum(Number(row.news_signal) * 100)}%</td>
                    <td className="px-2 py-2">{formatNum(Number(row.macro_signal) * 100)}%</td>
                    <td className="px-2 py-2">{formatNum(Number(row.pred_return) * 100)}%</td>
                    <td className="px-2 py-2">{formatNum(Number(row.pred_close))}</td>
                    <td className="px-2 py-2">{formatNum(Number(row.up_prob) * 100)}%</td>
                    <td className="px-2 py-2">{row.neighbor_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {explanations.length ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h4 className="text-sm font-semibold text-slate-900">왜 이렇게 예측했는지</h4>
            <div className="mt-2 grid gap-2">
              {explanations.map((item) => (
                <div key={item.horizon} className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700">
                  <p className="font-semibold text-slate-900">
                    {item.horizon}일 예측: {item.direction} ({toPctText(item.predReturn)})
                  </p>
                  <p className="mt-1">
                    기본 패턴(과거 유사구간 평균) {toPctText(item.baseReturn)} + 뉴스 기여({item.newsDirection}) {toPctText(item.newsContrib)} + 거시 기여({item.macroDirection}) {toPctText(item.macroContrib)} 로 계산되었습니다.
                  </p>
                  <p className="mt-1 text-slate-600">
                    거시 주요 요인: {item.topMacro.map((x) => `${x.key} ${toPctText(x.value)}`).join(", ")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

