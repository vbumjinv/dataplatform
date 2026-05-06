import type { ForecastCompositeScore, ForecastMetrics } from "./types";

type ForecastScoreRow = {
  yhat: number;
  actual?: number | null;
};

const round = (value: number, digits = 2) => {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const ratioToScore = (ratio: number, badAt: number) => {
  if (!Number.isFinite(ratio)) return 0;
  if (!Number.isFinite(badAt) || badAt <= 0) return 0;
  return round(100 * (1 - clamp01(ratio / badAt)));
};

const getGrade = (value: number | null): ForecastCompositeScore["grade"] => {
  if (value == null) return null;
  if (value >= 90) return "S";
  if (value >= 80) return "A";
  if (value >= 70) return "B";
  if (value >= 55) return "C";
  return "D";
};

const calcDirectionAccuracy = (rows: Array<{ actual: number; yhat: number }>) => {
  if (rows.length < 2) return null;
  let comparable = 0;
  let matched = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const actualDelta = rows[i].actual - rows[i - 1].actual;
    const predDelta = rows[i].yhat - rows[i - 1].yhat;
    const sameDirection =
      (actualDelta > 0 && predDelta > 0) ||
      (actualDelta < 0 && predDelta < 0) ||
      (actualDelta === 0 && predDelta === 0);
    comparable += 1;
    if (sameDirection) matched += 1;
  }
  if (!comparable) return null;
  return matched / comparable;
};

export const buildForecastCompositeScore = (
  metrics: ForecastMetrics,
  forecast: ForecastScoreRow[],
): ForecastCompositeScore => {
  const usable = forecast.filter(
    (row): row is { yhat: number; actual: number } =>
      Number.isFinite(row.yhat) &&
      typeof row.actual === "number" &&
      Number.isFinite(row.actual),
  );
  if (!usable.length) {
    return {
      value: null,
      grade: null,
      sampleCount: 0,
      directionAccuracy: null,
      note: "holdout 실제값이 없어 종합점수를 계산하지 못했습니다.",
    };
  }

  const absActualMean =
    usable.reduce((sum, row) => sum + Math.abs(row.actual), 0) / usable.length;
  const scale = absActualMean > 1e-9 ? absActualMean : 1;
  const errors = usable.map((row) => row.yhat - row.actual);
  const maeRaw = errors.reduce((sum, e) => sum + Math.abs(e), 0) / usable.length;
  const rmseRaw = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / usable.length);
  const mapeCandidates = usable
    .filter((row) => row.actual !== 0)
    .map((row) => Math.abs((row.yhat - row.actual) / row.actual));
  const mapeRaw =
    mapeCandidates.length > 0
      ? (mapeCandidates.reduce((sum, v) => sum + v, 0) / mapeCandidates.length) * 100
      : null;

  const mae = Number.isFinite(metrics.mae as number) ? (metrics.mae as number) : maeRaw;
  const rmse = Number.isFinite(metrics.rmse as number) ? (metrics.rmse as number) : rmseRaw;
  const mape = Number.isFinite(metrics.mape as number) ? (metrics.mape as number) : mapeRaw;
  const biasRatio = Math.abs(errors.reduce((sum, e) => sum + e, 0) / usable.length) / scale;
  const directionAccuracy = calcDirectionAccuracy(usable);

  // 기준점(월별 holdout 용): MAE 25%, RMSE 35%, MAPE 30%, 편향 15%, 방향정확도 100%
  const maeScore = ratioToScore(mae / scale, 0.25);
  const rmseScore = ratioToScore(rmse / scale, 0.35);
  const mapeScore = mape == null ? 50 : ratioToScore(mape / 100, 0.3);
  const biasScore = ratioToScore(biasRatio, 0.15);
  const directionScore = directionAccuracy == null ? 50 : round(directionAccuracy * 100);

  const value = round(
    maeScore * 0.3 +
      rmseScore * 0.25 +
      mapeScore * 0.25 +
      biasScore * 0.1 +
      directionScore * 0.1,
    1,
  );

  return {
    value,
    grade: getGrade(value),
    sampleCount: usable.length,
    directionAccuracy:
      directionAccuracy == null ? null : round(directionAccuracy * 100, 1),
    note: null,
  };
};
