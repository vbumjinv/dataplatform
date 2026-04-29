export type SeriesMeta = {
  seriesId: string;
  seriesNameKo: string | null;
  unitName: string | null;
  freqCd: string | null;
  domainLarge: string | null;
  domainSmall: string | null;
  isRepresentative: boolean;
};

export type TimeSeriesPoint = {
  ds: string;
  y: number;
};

export type ForecastPoint = {
  ds: string;
  yhat: number;
  yhatLower: number | null;
  yhatUpper: number | null;
};

export type ForecastMetrics = {
  mae: number | null;
  rmse: number | null;
};

