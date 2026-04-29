"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

type TopicKey = "ingestionStatus" | "trendChart" | "analysis" | "report";

type ChartListItem = {
  chartId: number;
  chartName: string;
  chartType: string;
  isPublic: boolean;
  createdBy: string | null;
  analysisConfig?: unknown;
  updatedAt: string;
  seriesCount: number;
};

type ChartDetailSeries = {
  seriesId: string;
  seriesName: string;
  unitName: string | null;
  freq: string;
  displayOrder: number;
  lineColor: string | null;
  yAxisSide: string;
  points: Array<{ obsDate: string; obsValue: number }>;
};

type AnalysisWidgetLayout = {
  id: string;
  type: AnalysisTechnique;
  x: number;
  y: number;
  w: number;
  h: number;
};

type Freq = "D" | "M" | "Q" | "Y";

type AnalysisTechnique =
  | "correlation"
  | "distribution"
  | "kpi"
  | "regression"
  | "trend"
  | "volatility"
  | "anomaly"
  | "seasonality"
  | "forecast";
type AnalysisConfig = {
  baseFreq: Freq | null;
  techniques: AnalysisTechnique[];
};

type ChartReferenceLine = {
  refLineId?: number;
  lineType: "horizontal" | "vertical";
  lineLabel: string | null;
  lineValue: number | null;
  lineDate: string | null;
  lineColor: string | null;
  lineWidth: number;
  lineDash: string | null;
  displayOrder: number;
};

type ReferenceLineDraft = {
  id: string;
  lineType: "horizontal" | "vertical";
  lineLabel: string;
  lineValue: string;
  lineDate: string;
  lineColor: string;
  lineWidth: number;
  lineDash: string;
};

type SeriesListItem = {
  seriesId: string;
  sourceOrg: string;
  sourceTable: string;
  sourceKey: string | null;
  seriesName: string;
  unitName: string | null;
  freq: string;
  isActive: boolean;
};

type YAxisSide = "left" | "right";

type IngestionStatusSummary = {
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  successRate: number;
  insertedTotal: number;
  lastRunAt: string | null;
};

type IngestionStatusDaily = {
  runDate: string;
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  insertedTotal: number;
};

type IngestionStatusBySource = {
  sourceId: number;
  sourceName: string;
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  successRate: number;
};

type IngestionStatusFailure = {
  loadLogId: number;
  startedAt: string;
  sourceName: string;
  groupName: string | null;
  errorStage: string | null;
  errorMessage: string | null;
};

const topics: Array<{ key: TopicKey; label: string; ready: boolean }> = [
  { key: "ingestionStatus", label: "1. 데이터 수집 현황", ready: true },
  { key: "trendChart", label: "2. 데이터 추이 그래프", ready: true },
  { key: "analysis", label: "3. 분석화면", ready: true },
  { key: "report", label: "4. 레포트 화면", ready: false },
];

const chartWidth = 980;
const chartHeight = 340;
const padding = { top: 20, right: 52, bottom: 36, left: 52 };
const colorPalette = ["#2563eb", "#f97316", "#16a34a", "#7c3aed", "#0f766e", "#dc2626"];
const yTickCount = 5;
const referenceLineColorPalette = [
  "#94a3b8",
  "#2563eb",
  "#dc2626",
  "#f97316",
  "#16a34a",
  "#7c3aed",
  "#0f766e",
  "#334155",
  "#14b8a6",
  "#e11d48",
];
const referenceLineWidthOptions = [1, 1.5, 2, 2.5, 3];
const referenceLineDashOptions: Array<{ value: string; previewDash?: string; title: string }> = [
  { value: "none", title: "실선" },
  { value: "6 4", previewDash: "6 4", title: "점선" },
  { value: "2 3", previewDash: "2 3", title: "짧은 점선" },
  { value: "10 4", previewDash: "10 4", title: "긴 점선" },
];

const analysisTechniqueCategories: Array<{
  categoryId: string;
  categoryLabel: string;
  items: Array<{ value: AnalysisTechnique; label: string }>;
}> = [
  {
    categoryId: "relationship",
    categoryLabel: "관계 분석",
    items: [
      { value: "correlation", label: "상관 분석" },
      { value: "regression", label: "회귀 분석" },
    ],
  },
  {
    categoryId: "distribution",
    categoryLabel: "분포/통계",
    items: [
      { value: "distribution", label: "분포 분석" },
      { value: "volatility", label: "변동성 분석" },
    ],
  },
  {
    categoryId: "monitoring",
    categoryLabel: "성과 모니터링",
    items: [{ value: "kpi", label: "KPI 카드" }],
  },
  {
    categoryId: "timeseries",
    categoryLabel: "시계열 분석",
    items: [
      { value: "trend", label: "추세 분석" },
      { value: "seasonality", label: "계절성 분석" },
      { value: "anomaly", label: "이상치 탐지" },
      { value: "forecast", label: "단기 예측" },
    ],
  },
];

const analysisTechniqueOptions: Array<{ value: AnalysisTechnique; label: string }> =
  analysisTechniqueCategories.flatMap((category) => category.items);
const analysisTechniqueValueSet = new Set<AnalysisTechnique>(
  analysisTechniqueOptions.map((item) => item.value),
);
const isAnalysisTechnique = (value: unknown): value is AnalysisTechnique =>
  typeof value === "string" && analysisTechniqueValueSet.has(value as AnalysisTechnique);

const defaultAnalysisTechniques: AnalysisTechnique[] = ["correlation", "distribution", "kpi", "regression"];

const buildAnalysisLayout = (techniques: AnalysisTechnique[]): AnalysisWidgetLayout[] =>
  (techniques.length ? techniques : defaultAnalysisTechniques).map((type, index) => ({
    id: `w-${type}`,
    type,
    x: (index % 2) * 6,
    y: Math.floor(index / 2) * 4,
    w: 6,
    h: 4,
  }));

const defaultAnalysisConfig: AnalysisConfig = {
  baseFreq: "M",
  techniques: defaultAnalysisTechniques,
};

const formatValue = (value: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);

const wrapRefLineLabel = (text: string, maxWidthPx: number, fontSize = 10): string[] => {
  if (!text.trim()) return [];
  const approxCharWidth = fontSize * 1.0;
  const maxChars = Math.max(1, Math.floor(maxWidthPx / approxCharWidth));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const combined = current ? `${current} ${word}` : word;
    if (combined.length <= maxChars) {
      current = combined;
    } else {
      if (current) lines.push(current);
      if (word.length > maxChars) {
        for (let i = 0; i < word.length; i += maxChars) {
          lines.push(word.slice(i, i + maxChars));
        }
        current = "";
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
};

const freqOrder: Freq[] = ["D", "M", "Q", "Y"];
const freqLabelMap: Record<Freq, string> = {
  D: "일",
  M: "월",
  Q: "분기",
  Y: "년",
};

const toFreq = (value: string): Freq | null => {
  const upper = value.toUpperCase();
  if (upper === "D" || upper === "M" || upper === "Q" || upper === "Y") return upper;
  return null;
};

const normalizeRefLineDate = (dateStr: string, freq: Freq | null): string => {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const [, y, mo, d] = m;
  const year = parseInt(y!, 10);
  const month = parseInt(mo!, 10);
  if (freq === "D") return dateStr;
  if (freq === "M") return `${y}-${mo}-01`;
  if (freq === "Q") {
    const qMonth = [1, 4, 7, 10][Math.min(3, Math.floor((month - 1) / 3))];
    return `${y}-${String(qMonth).padStart(2, "0")}-01`;
  }
  if (freq === "Y") return `${y}-01-01`;
  return dateStr;
};

const makeReferenceLineDraft = (
  lineType: "horizontal" | "vertical" = "horizontal",
): ReferenceLineDraft => ({
  id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  lineType,
  lineLabel: "",
  lineValue: "",
  lineDate: "",
  lineColor: referenceLineColorPalette[0],
  lineWidth: 1.5,
  lineDash: "6 4",
});

const buildPolyline = (values: number[], min: number, max: number) => {
  const drawableWidth = chartWidth - padding.left - padding.right;
  const drawableHeight = chartHeight - padding.top - padding.bottom;
  const safeRange = max - min || 1;
  return values
    .map((value, index) => {
      const x = padding.left + (drawableWidth * index) / Math.max(values.length - 1, 1);
      const y = padding.top + ((max - value) / safeRange) * drawableHeight;
      return `${x},${y}`;
    })
    .join(" ");
};

const getCommonObsDates = (
  seriesRows: Array<{ points: Array<{ obsDate: string; obsValue: number }> }>,
) => {
  if (!seriesRows.length) return [] as string[];
  const dateSets = seriesRows.map((series) => new Set(series.points.map((point) => point.obsDate)));
  const [first, ...rest] = dateSets;
  const common = Array.from(first).filter((date) => rest.every((set) => set.has(date)));
  return common.sort();
};

const normalizeYAxisSide = (value: unknown): YAxisSide => (value === "right" ? "right" : "left");

const calcValueRange = (rows: Array<{ values: number[] }>) => {
  const all = rows.flatMap((item) => item.values.filter((v) => Number.isFinite(v)));
  if (!all.length) return { min: 0, max: 1 };
  const min = Math.min(...all);
  const max = Math.max(...all);
  return { min: Number((min * 0.98).toFixed(2)), max: Number((max * 1.02).toFixed(2)) };
};

const calcPearson = (x: number[], y: number[]) => {
  const pairs = x
    .map((vx, i) => [vx, y[i] ?? NaN] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = pairs.length;
  if (n < 2) return 0;
  const xs = pairs.map(([a]) => a);
  const ys = pairs.map(([, b]) => b);
  const meanX = xs.reduce((acc, v) => acc + v, 0) / n;
  const meanY = ys.reduce((acc, v) => acc + v, 0) / n;
  const cov = pairs.reduce((acc, [a, b]) => acc + (a - meanX) * (b - meanY), 0);
  const varX = xs.reduce((acc, v) => acc + (v - meanX) ** 2, 0);
  const varY = ys.reduce((acc, v) => acc + (v - meanY) ** 2, 0);
  if (varX <= 0 || varY <= 0) return 0;
  return cov / Math.sqrt(varX * varY);
};

export default function VisualizationPage() {
  const [activeTopic, setActiveTopic] = useState<TopicKey>("trendChart");
  const [ingestionLoading, setIngestionLoading] = useState(false);
  const [ingestionError, setIngestionError] = useState("");
  const [ingestionSummary, setIngestionSummary] = useState<IngestionStatusSummary | null>(null);
  const [ingestionDailyRows, setIngestionDailyRows] = useState<IngestionStatusDaily[]>([]);
  const [ingestionSourceRows, setIngestionSourceRows] = useState<IngestionStatusBySource[]>([]);
  const [ingestionFailureRows, setIngestionFailureRows] = useState<IngestionStatusFailure[]>([]);
  const [analysisCharts, setAnalysisCharts] = useState<ChartListItem[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisSelectedChartId, setAnalysisSelectedChartId] = useState<number | null>(null);
  const [analysisTitle, setAnalysisTitle] = useState("");
  const [analysisSeries, setAnalysisSeries] = useState<ChartDetailSeries[]>([]);
  const [analysisLayout, setAnalysisLayout] = useState<AnalysisWidgetLayout[]>([]);
  const [analysisConfig, setAnalysisConfig] = useState<AnalysisConfig>(defaultAnalysisConfig);
  const [analysisActionError, setAnalysisActionError] = useState("");
  const [analysisActionBusyId, setAnalysisActionBusyId] = useState<number | null>(null);
  const [analysisSaveError, setAnalysisSaveError] = useState("");
  const [analysisSaveStatus, setAnalysisSaveStatus] = useState("");
  const [analysisSaving, setAnalysisSaving] = useState(false);
  const [showAnalysisCreate, setShowAnalysisCreate] = useState(false);
  const [showAnalysisEdit, setShowAnalysisEdit] = useState(false);
  const [analysisEditChartId, setAnalysisEditChartId] = useState<number | null>(null);
  const [analysisEditName, setAnalysisEditName] = useState("");
  const [analysisEditSeriesQuery, setAnalysisEditSeriesQuery] = useState("");
  const [analysisEditFreqTab, setAnalysisEditFreqTab] = useState<Freq>("M");
  const [analysisEditSeriesIds, setAnalysisEditSeriesIds] = useState<string[]>([]);
  const [analysisEditTechniques, setAnalysisEditTechniques] =
    useState<AnalysisTechnique[]>(defaultAnalysisTechniques);
  const [analysisEditError, setAnalysisEditError] = useState("");
  const [analysisEditBusy, setAnalysisEditBusy] = useState(false);
  const [analysisCreateBusy, setAnalysisCreateBusy] = useState(false);
  const [analysisCreateError, setAnalysisCreateError] = useState("");
  const [analysisSeriesPool, setAnalysisSeriesPool] = useState<SeriesListItem[]>([]);
  const [analysisSeriesPoolLoading, setAnalysisSeriesPoolLoading] = useState(false);
  const [analysisCreateName, setAnalysisCreateName] = useState("");
  const [analysisCreateSeriesQuery, setAnalysisCreateSeriesQuery] = useState("");
  const [analysisCreateFreqTab, setAnalysisCreateFreqTab] = useState<Freq>("M");
  const [analysisCreateTechniques, setAnalysisCreateTechniques] =
    useState<AnalysisTechnique[]>(defaultAnalysisTechniques);
  const [analysisCreateSeriesIds, setAnalysisCreateSeriesIds] = useState<string[]>([]);
  const [charts, setCharts] = useState<ChartListItem[]>([]);
  const [chartsLoading, setChartsLoading] = useState(false);
  const [chartsError, setChartsError] = useState("");
  const [selectedChartId, setSelectedChartId] = useState<number | null>(null);
  const [chartActionError, setChartActionError] = useState("");
  const [chartActionBusyId, setChartActionBusyId] = useState<number | null>(null);

  const [detailSeries, setDetailSeries] = useState<ChartDetailSeries[]>([]);
  const [detailReferenceLineDrafts, setDetailReferenceLineDrafts] = useState<ReferenceLineDraft[]>([]);
  const [detailReferenceLineError, setDetailReferenceLineError] = useState("");
  const [detailReferenceLineSaving, setDetailReferenceLineSaving] = useState(false);
  const [detailReferenceLinePlacing, setDetailReferenceLinePlacing] = useState<"horizontal" | "vertical" | null>(null);
  const [detailReferenceLineDraggingId, setDetailReferenceLineDraggingId] = useState<string | null>(null);
  const [detailReferenceLineHoveredId, setDetailReferenceLineHoveredId] = useState<string | null>(null);
  const [detailReferenceLineMenu, setDetailReferenceLineMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [detailReferenceLineDashDropdownOpen, setDetailReferenceLineDashDropdownOpen] = useState(false);
  const [detailReferenceLineGuide, setDetailReferenceLineGuide] = useState<{
    x: number;
    y: number;
    label: string;
    value: number;
  } | null>(null);
  const [detailTitle, setDetailTitle] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [seriesList, setSeriesList] = useState<SeriesListItem[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [createSeriesQuery, setCreateSeriesQuery] = useState("");
  const [createFreqTab, setCreateFreqTab] = useState<Freq>("M");
  const [selectedSeriesIds, setSelectedSeriesIds] = useState<string[]>([]);
  const [createSeriesAxisMap, setCreateSeriesAxisMap] = useState<Record<string, YAxisSide>>({});
  const [previewSeries, setPreviewSeries] = useState<ChartDetailSeries[]>([]);
  const [createError, setCreateError] = useState("");
  const [createStatus, setCreateStatus] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  const [editChartId, setEditChartId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editSeriesQuery, setEditSeriesQuery] = useState("");
  const [editFreqTab, setEditFreqTab] = useState<Freq>("M");
  const [editSeriesIds, setEditSeriesIds] = useState<string[]>([]);
  const [editSeriesAxisMap, setEditSeriesAxisMap] = useState<Record<string, YAxisSide>>({});
  const [editPreviewSeries, setEditPreviewSeries] = useState<ChartDetailSeries[]>([]);
  const [editError, setEditError] = useState("");
  const [showDerive, setShowDerive] = useState(false);
  const [deriveContext] = useState<
    "create" | "edit" | "analysisCreate" | "analysisEdit"
  >("create");
  const [deriveSourceSeriesId, setDeriveSourceSeriesId] = useState("");
  const [deriveTargetFreq, setDeriveTargetFreq] = useState<"M" | "Q" | "Y">("M");
  const [deriveAggRule, setDeriveAggRule] = useState<"sum" | "avg" | "last">("avg");
  const [deriveSeriesName, setDeriveSeriesName] = useState("");
  const [deriveError, setDeriveError] = useState("");
  const [deriveLoading, setDeriveLoading] = useState(false);
  const [deletingDerivedSeriesId, setDeletingDerivedSeriesId] = useState<string | null>(null);
  const [showDetailFullscreen, setShowDetailFullscreen] = useState(false);
  const [hiddenDetailSeriesIds, setHiddenDetailSeriesIds] = useState<string[]>([]);
  const [detailZoomRange, setDetailZoomRange] = useState<{ start: number; end: number } | null>(null);
  const [detailDragStartIndex, setDetailDragStartIndex] = useState<number | null>(null);
  const [detailDragCurrentIndex, setDetailDragCurrentIndex] = useState<number | null>(null);
  const [hoveredDetailIndex, setHoveredDetailIndex] = useState<number | null>(null);
  const detailSvgRef = useRef<SVGSVGElement | null>(null);
  const detailChartWrapRef = useRef<HTMLDivElement | null>(null);
  const detailReferenceLineMenuRef = useRef<HTMLDivElement | null>(null);
  const [detailSvgWidth, setDetailSvgWidth] = useState(chartWidth);
  const detailTooltipRef = useRef<HTMLDivElement | null>(null);
  const [detailTooltipWidth, setDetailTooltipWidth] = useState(0);

  const fetchCharts = useCallback(async () => {
    setChartsLoading(true);
    setChartsError("");
    try {
      const response = await fetch("/api/visualization/charts");
      const payload = (await response.json()) as {
        ok?: boolean;
        charts?: ChartListItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "그래프 목록을 불러오지 못했습니다.");
      }
      const nextCharts = payload.charts ?? [];
      setCharts(nextCharts);
      setSelectedChartId((prev) => {
        if (!nextCharts.length) return null;
        if (prev && nextCharts.some((item) => item.chartId === prev)) return prev;
        return nextCharts[0]?.chartId ?? null;
      });
    } catch (error) {
      setChartsError(error instanceof Error ? error.message : "그래프 목록을 불러오지 못했습니다.");
    } finally {
      setChartsLoading(false);
    }
  }, []);

  const fetchIngestionStatus = useCallback(async () => {
    setIngestionLoading(true);
    setIngestionError("");
    try {
      const response = await fetch("/api/visualization/ingestion-status");
      const payload = (await response.json()) as {
        ok?: boolean;
        summary?: IngestionStatusSummary;
        daily?: IngestionStatusDaily[];
        bySource?: IngestionStatusBySource[];
        recentFailures?: IngestionStatusFailure[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "수집 현황을 불러오지 못했습니다.");
      }
      setIngestionSummary(payload.summary ?? null);
      setIngestionDailyRows(payload.daily ?? []);
      setIngestionSourceRows(payload.bySource ?? []);
      setIngestionFailureRows(payload.recentFailures ?? []);
    } catch (error) {
      setIngestionError(error instanceof Error ? error.message : "수집 현황을 불러오지 못했습니다.");
    } finally {
      setIngestionLoading(false);
    }
  }, []);

  const fetchAnalysisCharts = useCallback(async () => {
    setAnalysisLoading(true);
    setAnalysisError("");
    try {
      const response = await fetch("/api/visualization/analysis");
      const payload = (await response.json()) as {
        ok?: boolean;
        charts?: ChartListItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "분석 목록을 불러오지 못했습니다.");
      }
      const nextCharts = payload.charts ?? [];
      setAnalysisCharts(nextCharts);
      setAnalysisSelectedChartId((prev) => {
        if (!nextCharts.length) return null;
        if (prev && nextCharts.some((item) => item.chartId === prev)) return prev;
        return nextCharts[0]?.chartId ?? null;
      });
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "분석 목록을 불러오지 못했습니다.");
    } finally {
      setAnalysisLoading(false);
    }
  }, []);

  const fetchAnalysisSeriesPool = useCallback(async () => {
    setAnalysisSeriesPoolLoading(true);
    try {
      const response = await fetch("/api/visualization/series");
      const payload = (await response.json()) as {
        ok?: boolean;
        series?: SeriesListItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "시리즈 목록을 불러오지 못했습니다.");
      }
      setAnalysisSeriesPool(payload.series ?? []);
    } catch (error) {
      setAnalysisCreateError(error instanceof Error ? error.message : "시리즈 목록을 불러오지 못했습니다.");
    } finally {
      setAnalysisSeriesPoolLoading(false);
    }
  }, []);

  const fetchAnalysisDetail = useCallback(async (chartId: number) => {
    setAnalysisError("");
    try {
      const response = await fetch(`/api/visualization/analysis/${chartId}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        chart?: { chartName: string; analysisLayout?: unknown; analysisConfig?: unknown };
        series?: ChartDetailSeries[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "분석 상세를 불러오지 못했습니다.");
      }
      setAnalysisTitle(payload.chart?.chartName ?? "");
      setAnalysisSeries(payload.series ?? []);
      const rawConfig = payload.chart?.analysisConfig as Partial<AnalysisConfig> | undefined;
      const nextTechniques =
        Array.isArray(rawConfig?.techniques) && rawConfig?.techniques.length
          ? rawConfig.techniques.filter((item): item is AnalysisTechnique => isAnalysisTechnique(item))
          : defaultAnalysisTechniques;
      const nextFreq = rawConfig?.baseFreq ? toFreq(rawConfig.baseFreq) : null;
      setAnalysisConfig({
        baseFreq: nextFreq,
        techniques: nextTechniques.length ? nextTechniques : defaultAnalysisTechniques,
      });
      const rawLayout = payload.chart?.analysisLayout;
      if (Array.isArray(rawLayout) && rawLayout.length > 0) {
        setAnalysisLayout(rawLayout as AnalysisWidgetLayout[]);
      } else {
        setAnalysisLayout(buildAnalysisLayout(nextTechniques));
      }
      setAnalysisSaveError("");
      setAnalysisSaveStatus("");
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "분석 상세를 불러오지 못했습니다.");
      setAnalysisSeries([]);
      setAnalysisLayout(buildAnalysisLayout(defaultAnalysisTechniques));
      setAnalysisConfig(defaultAnalysisConfig);
    }
  }, []);

  const handleCreateAnalysis = useCallback(async () => {
    if (!analysisCreateName.trim()) {
      setAnalysisCreateError("분석 이름을 입력하세요.");
      return;
    }
    if (!analysisCreateSeriesIds.length) {
      setAnalysisCreateError("시리즈를 1개 이상 선택하세요.");
      return;
    }
    const invalidFreqSeries = analysisSeriesPool.filter(
      (series) =>
        analysisCreateSeriesIds.includes(series.seriesId) &&
        toFreq(series.freq) !== analysisCreateFreqTab,
    );
    if (invalidFreqSeries.length) {
      setAnalysisCreateError("선택 시리즈의 주기가 서로 다릅니다. 같은 주기로만 선택하세요.");
      return;
    }
    if (!analysisCreateTechniques.length) {
      setAnalysisCreateError("분석 기법을 1개 이상 선택하세요.");
      return;
    }
    setAnalysisCreateBusy(true);
    setAnalysisCreateError("");
    try {
      const nextLayout = buildAnalysisLayout(analysisCreateTechniques);
      const response = await fetch("/api/visualization/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chartName: analysisCreateName.trim(),
          seriesIds: analysisCreateSeriesIds,
          analysisLayout: nextLayout,
          analysisConfig: {
            baseFreq: analysisCreateFreqTab,
            techniques: analysisCreateTechniques,
          },
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; chartId?: number; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "분석 생성에 실패했습니다.");
      }
      await fetchAnalysisCharts();
      if (payload.chartId) setAnalysisSelectedChartId(payload.chartId);
      setAnalysisCreateName("");
      setAnalysisCreateSeriesIds([]);
      setAnalysisCreateSeriesQuery("");
      setAnalysisCreateTechniques(defaultAnalysisTechniques);
      setShowAnalysisCreate(false);
    } catch (error) {
      setAnalysisCreateError(error instanceof Error ? error.message : "분석 생성에 실패했습니다.");
    } finally {
      setAnalysisCreateBusy(false);
    }
  }, [
    analysisCreateFreqTab,
    analysisCreateName,
    analysisCreateSeriesIds,
    analysisCreateTechniques,
    analysisSeriesPool,
    fetchAnalysisCharts,
  ]);

  const closeAnalysisCreateModal = useCallback(() => {
    setShowAnalysisCreate(false);
    setAnalysisCreateError("");
    setAnalysisCreateName("");
    setAnalysisCreateSeriesIds([]);
    setAnalysisCreateSeriesQuery("");
    setAnalysisCreateFreqTab("M");
    setAnalysisCreateTechniques(defaultAnalysisTechniques);
  }, []);

  const closeAnalysisEditModal = useCallback(() => {
    setShowAnalysisEdit(false);
    setAnalysisEditChartId(null);
    setAnalysisEditName("");
    setAnalysisEditSeriesQuery("");
    setAnalysisEditFreqTab("M");
    setAnalysisEditSeriesIds([]);
    setAnalysisEditTechniques(defaultAnalysisTechniques);
    setAnalysisEditError("");
    setAnalysisEditBusy(false);
  }, []);

  const handleEditAnalysis = useCallback(
    async (chartId: number) => {
      setAnalysisActionError("");
      setAnalysisEditError("");
      setAnalysisActionBusyId(chartId);
      try {
        const response = await fetch(`/api/visualization/analysis/${chartId}`);
        const payload = (await response.json()) as {
          ok?: boolean;
          chart?: { chartName: string; analysisConfig?: unknown };
          series?: ChartDetailSeries[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "분석 정보를 불러오지 못했습니다.");
        }
        const nextIds = (payload.series ?? []).map((item) => item.seriesId);
        const baseFreq = toFreq((payload.series ?? [])[0]?.freq ?? "") ?? "M";
        const rawConfig = payload.chart?.analysisConfig as Partial<AnalysisConfig> | undefined;
        const nextTechniques =
          Array.isArray(rawConfig?.techniques) && rawConfig.techniques.length
            ? rawConfig.techniques.filter((item): item is AnalysisTechnique => isAnalysisTechnique(item))
            : defaultAnalysisTechniques;
        setAnalysisEditChartId(chartId);
        setAnalysisEditName(payload.chart?.chartName ?? "");
        setAnalysisEditSeriesQuery("");
        setAnalysisEditSeriesIds(nextIds);
        setAnalysisEditFreqTab(baseFreq);
        setAnalysisEditTechniques(nextTechniques);
        setShowAnalysisEdit(true);
      } catch (error) {
        setAnalysisActionError(error instanceof Error ? error.message : "분석 정보를 불러오지 못했습니다.");
      } finally {
        setAnalysisActionBusyId(null);
      }
    },
    [],
  );

  const handleUpdateAnalysis = useCallback(async () => {
    if (!analysisEditChartId) return;
    const nextName = analysisEditName.trim();
    if (!nextName) {
      setAnalysisEditError("분석 이름을 입력하세요.");
      return;
    }
    if (!analysisEditSeriesIds.length) {
      setAnalysisEditError("시리즈를 1개 이상 선택하세요.");
      return;
    }
    if (!analysisEditTechniques.length) {
      setAnalysisEditError("분석기법을 1개 이상 선택하세요.");
      return;
    }
    setAnalysisEditError("");
    setAnalysisEditBusy(true);
    try {
      const response = await fetch(`/api/visualization/analysis/${analysisEditChartId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chartName: nextName,
          seriesIds: analysisEditSeriesIds,
          analysisConfig: {
            baseFreq: analysisEditFreqTab,
            techniques: analysisEditTechniques,
          },
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "분석 수정에 실패했습니다.");
      }
      await fetchAnalysisCharts();
      setAnalysisSelectedChartId(analysisEditChartId);
      await fetchAnalysisDetail(analysisEditChartId);
      setAnalysisConfig((prev) => ({
        ...prev,
        baseFreq: analysisEditFreqTab,
        techniques: analysisEditTechniques,
      }));
      closeAnalysisEditModal();
    } catch (error) {
      setAnalysisEditError(error instanceof Error ? error.message : "분석 수정에 실패했습니다.");
    } finally {
      setAnalysisEditBusy(false);
    }
  }, [
    analysisEditChartId,
    analysisEditName,
    analysisEditSeriesIds,
    analysisEditFreqTab,
    analysisEditTechniques,
    closeAnalysisEditModal,
    fetchAnalysisDetail,
    fetchAnalysisCharts,
  ]);

  const handleDeleteAnalysis = useCallback(
    async (chart: ChartListItem) => {
      const ok = window.confirm(`'${chart.chartName}' 분석을 삭제할까요?`);
      if (!ok) return;
      setAnalysisActionError("");
      setAnalysisActionBusyId(chart.chartId);
      try {
        const response = await fetch(`/api/visualization/analysis/${chart.chartId}`, {
          method: "DELETE",
        });
        const payload = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "분석 삭제에 실패했습니다.");
        }
        await fetchAnalysisCharts();
      } catch (error) {
        setAnalysisActionError(error instanceof Error ? error.message : "분석 삭제에 실패했습니다.");
      } finally {
        setAnalysisActionBusyId(null);
      }
    },
    [fetchAnalysisCharts],
  );

  const handleSaveAnalysis = useCallback(async () => {
    if (!analysisSelectedChartId) return;
    if (!analysisTitle.trim()) {
      setAnalysisSaveError("분석 이름을 입력하세요.");
      return;
    }
    setAnalysisSaving(true);
    setAnalysisSaveError("");
    setAnalysisSaveStatus("");
    try {
      const response = await fetch(`/api/visualization/analysis/${analysisSelectedChartId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chartName: analysisTitle.trim(),
          analysisLayout,
          analysisConfig,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "분석 저장에 실패했습니다.");
      }
      setAnalysisSaveStatus("저장되었습니다.");
      await fetchAnalysisCharts();
    } catch (error) {
      setAnalysisSaveError(error instanceof Error ? error.message : "분석 저장에 실패했습니다.");
    } finally {
      setAnalysisSaving(false);
    }
  }, [analysisConfig, analysisLayout, analysisSelectedChartId, analysisTitle, fetchAnalysisCharts]);

  const fetchChartDetail = useCallback(async (chartId: number) => {
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await fetch(`/api/visualization/charts/${chartId}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        chart?: { chartName: string };
        series?: ChartDetailSeries[];
        referenceLines?: ChartReferenceLine[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "그래프 상세를 불러오지 못했습니다.");
      }
      setDetailTitle(payload.chart?.chartName ?? "");
      setDetailSeries(payload.series ?? []);
      const nextReferenceLines = payload.referenceLines ?? [];
      setDetailReferenceLineDrafts(
        nextReferenceLines.map((line) => ({
          id: `detail-line-${line.refLineId ?? `${line.displayOrder}-${line.lineType}`}`,
          lineType: line.lineType,
          lineLabel: line.lineLabel ?? "",
          lineValue: line.lineValue === null ? "" : String(line.lineValue),
          lineDate: line.lineDate ?? "",
          lineColor: line.lineColor ?? referenceLineColorPalette[0],
          lineWidth:
            Number.isFinite(line.lineWidth) && line.lineWidth > 0 ? Number(line.lineWidth) : 1.5,
          lineDash: line.lineDash || "6 4",
        })),
      );
      setDetailReferenceLineError("");
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "그래프 상세를 불러오지 못했습니다.");
      setDetailReferenceLineDrafts([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const fetchSeries = useCallback(async () => {
    setSeriesLoading(true);
    setCreateError("");
    try {
      const response = await fetch("/api/visualization/series");
      const payload = (await response.json()) as {
        ok?: boolean;
        series?: SeriesListItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "시리즈 목록을 불러오지 못했습니다.");
      }
      setSeriesList(payload.series ?? []);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "시리즈 목록을 불러오지 못했습니다.");
    } finally {
      setSeriesLoading(false);
    }
  }, []);

  const fetchPreview = useCallback(async (ids: string[]) => {
    if (!ids.length) {
      setPreviewSeries([]);
      return;
    }
    try {
      const response = await fetch(
        `/api/visualization/series?withPoints=true&ids=${encodeURIComponent(ids.join(","))}`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        series?: Array<
          SeriesListItem & { points: Array<{ obsDate: string; obsValue: number }> }
        >;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "미리보기를 불러오지 못했습니다.");
      }
      setPreviewSeries(
        (payload.series ?? []).map((item, index) => ({
          seriesId: item.seriesId,
          seriesName: item.seriesName,
          unitName: item.unitName,
          freq: item.freq,
          displayOrder: index,
          lineColor: colorPalette[index % colorPalette.length],
          yAxisSide: createSeriesAxisMap[item.seriesId] ?? "left",
          points: item.points,
        })),
      );
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "미리보기를 불러오지 못했습니다.");
    }
  }, [createSeriesAxisMap]);

  const fetchEditPreview = useCallback(async (ids: string[]) => {
    if (!ids.length) {
      setEditPreviewSeries([]);
      return;
    }
    try {
      const response = await fetch(
        `/api/visualization/series?withPoints=true&ids=${encodeURIComponent(ids.join(","))}`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        series?: Array<
          SeriesListItem & { points: Array<{ obsDate: string; obsValue: number }> }
        >;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "수정 미리보기를 불러오지 못했습니다.");
      }
      setEditPreviewSeries(
        (payload.series ?? []).map((item, index) => ({
          seriesId: item.seriesId,
          seriesName: item.seriesName,
          unitName: item.unitName,
          freq: item.freq,
          displayOrder: index,
          lineColor: colorPalette[index % colorPalette.length],
          yAxisSide: editSeriesAxisMap[item.seriesId] ?? "left",
          points: item.points,
        })),
      );
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "수정 미리보기를 불러오지 못했습니다.");
    }
  }, [editSeriesAxisMap]);

  useEffect(() => {
    if (activeTopic !== "ingestionStatus") return;
    void fetchIngestionStatus();
  }, [activeTopic, fetchIngestionStatus]);

  useEffect(() => {
    if (activeTopic !== "analysis") return;
    void fetchAnalysisCharts();
    void fetchAnalysisSeriesPool();
  }, [activeTopic, fetchAnalysisCharts, fetchAnalysisSeriesPool]);

  useEffect(() => {
    if (activeTopic !== "analysis" || !analysisSelectedChartId) return;
    void fetchAnalysisDetail(analysisSelectedChartId);
  }, [activeTopic, analysisSelectedChartId, fetchAnalysisDetail]);

  useEffect(() => {
    if (!analysisConfig.techniques.length) return;
    setAnalysisLayout((prev) => {
      const prevTypes = prev.map((item) => item.type).join(",");
      const nextTypes = analysisConfig.techniques.join(",");
      if (prevTypes === nextTypes && prev.length === analysisConfig.techniques.length) return prev;
      return buildAnalysisLayout(analysisConfig.techniques);
    });
  }, [analysisConfig.techniques]);

  useEffect(() => {
    if (activeTopic !== "trendChart") return;
    void fetchCharts();
  }, [activeTopic, fetchCharts]);

  useEffect(() => {
    if (!selectedChartId) return;
    void fetchChartDetail(selectedChartId);
  }, [selectedChartId, fetchChartDetail]);

  useEffect(() => {
    if (!selectedChartId || detailLoading || !!detailError) {
      setShowDetailFullscreen(false);
    }
  }, [detailError, detailLoading, selectedChartId]);

  useEffect(() => {
    setHiddenDetailSeriesIds([]);
    setDetailZoomRange(null);
    setDetailDragStartIndex(null);
    setDetailDragCurrentIndex(null);
    setHoveredDetailIndex(null);
    setDetailReferenceLineError("");
    setDetailReferenceLinePlacing(null);
    setDetailReferenceLineDraggingId(null);
    setDetailReferenceLineHoveredId(null);
    setDetailReferenceLineMenu(null);
    setDetailReferenceLineDashDropdownOpen(false);
    setDetailReferenceLineGuide(null);
  }, [selectedChartId, detailSeries]);

  useEffect(() => {
    if (!showCreate) return;
    void fetchSeries();
  }, [showCreate, fetchSeries]);

  useEffect(() => {
    if (!showCreate) return;
    void fetchPreview(selectedSeriesIds);
  }, [showCreate, selectedSeriesIds, createSeriesAxisMap, fetchPreview]);

  useEffect(() => {
    if (!showEdit) return;
    void fetchEditPreview(editSeriesIds);
  }, [editSeriesIds, editSeriesAxisMap, fetchEditPreview, showEdit]);

  const ingestionDailyMaxRuns = useMemo(() => {
    if (!ingestionDailyRows.length) return 1;
    return Math.max(...ingestionDailyRows.map((row) => row.totalRuns), 1);
  }, [ingestionDailyRows]);

  const detailLabels = useMemo(() => getCommonObsDates(detailSeries), [detailSeries]);

  const detailChartRowsAll = useMemo(
    () =>
      detailSeries.map((series) => {
        const map = new Map(series.points.map((point) => [point.obsDate, point.obsValue]));
        return {
          ...series,
          values: detailLabels.map((label) => map.get(label) ?? NaN),
        };
      }),
    [detailLabels, detailSeries],
  );

  const analysisCreateSeriesOptions = useMemo(() => {
    const query = analysisCreateSeriesQuery.trim().toLowerCase();
    return analysisSeriesPool
      .filter((series) => {
        const freq = toFreq(series.freq);
        if (freq !== analysisCreateFreqTab) return false;
        if (!query) return true;
        return (
          series.seriesName.toLowerCase().includes(query) ||
          series.sourceOrg.toLowerCase().includes(query) ||
          (series.sourceKey || "").toLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        const aDerived = a.sourceOrg === "derived" ? 0 : 1;
        const bDerived = b.sourceOrg === "derived" ? 0 : 1;
        if (aDerived !== bDerived) return aDerived - bDerived;
        return a.seriesName.localeCompare(b.seriesName, "ko");
      });
  }, [analysisCreateFreqTab, analysisCreateSeriesQuery, analysisSeriesPool]);

  const analysisCreateSelectedSeries = useMemo(
    () => analysisSeriesPool.filter((series) => analysisCreateSeriesIds.includes(series.seriesId)),
    [analysisCreateSeriesIds, analysisSeriesPool],
  );

  const analysisEditSeriesOptions = useMemo(() => {
    const query = analysisEditSeriesQuery.trim().toLowerCase();
    return analysisSeriesPool
      .filter((series) => {
        const freq = toFreq(series.freq);
        if (freq !== analysisEditFreqTab) return false;
        if (!query) return true;
        return (
          series.seriesName.toLowerCase().includes(query) ||
          series.sourceOrg.toLowerCase().includes(query) ||
          (series.sourceKey || "").toLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        const aDerived = a.sourceOrg === "derived" ? 0 : 1;
        const bDerived = b.sourceOrg === "derived" ? 0 : 1;
        if (aDerived !== bDerived) return aDerived - bDerived;
        return a.seriesName.localeCompare(b.seriesName, "ko");
      });
  }, [analysisEditFreqTab, analysisEditSeriesQuery, analysisSeriesPool]);

  const analysisEditSelectedSeries = useMemo(
    () => analysisSeriesPool.filter((series) => analysisEditSeriesIds.includes(series.seriesId)),
    [analysisEditSeriesIds, analysisSeriesPool],
  );

  const selectedAnalysisEditFreq = useMemo(() => {
    const firstId = analysisEditSeriesIds[0];
    if (!firstId) return null;
    const matched = analysisSeriesPool.find((series) => series.seriesId === firstId);
    return matched ? toFreq(matched.freq) : null;
  }, [analysisEditSeriesIds, analysisSeriesPool]);

  const analysisLabels = useMemo(() => {
    const labelSet = new Set<string>();
    analysisSeries.forEach((series) => {
      series.points.forEach((point) => labelSet.add(point.obsDate));
    });
    return Array.from(labelSet).sort();
  }, [analysisSeries]);

  const analysisSeriesForCalc = useMemo(() => {
    return analysisSeries;
  }, [analysisSeries]);

  const analysisRowsAll = useMemo(
    () =>
      analysisSeriesForCalc.map((series) => {
        const map = new Map(series.points.map((point) => [point.obsDate, point.obsValue]));
        return {
          ...series,
          values: analysisLabels.map((label) => map.get(label) ?? NaN),
        };
      }),
    [analysisLabels, analysisSeriesForCalc],
  );

  const analysisRows = useMemo(() => analysisRowsAll.slice(0, 4), [analysisRowsAll]);

  const analysisTechniques = useMemo(() => {
    const fromConfig = analysisConfig.techniques.filter((item) => isAnalysisTechnique(item));
    if (fromConfig.length) return fromConfig;
    const fromLayout = analysisLayout
      .map((item) => item.type)
      .filter((item): item is AnalysisTechnique => isAnalysisTechnique(item));
    return fromLayout.length ? fromLayout : defaultAnalysisTechniques;
  }, [analysisConfig.techniques, analysisLayout]);

  const analysisFreqMismatch = useMemo(() => {
    if (!analysisConfig.baseFreq) return false;
    return analysisSeries.some((series) => toFreq(series.freq) !== analysisConfig.baseFreq);
  }, [analysisConfig.baseFreq, analysisSeries]);

  const analysisCorrelation = useMemo(
    () =>
      analysisRows.map((rowA) =>
        analysisRows.map((rowB) => calcPearson(rowA.values, rowB.values)),
      ),
    [analysisRows],
  );

  const analysisDistribution = useMemo(() => {
    const values =
      analysisRows[0]?.values.filter((v) => Number.isFinite(v))?.map((v) => Number(v)) ?? [];
    if (values.length === 0) return { bins: [] as Array<{ x0: number; x1: number; count: number }>, mean: 0, std: 0 };
    const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const binCount = 10;
    const step = (max - min || 1) / binCount;
    const bins = Array.from({ length: binCount }, (_, i) => ({
      x0: min + i * step,
      x1: min + (i + 1) * step,
      count: 0,
    }));
    values.forEach((v) => {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - min) / (step || 1))));
      bins[idx].count += 1;
    });
    return { bins, mean, std };
  }, [analysisRows]);

  const analysisRegression = useMemo(() => {
    const x = analysisRows[0]?.values ?? [];
    const y = analysisRows[1]?.values ?? [];
    const pairs = x
      .map((vx, i) => [vx, y[i] ?? NaN] as const)
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (pairs.length < 2) return null;
    const n = pairs.length;
    const meanX = pairs.reduce((acc, [a]) => acc + a, 0) / n;
    const meanY = pairs.reduce((acc, [, b]) => acc + b, 0) / n;
    const sxx = pairs.reduce((acc, [a]) => acc + (a - meanX) ** 2, 0);
    const sxy = pairs.reduce((acc, [a, b]) => acc + (a - meanX) * (b - meanY), 0);
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = meanY - slope * meanX;
    const ssTot = pairs.reduce((acc, [, b]) => acc + (b - meanY) ** 2, 0);
    const ssRes = pairs.reduce((acc, [a, b]) => acc + (b - (intercept + slope * a)) ** 2, 0);
    const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
    return { slope, intercept, r2, n };
  }, [analysisRows]);

  const analysisTrend = useMemo(() => {
    const values = analysisRows[0]?.values.filter((v) => Number.isFinite(v)).map((v) => Number(v)) ?? [];
    if (values.length < 2) return null;
    const n = values.length;
    const xs = values.map((_, index) => index + 1);
    const meanX = xs.reduce((acc, value) => acc + value, 0) / n;
    const meanY = values.reduce((acc, value) => acc + value, 0) / n;
    const sxx = xs.reduce((acc, value) => acc + (value - meanX) ** 2, 0);
    const sxy = xs.reduce((acc, value, index) => acc + (value - meanX) * (values[index] - meanY), 0);
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const first = values[0];
    const last = values[values.length - 1];
    const growthRate = Number.isFinite(first) && first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
    return { slope, growthRate, first, last, n };
  }, [analysisRows]);

  const analysisVolatility = useMemo(() => {
    const values = analysisRows[0]?.values.filter((v) => Number.isFinite(v)).map((v) => Number(v)) ?? [];
    if (values.length < 2) return null;
    const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
    const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    const cv = mean === 0 ? null : (std / Math.abs(mean)) * 100;
    return { mean, std, cv, min: Math.min(...values), max: Math.max(...values), n: values.length };
  }, [analysisRows]);

  const analysisAnomaly = useMemo(() => {
    const row = analysisRows[0];
    if (!row) return null;
    const pairs = analysisLabels
      .map((label, index) => ({ label, value: row.values[index] ?? NaN }))
      .filter((item) => Number.isFinite(item.value))
      .map((item) => ({ label: item.label, value: Number(item.value) }));
    if (pairs.length < 3) return null;
    const mean = pairs.reduce((acc, item) => acc + item.value, 0) / pairs.length;
    const variance = pairs.reduce((acc, item) => acc + (item.value - mean) ** 2, 0) / pairs.length;
    const std = Math.sqrt(variance);
    if (std === 0) return { total: pairs.length, anomalyCount: 0, top: [] as Array<{ label: string; z: number }> };
    const anomalies = pairs
      .map((item) => ({ label: item.label, z: (item.value - mean) / std }))
      .filter((item) => Math.abs(item.z) >= 2)
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    return { total: pairs.length, anomalyCount: anomalies.length, top: anomalies.slice(0, 3) };
  }, [analysisLabels, analysisRows]);

  const analysisSeasonality = useMemo(() => {
    const row = analysisRows[0];
    if (!row) return null;
    const monthBuckets = new Map<number, number[]>();
    analysisLabels.forEach((label, index) => {
      const value = row.values[index] ?? NaN;
      if (!Number.isFinite(value)) return;
      const month = Number(label.slice(5, 7));
      if (!Number.isFinite(month) || month < 1 || month > 12) return;
      if (!monthBuckets.has(month)) monthBuckets.set(month, []);
      monthBuckets.get(month)?.push(Number(value));
    });
    if (!monthBuckets.size) return null;
    const monthly = Array.from(monthBuckets.entries())
      .map(([month, values]) => ({
        month,
        avg: values.reduce((acc, value) => acc + value, 0) / values.length,
      }))
      .sort((a, b) => a.month - b.month);
    const peak = monthly.reduce((acc, item) => (item.avg > acc.avg ? item : acc), monthly[0]);
    const trough = monthly.reduce((acc, item) => (item.avg < acc.avg ? item : acc), monthly[0]);
    return { monthly, peak, trough };
  }, [analysisLabels, analysisRows]);

  const analysisForecast = useMemo(() => {
    const values = analysisRows[0]?.values.filter((v) => Number.isFinite(v)).map((v) => Number(v)) ?? [];
    if (values.length < 3) return null;
    const recent = values.slice(-3);
    const next = recent.reduce((acc, value) => acc + value, 0) / recent.length;
    const recentMean = next;
    const recentStd = Math.sqrt(
      recent.reduce((acc, value) => acc + (value - recentMean) ** 2, 0) / recent.length,
    );
    return { next, recentStd, recentCount: recent.length };
  }, [analysisRows]);

  const detailColorMap = useMemo(() => {
    const entries: Array<[string, string]> = detailSeries.map((series, index) => [
      series.seriesId,
      series.lineColor || colorPalette[index % colorPalette.length],
    ]);
    return new Map<string, string>(entries);
  }, [detailSeries]);

  const detailViewRange = useMemo(() => {
    if (!detailLabels.length) return { start: 0, end: -1 };
    if (!detailZoomRange) return { start: 0, end: detailLabels.length - 1 };
    const start = Math.max(0, Math.min(detailZoomRange.start, detailLabels.length - 1));
    const end = Math.max(start, Math.min(detailZoomRange.end, detailLabels.length - 1));
    return { start, end };
  }, [detailLabels.length, detailZoomRange]);

  const detailLabelsInView = useMemo(
    () => detailLabels.slice(detailViewRange.start, detailViewRange.end + 1),
    [detailLabels, detailViewRange.end, detailViewRange.start],
  );

  const detailFreq = useMemo(
    () => toFreq(detailSeries[0]?.freq ?? "") ?? "D",
    [detailSeries],
  );

  const detailChartRows = useMemo(
    () =>
      detailChartRowsAll
        .filter((series) => !hiddenDetailSeriesIds.includes(series.seriesId))
        .map((series) => ({
          ...series,
          values: series.values.slice(detailViewRange.start, detailViewRange.end + 1),
        })),
    [detailChartRowsAll, detailViewRange.end, detailViewRange.start, hiddenDetailSeriesIds],
  );

  const detailRange = useMemo(() => {
    return calcValueRange(detailChartRows);
  }, [detailChartRows]);

  const detailLeftRows = useMemo(
    () => detailChartRows.filter((series) => normalizeYAxisSide(series.yAxisSide) === "left"),
    [detailChartRows],
  );

  const detailRightRows = useMemo(
    () => detailChartRows.filter((series) => normalizeYAxisSide(series.yAxisSide) === "right"),
    [detailChartRows],
  );

  const detailLeftRange = useMemo(
    () => (detailLeftRows.length ? calcValueRange(detailLeftRows) : detailRange),
    [detailLeftRows, detailRange],
  );

  const detailRightRange = useMemo(
    () => (detailRightRows.length ? calcValueRange(detailRightRows) : detailLeftRange),
    [detailLeftRange, detailRightRows],
  );

  const detailYTicks = useMemo(() => {
    const axisRange = detailLeftRange;
    const tickValues = Array.from({ length: yTickCount }, (_, index) => {
      if (yTickCount <= 1) return axisRange.min;
      const ratio = index / (yTickCount - 1);
      return axisRange.max - (axisRange.max - axisRange.min) * ratio;
    });
    return tickValues.map((value) => {
      const drawableHeight = chartHeight - padding.top - padding.bottom;
      const safeRange = axisRange.max - axisRange.min || 1;
      const y = padding.top + ((axisRange.max - value) / safeRange) * drawableHeight;
      return { value, y };
    });
  }, [detailLeftRange]);

  const detailRightYTicks = useMemo(() => {
    if (!detailRightRows.length) return [];
    const axisRange = detailRightRange;
    const tickValues = Array.from({ length: yTickCount }, (_, index) => {
      if (yTickCount <= 1) return axisRange.min;
      const ratio = index / (yTickCount - 1);
      return axisRange.max - (axisRange.max - axisRange.min) * ratio;
    });
    return tickValues.map((value) => {
      const drawableHeight = chartHeight - padding.top - padding.bottom;
      const safeRange = axisRange.max - axisRange.min || 1;
      const y = padding.top + ((axisRange.max - value) / safeRange) * drawableHeight;
      return { value, y };
    });
  }, [detailRightRange, detailRightRows.length]);

  const detailReferenceLineRows = useMemo(() => {
    const drawableWidth = chartWidth - padding.left - padding.right;
    const drawableHeight = chartHeight - padding.top - padding.bottom;
    const safeRange = detailRange.max - detailRange.min || 1;
    return detailReferenceLineDrafts
      .map((line) => {
        if (line.lineType === "horizontal") {
          const rawValue = Number(line.lineValue.trim());
          if (!Number.isFinite(rawValue)) return null;
          const y = padding.top + ((detailRange.max - rawValue) / safeRange) * drawableHeight;
          if (y < padding.top || y > chartHeight - padding.bottom) return null;
          return {
            id: line.id,
            lineType: line.lineType,
            lineColor: line.lineColor.trim() || null,
            lineWidth: Number.isFinite(line.lineWidth) ? line.lineWidth : 1.5,
            lineDash: line.lineDash || "6 4",
            lineLabel: line.lineLabel.trim() || null,
            axisText: formatValue(rawValue),
            deleteX: chartWidth - padding.right - 8,
            deleteY: Math.max(padding.top + 8, Math.min(chartHeight - padding.bottom - 8, y)),
            x1: padding.left,
            y1: y,
            x2: chartWidth - padding.right,
            y2: y,
          };
        }
        const date = line.lineDate.trim();
        if (!date) return null;
        const normalizedDate = normalizeRefLineDate(date, detailFreq);
        const index = detailLabelsInView.indexOf(normalizedDate);
        if (index < 0) return null;
        const x = padding.left + (drawableWidth * index) / Math.max(detailLabelsInView.length - 1, 1);
        return {
          id: line.id,
          lineType: line.lineType,
          lineColor: line.lineColor.trim() || null,
          lineWidth: Number.isFinite(line.lineWidth) ? line.lineWidth : 1.5,
          lineDash: line.lineDash || "6 4",
          lineLabel: line.lineLabel.trim() || null,
          axisText: date,
          deleteX: x,
          deleteY: padding.top + 10,
          x1: x,
          y1: padding.top,
          x2: x,
          y2: chartHeight - padding.bottom,
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);
  }, [detailLabelsInView, detailFreq, detailRange.max, detailRange.min, detailReferenceLineDrafts]);

  const detailHoverX = useMemo(() => {
    if (
      hoveredDetailIndex === null ||
      hoveredDetailIndex < 0 ||
      hoveredDetailIndex >= detailLabelsInView.length
    ) {
      return null;
    }
    const drawableWidth = chartWidth - padding.left - padding.right;
    return padding.left + (drawableWidth * hoveredDetailIndex) / Math.max(detailLabelsInView.length - 1, 1);
  }, [detailLabelsInView.length, hoveredDetailIndex]);

  const detailHoverRows = useMemo(() => {
    if (hoveredDetailIndex === null) return [];
    return detailChartRows
      .map((series) => {
        const value = series.values[hoveredDetailIndex];
        return {
          seriesId: series.seriesId,
          seriesName: series.seriesName,
          color: detailColorMap.get(series.seriesId) || colorPalette[0],
          value,
        };
      })
      .filter((row) => Number.isFinite(row.value));
  }, [detailChartRows, detailColorMap, hoveredDetailIndex]);

  const getDetailIndexFromMouseEvent = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      if (!detailLabelsInView.length) return null;
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const xInViewBox = ((event.clientX - rect.left) / rect.width) * chartWidth;
      const drawableWidth = chartWidth - padding.left - padding.right;
      const rawIndex =
        ((xInViewBox - padding.left) / Math.max(drawableWidth, 1)) *
        Math.max(detailLabelsInView.length - 1, 1);
      const clamped = Math.max(0, Math.min(detailLabelsInView.length - 1, Math.round(rawIndex)));
      return clamped;
    },
    [detailLabelsInView.length],
  );

  const getDetailGuideFromMouseEvent = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      if (!detailLabelsInView.length) return null;
      const index = getDetailIndexFromMouseEvent(event);
      if (index === null) return null;
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const drawableWidth = chartWidth - padding.left - padding.right;
      const x = padding.left + (drawableWidth * index) / Math.max(detailLabelsInView.length - 1, 1);
      const yInViewBox = ((event.clientY - rect.top) / rect.height) * chartHeight;
      const clampedY = Math.max(padding.top, Math.min(chartHeight - padding.bottom, yInViewBox));
      const safeRange = detailRange.max - detailRange.min || 1;
      const ratio = (clampedY - padding.top) / (chartHeight - padding.top - padding.bottom);
      const value = detailRange.max - ratio * safeRange;
      const label = detailLabelsInView[index] ?? "";
      return { x, y: clampedY, value, label, index };
    },
    [detailLabelsInView, detailRange.max, detailRange.min, getDetailIndexFromMouseEvent],
  );

  const handleDetailMouseDown = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      if (event.button !== 0) {
        if (event.button === 2 && detailReferenceLinePlacing) {
          setDetailReferenceLinePlacing(null);
          setDetailReferenceLineGuide(null);
        }
        return;
      }
      if (detailReferenceLinePlacing) {
        const guide = getDetailGuideFromMouseEvent(event);
        if (!guide) return;
        setDetailReferenceLineError("");
        const nextId = makeReferenceLineDraft(detailReferenceLinePlacing).id;
        setDetailReferenceLineDrafts((prev) => [
          ...prev,
          {
            id: nextId,
            lineType: detailReferenceLinePlacing,
            lineLabel: "",
            lineValue:
              detailReferenceLinePlacing === "horizontal" ? Number(guide.value.toFixed(2)).toString() : "",
            lineDate: detailReferenceLinePlacing === "vertical" ? guide.label : "",
              lineColor: referenceLineColorPalette[0],
              lineWidth: 1.5,
              lineDash: "6 4",
          },
        ]);
        setDetailReferenceLinePlacing(null);
        setDetailReferenceLineGuide(null);
        return;
      }
      const index = getDetailIndexFromMouseEvent(event);
      if (index === null) return;
      setDetailDragStartIndex(index);
      setDetailDragCurrentIndex(index);
      setHoveredDetailIndex(index);
    },
    [detailReferenceLinePlacing, getDetailGuideFromMouseEvent, getDetailIndexFromMouseEvent],
  );

  const handleDetailMouseMove = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      const index = getDetailIndexFromMouseEvent(event);
      if (index === null) return;
      setHoveredDetailIndex(index);
      if (detailReferenceLineDraggingId) {
        const guide = getDetailGuideFromMouseEvent(event);
        if (!guide) return;
        setDetailReferenceLineDrafts((prev) =>
          prev.map((item) => {
            if (item.id !== detailReferenceLineDraggingId) return item;
            if (item.lineType === "horizontal") {
              return { ...item, lineValue: Number(guide.value.toFixed(2)).toString() };
            }
            return { ...item, lineDate: guide.label };
          }),
        );
        return;
      }
      if (detailReferenceLinePlacing) {
        const guide = getDetailGuideFromMouseEvent(event);
        setDetailReferenceLineGuide(guide ? { x: guide.x, y: guide.y, label: guide.label, value: guide.value } : null);
      }
      if (detailDragStartIndex !== null) {
        setDetailDragCurrentIndex(index);
      }
    },
    [
      detailDragStartIndex,
      detailReferenceLineDraggingId,
      detailReferenceLinePlacing,
      getDetailGuideFromMouseEvent,
      getDetailIndexFromMouseEvent,
    ],
  );

  const handleDetailMouseUp = useCallback(() => {
    if (detailReferenceLineDraggingId) {
      setDetailReferenceLineDraggingId(null);
      return;
    }
    if (detailDragStartIndex === null || detailDragCurrentIndex === null) return;
    const isLeftToRight = detailDragCurrentIndex > detailDragStartIndex;
    const isRightToLeft = detailDragCurrentIndex < detailDragStartIndex;
    if (isLeftToRight && detailDragCurrentIndex - detailDragStartIndex >= 1) {
      setDetailZoomRange({
        start: detailViewRange.start + detailDragStartIndex,
        end: detailViewRange.start + detailDragCurrentIndex,
      });
    }
    if (isRightToLeft) {
      setDetailZoomRange(null);
      setHoveredDetailIndex(null);
    }
    setDetailDragStartIndex(null);
    setDetailDragCurrentIndex(null);
  }, [detailDragCurrentIndex, detailDragStartIndex, detailReferenceLineDraggingId, detailViewRange.start]);

  const handleDetailResetZoom = useCallback(() => {
    setDetailZoomRange(null);
    setHoveredDetailIndex(null);
    setDetailReferenceLinePlacing(null);
    setDetailReferenceLineDraggingId(null);
    setDetailReferenceLineGuide(null);
  }, []);

  const handleDetailLegendToggle = useCallback((seriesId: string) => {
    setHiddenDetailSeriesIds((prev) =>
      prev.includes(seriesId) ? prev.filter((id) => id !== seriesId) : [...prev, seriesId],
    );
  }, []);

  const detailSelectionRect = useMemo(() => {
    if (detailDragStartIndex === null || detailDragCurrentIndex === null) return null;
    const drawableWidth = chartWidth - padding.left - padding.right;
    const x1 = padding.left + (drawableWidth * detailDragStartIndex) / Math.max(detailLabelsInView.length - 1, 1);
    const x2 =
      padding.left + (drawableWidth * detailDragCurrentIndex) / Math.max(detailLabelsInView.length - 1, 1);
    return { left: Math.min(x1, x2), width: Math.abs(x2 - x1) };
  }, [detailDragCurrentIndex, detailDragStartIndex, detailLabelsInView.length]);

  const detailSvgMeasureKey = `${detailLabelsInView.length}-${showDetailFullscreen ? 1 : 0}`;

  useEffect(() => {
    if (!detailTooltipRef.current) return;
    const nextWidth = Math.ceil(detailTooltipRef.current.getBoundingClientRect().width);
    if (nextWidth !== detailTooltipWidth) {
      setDetailTooltipWidth(nextWidth);
    }
  }, [detailHoverRows, detailLabelsInView, detailTooltipWidth, hoveredDetailIndex]);

  useEffect(() => {
    const svg = detailSvgRef.current;
    if (!svg) return;
    const updateWidth = () => {
      const width = Math.ceil(svg.getBoundingClientRect().width);
      if (width > 0) setDetailSvgWidth(width);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(svg);
    return () => observer.disconnect();
  }, [detailSvgMeasureKey]);

  const detailTooltipPlacement = useMemo(() => {
    if (detailHoverX === null) return null;
    const gap = 6;
    const anchorPx = (detailHoverX / chartWidth) * detailSvgWidth;
    const availableRight = detailSvgWidth - anchorPx;
    const requiredWidth = Math.max(detailTooltipWidth, 0) + gap;
    const canShowRight = availableRight >= requiredWidth;
    const canShowLeft = anchorPx >= requiredWidth;
    const showLeftSide = !canShowRight && (canShowLeft || anchorPx > availableRight);
    return {
      left: `${anchorPx}px`,
      transform: showLeftSide ? `translateX(calc(-100% - ${gap}px))` : `translateX(${gap}px)`,
    };
  }, [detailHoverX, detailSvgWidth, detailTooltipWidth]);

  useEffect(() => {
    if (hoveredDetailIndex === null) return;
    if (hoveredDetailIndex >= detailLabelsInView.length) {
      setHoveredDetailIndex(null);
    }
  }, [detailLabelsInView.length, hoveredDetailIndex]);

  useEffect(() => {
    if (detailDragStartIndex === null && detailDragCurrentIndex === null) return;
    if (!detailLabelsInView.length) {
      setDetailDragStartIndex(null);
      setDetailDragCurrentIndex(null);
    }
  }, [detailDragCurrentIndex, detailDragStartIndex, detailLabelsInView.length]);

  useEffect(() => {
    const handleWindowMouseUp = () => {
      setDetailDragStartIndex(null);
      setDetailDragCurrentIndex(null);
      setDetailReferenceLineDraggingId(null);
    };
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => window.removeEventListener("mouseup", handleWindowMouseUp);
  }, []);

  useEffect(() => {
    if (!showDetailFullscreen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowDetailFullscreen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [showDetailFullscreen]);

  useEffect(() => {
    if (!detailReferenceLineMenu) return;
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      if (!detailReferenceLineMenuRef.current) {
        setDetailReferenceLineMenu(null);
        setDetailReferenceLineDashDropdownOpen(false);
        return;
      }
      const target = event.target as Node | null;
      if (target && detailReferenceLineMenuRef.current.contains(target)) return;
      setDetailReferenceLineMenu(null);
      setDetailReferenceLineDashDropdownOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailReferenceLineMenu(null);
        setDetailReferenceLineDashDropdownOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [detailReferenceLineMenu]);

  const availableFreqTabs = useMemo(
    () => freqOrder.filter((freq) => seriesList.some((series) => toFreq(series.freq) === freq)),
    [seriesList],
  );

  const previewLabels = useMemo(() => getCommonObsDates(previewSeries), [previewSeries]);

  const previewRows = useMemo(
    () =>
      previewSeries.map((series) => {
        const map = new Map(series.points.map((point) => [point.obsDate, point.obsValue]));
        return { ...series, values: previewLabels.map((label) => map.get(label) ?? NaN) };
      }),
    [previewLabels, previewSeries],
  );

  const previewRange = useMemo(() => {
    const all = previewRows.flatMap((item) => item.values.filter((v) => Number.isFinite(v)));
    if (!all.length) return { min: 0, max: 1 };
    const min = Math.min(...all);
    const max = Math.max(...all);
    return { min: Number((min * 0.98).toFixed(2)), max: Number((max * 1.02).toFixed(2)) };
  }, [previewRows]);

  const filteredCreateSeriesList = useMemo(() => {
    const q = createSeriesQuery.trim().toLowerCase();
    return seriesList
      .filter((series) => {
        const freq = toFreq(series.freq);
        if (freq !== createFreqTab) return false;
        if (!q) return true;
        return [series.seriesName, series.sourceOrg, series.sourceTable].some((value) =>
          value.toLowerCase().includes(q),
        );
      })
      .sort((a, b) => {
        const aDerived = a.sourceOrg === "derived" ? 0 : 1;
        const bDerived = b.sourceOrg === "derived" ? 0 : 1;
        if (aDerived !== bDerived) return aDerived - bDerived;
        return a.seriesName.localeCompare(b.seriesName, "ko");
      });
  }, [createFreqTab, createSeriesQuery, seriesList]);

  const editPreviewLabels = useMemo(() => getCommonObsDates(editPreviewSeries), [editPreviewSeries]);

  const editPreviewRows = useMemo(
    () =>
      editPreviewSeries.map((series) => {
        const map = new Map(series.points.map((point) => [point.obsDate, point.obsValue]));
        return { ...series, values: editPreviewLabels.map((label) => map.get(label) ?? NaN) };
      }),
    [editPreviewLabels, editPreviewSeries],
  );

  const editPreviewRange = useMemo(() => {
    const all = editPreviewRows.flatMap((item) => item.values.filter((v) => Number.isFinite(v)));
    if (!all.length) return { min: 0, max: 1 };
    const min = Math.min(...all);
    const max = Math.max(...all);
    return { min: Number((min * 0.98).toFixed(2)), max: Number((max * 1.02).toFixed(2)) };
  }, [editPreviewRows]);

  const filteredEditSeriesList = useMemo(() => {
    const q = editSeriesQuery.trim().toLowerCase();
    return seriesList
      .filter((series) => {
        const freq = toFreq(series.freq);
        if (freq !== editFreqTab) return false;
        if (!q) return true;
        return [series.seriesName, series.sourceOrg, series.sourceTable].some((value) =>
          value.toLowerCase().includes(q),
        );
      })
      .sort((a, b) => {
        const aDerived = a.sourceOrg === "derived" ? 0 : 1;
        const bDerived = b.sourceOrg === "derived" ? 0 : 1;
        if (aDerived !== bDerived) return aDerived - bDerived;
        return a.seriesName.localeCompare(b.seriesName, "ko");
      });
  }, [editFreqTab, editSeriesQuery, seriesList]);

  const selectedCreateFreq = useMemo(() => {
    const firstId = selectedSeriesIds[0];
    if (!firstId) return null;
    const matched = seriesList.find((series) => series.seriesId === firstId);
    return matched ? toFreq(matched.freq) : null;
  }, [selectedSeriesIds, seriesList]);

  const selectedEditFreq = useMemo(() => {
    const firstId = editSeriesIds[0];
    if (!firstId) return null;
    const matched = seriesList.find((series) => series.seriesId === firstId);
    return matched ? toFreq(matched.freq) : null;
  }, [editSeriesIds, seriesList]);

  const deriveSourceOptions = useMemo(
    () =>
      (deriveContext === "analysisCreate" || deriveContext === "analysisEdit"
        ? analysisSeriesPool
        : seriesList)
        .filter((series) => toFreq(series.freq) === "D" || toFreq(series.freq) === "M" || toFreq(series.freq) === "Q")
        .sort((a, b) => {
          const order: Record<Freq, number> = { D: 0, M: 1, Q: 2, Y: 3 };
          const aFreq = toFreq(a.freq) ?? "Q";
          const bFreq = toFreq(b.freq) ?? "Q";
          const freqDiff = order[aFreq] - order[bFreq];
          if (freqDiff !== 0) return freqDiff;
          return a.seriesName.localeCompare(b.seriesName, "ko");
        })
        .map((series) => ({
          seriesId: series.seriesId,
          seriesName: series.seriesName,
          freq: toFreq(series.freq) ?? "M",
        })),
    [analysisSeriesPool, deriveContext, seriesList],
  );

  const deriveSourceFreq = useMemo(() => {
    const matched = deriveSourceOptions.find((item) => item.seriesId === deriveSourceSeriesId);
    return matched?.freq ?? null;
  }, [deriveSourceOptions, deriveSourceSeriesId]);

  const deriveTargetOptions = useMemo(() => {
    if (deriveSourceFreq === "D") return ["M", "Q", "Y"] as Array<"M" | "Q" | "Y">;
    if (deriveSourceFreq === "M") return ["Q", "Y"] as Array<"M" | "Q" | "Y">;
    if (deriveSourceFreq === "Q") return ["Y"] as Array<"M" | "Q" | "Y">;
    return [] as Array<"M" | "Q" | "Y">;
  }, [deriveSourceFreq]);

  useEffect(() => {
    if (!showDerive) return;
    if (!deriveTargetOptions.length) return;
    if (!deriveTargetOptions.includes(deriveTargetFreq)) {
      setDeriveTargetFreq(deriveTargetOptions[0]);
    }
  }, [deriveTargetFreq, deriveTargetOptions, showDerive]);

  useEffect(() => {
    if (!availableFreqTabs.length) return;
    if (!availableFreqTabs.includes(createFreqTab)) {
      setCreateFreqTab(availableFreqTabs[0]);
    }
  }, [availableFreqTabs, createFreqTab]);

  useEffect(() => {
    if (!availableFreqTabs.length) return;
    if (!availableFreqTabs.includes(editFreqTab)) {
      setEditFreqTab(availableFreqTabs[0]);
    }
  }, [availableFreqTabs, editFreqTab]);

  const toReferenceLinePayload = useCallback((drafts: ReferenceLineDraft[]) => {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const payload: Array<{
      lineType: "horizontal" | "vertical";
      lineLabel?: string;
      lineValue?: number;
      lineDate?: string;
      lineColor?: string;
      lineWidth: number;
      lineDash?: string;
    }> = [];
    for (const line of drafts) {
      const width = Number.isFinite(line.lineWidth)
        ? Math.max(1, Math.min(4, Number(line.lineWidth)))
        : 1.5;
      const dash = line.lineDash === "none" ? null : line.lineDash.trim() || "6 4";
      if (line.lineType === "horizontal") {
        const raw = line.lineValue.trim();
        if (!raw) continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          return { ok: false as const, error: "가로 기준선 값은 숫자여야 합니다." };
        }
        payload.push({
          lineType: "horizontal",
          lineLabel: line.lineLabel.trim() || undefined,
          lineValue: value,
          lineColor: line.lineColor.trim() || undefined,
          lineWidth: width,
          lineDash: dash || undefined,
        });
        continue;
      }
      const date = line.lineDate.trim();
      if (!date) continue;
      if (!datePattern.test(date)) {
        return { ok: false as const, error: "세로 기준선 날짜는 YYYY-MM-DD 형식이어야 합니다." };
      }
      payload.push({
        lineType: "vertical",
        lineLabel: line.lineLabel.trim() || undefined,
        lineDate: date,
        lineColor: line.lineColor.trim() || undefined,
        lineWidth: width,
        lineDash: dash || undefined,
      });
    }
    return { ok: true as const, payload };
  }, []);

  const handleSaveDetailReferenceLines = async () => {
    if (!selectedChartId) return;
    if (!detailTitle.trim()) {
      setDetailReferenceLineError("그래프 이름이 비어 있어 저장할 수 없습니다.");
      return;
    }
    const result = toReferenceLinePayload(detailReferenceLineDrafts);
    if (!result.ok) {
      setDetailReferenceLineError(result.error);
      return;
    }
    setDetailReferenceLineSaving(true);
    setDetailReferenceLineError("");
    try {
      const response = await fetch(`/api/visualization/charts/${selectedChartId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chartName: detailTitle.trim(),
          referenceLines: result.payload,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "기준선 저장에 실패했습니다.");
      }
      await fetchChartDetail(selectedChartId);
    } catch (error) {
      setDetailReferenceLineError(error instanceof Error ? error.message : "기준선 저장에 실패했습니다.");
    } finally {
      setDetailReferenceLineSaving(false);
      setDetailReferenceLineMenu(null);
      setDetailReferenceLineDashDropdownOpen(false);
    }
  };

  const handleCreateChart = async () => {
    setCreateError("");
    setCreateStatus("");
    if (!createName.trim()) {
      setCreateError("그래프 이름을 입력하세요.");
      return;
    }
    if (!selectedSeriesIds.length) {
      setCreateError("시리즈를 1개 이상 선택하세요.");
      return;
    }
    try {
      const response = await fetch("/api/visualization/charts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chartName: createName.trim(),
          chartType: "line",
          seriesIds: selectedSeriesIds,
          seriesOptions: selectedSeriesIds.map((seriesId) => ({
            seriesId,
            yAxisSide: createSeriesAxisMap[seriesId] ?? "left",
          })),
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        chartId?: number;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "그래프 생성에 실패했습니다.");
      }
      setCreateStatus("그래프가 생성되었습니다.");
      setShowCreate(false);
      setCreateName("");
      setCreateFreqTab("M");
      setSelectedSeriesIds([]);
      setCreateSeriesAxisMap({});
      setPreviewSeries([]);
      await fetchCharts();
      if (payload.chartId) setSelectedChartId(payload.chartId);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "그래프 생성에 실패했습니다.");
    }
  };

  const resetEditModal = () => {
    setShowEdit(false);
    setEditChartId(null);
    setEditName("");
    setEditSeriesQuery("");
    setEditFreqTab("M");
    setEditSeriesIds([]);
    setEditSeriesAxisMap({});
    setEditPreviewSeries([]);
    setEditError("");
  };

  const handleOpenEditChartModal = async (chart: ChartListItem) => {
    setChartActionError("");
    setEditError("");
    setChartActionBusyId(chart.chartId);
    setSeriesLoading(true);
    try {
      const [seriesResponse, detailResponse] = await Promise.all([
        fetch("/api/visualization/series"),
        fetch(`/api/visualization/charts/${chart.chartId}`),
      ]);
      const seriesPayload = (await seriesResponse.json()) as {
        ok?: boolean;
        series?: SeriesListItem[];
        error?: string;
      };
      const detailPayload = (await detailResponse.json()) as {
        ok?: boolean;
        chart?: { chartName: string };
        series?: ChartDetailSeries[];
        error?: string;
      };
      if (!seriesResponse.ok || !seriesPayload.ok) {
        throw new Error(seriesPayload.error || "시리즈 목록을 불러오지 못했습니다.");
      }
      if (!detailResponse.ok || !detailPayload.ok) {
        throw new Error(detailPayload.error || "그래프 정보를 불러오지 못했습니다.");
      }
      setSeriesList(seriesPayload.series ?? []);
      setEditChartId(chart.chartId);
      setEditName(detailPayload.chart?.chartName ?? chart.chartName);
      setEditSeriesQuery("");
      const nextEditSeriesIds = (detailPayload.series ?? []).map((item) => item.seriesId);
      setEditSeriesIds(nextEditSeriesIds);
      setEditSeriesAxisMap(
        Object.fromEntries(
          (detailPayload.series ?? []).map((item) => [item.seriesId, normalizeYAxisSide(item.yAxisSide)]),
        ),
      );
      const baseFreq = toFreq((detailPayload.series ?? [])[0]?.freq ?? "") ?? "M";
      setEditFreqTab(baseFreq);
      setShowEdit(true);
    } catch (error) {
      setChartActionError(error instanceof Error ? error.message : "그래프 정보를 불러오지 못했습니다.");
    } finally {
      setSeriesLoading(false);
      setChartActionBusyId(null);
    }
  };

  const handleUpdateChart = async () => {
    if (!editChartId) return;
    const nextName = editName.trim();
    if (!nextName) {
      setEditError("그래프 이름을 입력하세요.");
      return;
    }
    if (!editSeriesIds.length) {
      setEditError("시리즈를 1개 이상 선택하세요.");
      return;
    }
    setEditError("");
    setChartActionBusyId(editChartId);
    try {
      const response = await fetch(`/api/visualization/charts/${editChartId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chartName: nextName,
          seriesIds: editSeriesIds,
          seriesOptions: editSeriesIds.map((seriesId) => ({
            seriesId,
            yAxisSide: editSeriesAxisMap[seriesId] ?? "left",
          })),
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "그래프 수정에 실패했습니다.");
      }
      await fetchCharts();
      setSelectedChartId(editChartId);
      await fetchChartDetail(editChartId);
      resetEditModal();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "그래프 수정에 실패했습니다.");
    } finally {
      setChartActionBusyId(null);
    }
  };

  const handleOpenDeriveModal = (
    context: "create" | "edit" | "analysisCreate" | "analysisEdit",
  ) => {
    const message = "파생 시리즈 기능은 매핑 전환으로 중단되었습니다.";
    if (context === "create") setCreateError(message);
    if (context === "edit") setEditError(message);
    if (context === "analysisCreate") setAnalysisCreateError(message);
    if (context === "analysisEdit") setAnalysisEditError(message);
  };

  const handleCreateDerivedSeries = async () => {
    if (!deriveSourceSeriesId) {
      setDeriveError("원본 시리즈를 선택하세요.");
      return;
    }
    setDeriveError("");
    setDeriveLoading(true);
    try {
      const response = await fetch("/api/visualization/series/derive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseSeriesId: deriveSourceSeriesId,
          targetFreq: deriveTargetFreq,
          aggRule: deriveAggRule,
          seriesName: deriveSeriesName.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        series?: { seriesId: string; freq: string; seriesName: string };
      };
      if (!response.ok || !payload.ok || !payload.series?.seriesId) {
        throw new Error(payload.error || "파생 시리즈 생성에 실패했습니다.");
      }

      await Promise.all([fetchSeries(), fetchAnalysisSeriesPool()]);
      const nextFreq = (toFreq(payload.series.freq) ?? deriveTargetFreq) as Freq;
      if (deriveContext === "create") {
        setCreateFreqTab(nextFreq);
        setCreateError("");
        setCreateSeriesAxisMap((prev) => ({
          ...prev,
          [payload.series!.seriesId]: prev[payload.series!.seriesId] ?? "left",
        }));
      } else if (deriveContext === "edit") {
        setEditFreqTab(nextFreq);
        setEditError("");
        setEditSeriesAxisMap((prev) => ({
          ...prev,
          [payload.series!.seriesId]: prev[payload.series!.seriesId] ?? "left",
        }));
      } else if (deriveContext === "analysisCreate") {
        setAnalysisCreateFreqTab(nextFreq);
        setAnalysisCreateError("");
        setAnalysisCreateSeriesIds((prev) =>
          prev.includes(payload.series!.seriesId) ? prev : [...prev, payload.series!.seriesId],
        );
      } else {
        setAnalysisEditFreqTab(nextFreq);
        setAnalysisEditError("");
        setAnalysisEditSeriesIds((prev) =>
          prev.includes(payload.series!.seriesId) ? prev : [...prev, payload.series!.seriesId],
        );
      }

      setShowDerive(false);
      setDeriveSourceSeriesId("");
      setDeriveSeriesName("");
    } catch (error) {
      setDeriveError(error instanceof Error ? error.message : "파생 시리즈 생성에 실패했습니다.");
    } finally {
      setDeriveLoading(false);
    }
  };

  const closeDeriveModal = () => {
    setShowDerive(false);
    setDeriveError("");
    setDeriveSourceSeriesId("");
    setDeriveSeriesName("");
    setDeriveLoading(false);
  };

  const handleDeleteDerivedSeries = async (
    series: { seriesId: string; seriesName: string },
    context: "create" | "edit" | "analysisCreate" | "analysisEdit",
  ) => {
    const ok = window.confirm(`'${series.seriesName}' 파생 시리즈를 삭제할까요?`);
    if (!ok) return;
    setDeletingDerivedSeriesId(series.seriesId);
    if (context === "create") setCreateError("");
    if (context === "edit") setEditError("");
    if (context === "analysisCreate") setAnalysisCreateError("");
    if (context === "analysisEdit") setAnalysisEditError("");
    try {
      const response = await fetch(`/api/visualization/series/${encodeURIComponent(series.seriesId)}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "파생 시리즈 삭제에 실패했습니다.");
      }
      if (context === "create") {
        setSelectedSeriesIds((prev) => prev.filter((id) => id !== series.seriesId));
        setCreateSeriesAxisMap((prev) => {
          const { [series.seriesId]: _removed, ...rest } = prev;
          return rest;
        });
      } else if (context === "edit") {
        setEditSeriesIds((prev) => prev.filter((id) => id !== series.seriesId));
        setEditSeriesAxisMap((prev) => {
          const { [series.seriesId]: _removed, ...rest } = prev;
          return rest;
        });
      } else if (context === "analysisCreate") {
        setAnalysisCreateSeriesIds((prev) => prev.filter((id) => id !== series.seriesId));
      } else {
        setAnalysisEditSeriesIds((prev) => prev.filter((id) => id !== series.seriesId));
      }
      await Promise.all([fetchSeries(), fetchAnalysisSeriesPool()]);
    } catch (error) {
      if (context === "create") {
        setCreateError(error instanceof Error ? error.message : "파생 시리즈 삭제에 실패했습니다.");
      } else if (context === "edit") {
        setEditError(error instanceof Error ? error.message : "파생 시리즈 삭제에 실패했습니다.");
      } else if (context === "analysisCreate") {
        setAnalysisCreateError(error instanceof Error ? error.message : "파생 시리즈 삭제에 실패했습니다.");
      } else {
        setAnalysisEditError(error instanceof Error ? error.message : "파생 시리즈 삭제에 실패했습니다.");
      }
    } finally {
      setDeletingDerivedSeriesId(null);
    }
  };

  const handleDeleteChart = async (chart: ChartListItem) => {
    const ok = window.confirm(`'${chart.chartName}' 그래프를 삭제할까요?`);
    if (!ok) return;
    setChartActionError("");
    setChartActionBusyId(chart.chartId);
    try {
      const response = await fetch(`/api/visualization/charts/${chart.chartId}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "그래프 삭제에 실패했습니다.");
      }
      if (selectedChartId === chart.chartId) {
        setSelectedChartId(null);
      }
      if (editChartId === chart.chartId) {
        resetEditModal();
      }
      await fetchCharts();
    } catch (error) {
      setChartActionError(error instanceof Error ? error.message : "그래프 삭제에 실패했습니다.");
    } finally {
      setChartActionBusyId(null);
    }
  };

  const selectedMenuReferenceLine = useMemo(() => {
    if (!detailReferenceLineMenu) return null;
    return detailReferenceLineDrafts.find((item) => item.id === detailReferenceLineMenu.id) ?? null;
  }, [detailReferenceLineDrafts, detailReferenceLineMenu]);

  const updateReferenceLineFromMenu = useCallback(
    (id: string, updater: (line: ReferenceLineDraft) => ReferenceLineDraft) => {
      setDetailReferenceLineDrafts((prev) => prev.map((line) => (line.id === id ? updater(line) : line)));
    },
    [],
  );

  const deleteReferenceLineFromMenu = useCallback((id: string) => {
    setDetailReferenceLineDrafts((prev) => prev.filter((line) => line.id !== id));
    setDetailReferenceLineMenu(null);
    if (detailReferenceLineDraggingId === id) setDetailReferenceLineDraggingId(null);
    if (detailReferenceLineHoveredId === id) setDetailReferenceLineHoveredId(null);
  }, [detailReferenceLineDraggingId, detailReferenceLineHoveredId]);

  const renderDetailLegend = () => (
    <div className="flex flex-wrap gap-2">
      {detailSeries.map((series, index) => (
        <button
          key={series.seriesId}
          onClick={() => handleDetailLegendToggle(series.seriesId)}
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
            hiddenDetailSeriesIds.includes(series.seriesId)
              ? "border-slate-200 bg-white text-slate-400"
              : "border-slate-300 bg-slate-50 text-slate-700"
          }`}
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: detailColorMap.get(series.seriesId) || colorPalette[index % colorPalette.length],
              opacity: hiddenDetailSeriesIds.includes(series.seriesId) ? 0.35 : 1,
            }}
          />
          {series.seriesName}
        </button>
      ))}
    </div>
  );

  const renderDetailInteractiveChart = () => (
    <div
      className="overflow-x-auto rounded-2xl border border-slate-200 p-3 select-none"
      onContextMenu={(event) => {
        event.preventDefault();
        setDetailReferenceLineMenu(null);
        if (!detailReferenceLinePlacing) return;
        setDetailReferenceLinePlacing(null);
        setDetailReferenceLineGuide(null);
      }}
    >
      <p className="mb-2 text-[11px] text-slate-500">
        범례 클릭으로 시리즈 표시/숨김, 좌→우 드래그 확대, 우→좌 드래그/더블클릭 확대 해제, 기준선 찍기
      </p>
      <div ref={detailChartWrapRef} className="relative min-w-[780px]">
        <svg
          ref={detailSvgRef}
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="block w-full min-w-[780px] select-none"
          role="img"
          aria-label="시계열 그래프"
          onMouseDown={(event) => {
            event.preventDefault();
            handleDetailMouseDown(event);
          }}
          onMouseMove={handleDetailMouseMove}
          onMouseUp={handleDetailMouseUp}
          onDoubleClick={handleDetailResetZoom}
          onMouseLeave={() => {
            setHoveredDetailIndex(null);
            setDetailReferenceLineGuide(null);
            setDetailReferenceLineHoveredId(null);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!detailReferenceLinePlacing) return;
            setDetailReferenceLinePlacing(null);
            setDetailReferenceLineGuide(null);
          }}
        >
          {detailYTicks.map((tick) => (
            <g key={`detail-tick-${tick.y}`}>
              <line
                x1={padding.left}
                y1={tick.y}
                x2={chartWidth - padding.right}
                y2={tick.y}
                stroke="#e2e8f0"
                strokeDasharray="3 3"
              />
              <text
                x={padding.left - 8}
                y={tick.y + 3}
                textAnchor="end"
                fontSize="10"
                fill="#64748b"
              >
                {formatValue(tick.value)}
              </text>
            </g>
          ))}
          {detailRightYTicks.map((tick) => (
            <text
              key={`detail-right-tick-${tick.y}`}
              x={chartWidth - padding.right + 8}
              y={tick.y + 3}
              textAnchor="start"
              fontSize="10"
              fill="#64748b"
            >
              {formatValue(tick.value)}
            </text>
          ))}
          <line
            x1={padding.left}
            y1={padding.top}
            x2={padding.left}
            y2={chartHeight - padding.bottom}
            stroke="#cbd5e1"
          />
          {detailRightRows.length ? (
            <line
              x1={chartWidth - padding.right}
              y1={padding.top}
              x2={chartWidth - padding.right}
              y2={chartHeight - padding.bottom}
              stroke="#cbd5e1"
            />
          ) : null}
          <line
            x1={padding.left}
            y1={chartHeight - padding.bottom}
            x2={chartWidth - padding.right}
            y2={chartHeight - padding.bottom}
            stroke="#cbd5e1"
          />
          {detailReferenceLineRows.map((line) => (
            <g
              key={`detail-ref-line-${line.id}`}
              onMouseEnter={() => setDetailReferenceLineHoveredId(line.id)}
              onMouseLeave={() => setDetailReferenceLineHoveredId(null)}
            >
              <line
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke={line.lineColor || "#94a3b8"}
                strokeWidth={
                  detailReferenceLineDraggingId === line.id || detailReferenceLineHoveredId === line.id
                    ? 2
                    : line.lineWidth || 1.2
                }
                strokeDasharray={line.lineDash === "none" ? undefined : line.lineDash || "6 4"}
                pointerEvents="none"
              />
              <line
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke="transparent"
                strokeWidth={line.lineType === "horizontal" ? 16 : 14}
                className={detailReferenceLineDraggingId === line.id ? "cursor-grabbing" : "cursor-pointer"}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!detailChartWrapRef.current) return;
                  const rect = detailChartWrapRef.current.getBoundingClientRect();
                  const menuWidth = 256;
                  const menuHeight = 340;
                  const gap = 8;
                  const cursorOffset = 4;
                  const mouseX = event.clientX - rect.left;
                  const mouseY = event.clientY - rect.top;
                  let x = mouseX + cursorOffset;
                  let y = mouseY + cursorOffset;
                  if (x + menuWidth > rect.width - gap) x = mouseX - menuWidth - cursorOffset;
                  if (y + menuHeight > rect.height - gap) y = rect.height - menuHeight - gap;
                  if (x < gap) x = gap;
                  if (y < gap) y = gap;
                  setDetailReferenceLineMenu({ id: line.id, x, y });
                  setDetailReferenceLineDashDropdownOpen(false);
                  setDetailReferenceLinePlacing(null);
                  setDetailReferenceLineGuide(null);
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.button !== 0) return;
                  setDetailReferenceLineMenu(null);
                  setDetailReferenceLineDashDropdownOpen(false);
                  setDetailReferenceLineDraggingId(line.id);
                  setDetailReferenceLinePlacing(null);
                  setDetailReferenceLineGuide(null);
                }}
              />
              {line.lineType === "horizontal" ? (
                <>
                  <text
                    x={padding.left - 8}
                    y={line.y1 + 3}
                    textAnchor="end"
                    fontSize="10"
                    fill={line.lineColor || "#64748b"}
                  >
                    {line.axisText}
                  </text>
                  {line.lineLabel
                    ? wrapRefLineLabel(line.lineLabel, padding.right - 8, 10).map((row, i) => (
                        <text
                          key={`${line.id}-label-${i}`}
                          x={chartWidth - padding.right + 8}
                          y={line.y1 + 3 + i * 12}
                          textAnchor="start"
                          fontSize="10"
                          fill={line.lineColor || "#64748b"}
                        >
                          {row}
                        </text>
                      ))
                    : null}
                </>
              ) : null}
              {line.lineType === "vertical" && line.lineLabel ? (
                <text
                  x={line.x1}
                  y={padding.top - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fill={line.lineColor || "#64748b"}
                >
                  {line.lineLabel}
                </text>
              ) : null}
            </g>
          ))}
          {detailReferenceLinePlacing && detailReferenceLineGuide ? (
            <line
              x1={detailReferenceLinePlacing === "horizontal" ? padding.left : detailReferenceLineGuide.x}
              y1={detailReferenceLinePlacing === "horizontal" ? detailReferenceLineGuide.y : padding.top}
              x2={detailReferenceLinePlacing === "horizontal" ? chartWidth - padding.right : detailReferenceLineGuide.x}
              y2={
                detailReferenceLinePlacing === "horizontal"
                  ? detailReferenceLineGuide.y
                  : chartHeight - padding.bottom
              }
              stroke="#2563eb"
              strokeWidth={1.4}
              strokeDasharray="6 4"
            />
          ) : null}
          {detailChartRows.map((series, index) => (
            <polyline
              key={series.seriesId}
              fill="none"
              stroke={detailColorMap.get(series.seriesId) || colorPalette[index % colorPalette.length]}
              strokeWidth={2.3}
              points={(() => {
                const axisRange =
                  normalizeYAxisSide(series.yAxisSide) === "right" ? detailRightRange : detailLeftRange;
                return buildPolyline(
                  series.values.map((v) => (Number.isFinite(v) ? v : axisRange.min)),
                  axisRange.min,
                  axisRange.max,
                );
              })()}
            />
          ))}
          {detailSelectionRect ? (
            <rect
              x={detailSelectionRect.left}
              y={padding.top}
              width={detailSelectionRect.width}
              height={chartHeight - padding.top - padding.bottom}
              fill="#2563eb"
              fillOpacity={0.12}
              stroke="#2563eb"
              strokeOpacity={0.35}
              strokeDasharray="4 4"
            />
          ) : null}
          {detailHoverX !== null ? (
            <line
              x1={detailHoverX}
              y1={padding.top}
              x2={detailHoverX}
              y2={chartHeight - padding.bottom}
              stroke="#94a3b8"
              strokeDasharray="4 4"
            />
          ) : null}
          {detailHoverX !== null && hoveredDetailIndex !== null
            ? detailChartRows.map((series, index) => {
                const value = series.values[hoveredDetailIndex];
                if (!Number.isFinite(value)) return null;
                const axisRange =
                  normalizeYAxisSide(series.yAxisSide) === "right" ? detailRightRange : detailLeftRange;
                const safeRange = axisRange.max - axisRange.min || 1;
                const drawableHeight = chartHeight - padding.top - padding.bottom;
                const y = padding.top + ((axisRange.max - value) / safeRange) * drawableHeight;
                return (
                  <circle
                    key={`detail-hover-point-${series.seriesId}`}
                    cx={detailHoverX}
                    cy={y}
                    r={3.5}
                    fill={detailColorMap.get(series.seriesId) || colorPalette[index % colorPalette.length]}
                    stroke="#fff"
                    strokeWidth={1.5}
                  />
                );
              })
            : null}
          {detailLabelsInView.map((label, index) => {
            const drawableWidth = chartWidth - padding.left - padding.right;
            const x =
              padding.left + (drawableWidth * index) / Math.max(detailLabelsInView.length - 1, 1);
            const step = Math.ceil(detailLabelsInView.length / 8);
            const shouldRender =
              index === 0 || index === detailLabelsInView.length - 1 || index % step === 0;
            if (!shouldRender) return null;
            const textAnchor =
              index === 0 ? "start" : index === detailLabelsInView.length - 1 ? "end" : "middle";
            return (
              <text
                key={label}
                x={x}
                y={chartHeight - 10}
                textAnchor={textAnchor}
                fontSize="10"
                fill="#64748b"
              >
                {label.slice(2).replaceAll("-", ".")}
              </text>
            );
          })}
        </svg>
        {detailReferenceLineMenu && selectedMenuReferenceLine ? (
          <div
            ref={detailReferenceLineMenuRef}
            className="absolute z-20 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
            style={{ left: detailReferenceLineMenu.x, top: detailReferenceLineMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="text-[11px] font-semibold text-slate-700">기준선 설정</p>
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="block text-[10px] text-slate-500">
                  <p className="pointer-events-none">라벨</p>
                  <input
                    type="text"
                    value={selectedMenuReferenceLine.lineLabel}
                    onChange={(event) =>
                      updateReferenceLineFromMenu(selectedMenuReferenceLine.id, (line) => ({
                        ...line,
                        lineLabel: event.target.value,
                      }))
                    }
                    placeholder={selectedMenuReferenceLine.lineType === "horizontal" ? "예: 목표치" : "예: 기준일"}
                    className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
                  />
                </div>
                {selectedMenuReferenceLine.lineType === "horizontal" ? (
                  <div className="block text-[10px] text-slate-500">
                    <p className="pointer-events-none">값</p>
                    <input
                      type="number"
                      step="any"
                      value={selectedMenuReferenceLine.lineValue}
                      onChange={(event) =>
                        updateReferenceLineFromMenu(selectedMenuReferenceLine.id, (line) => ({
                          ...line,
                          lineValue: event.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
                    />
                  </div>
                ) : (
                  <div className="block text-[10px] text-slate-500">
                    <p className="pointer-events-none">날짜</p>
                    <input
                      type="date"
                      value={selectedMenuReferenceLine.lineDate}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const normalized = normalizeRefLineDate(raw, detailFreq);
                        updateReferenceLineFromMenu(selectedMenuReferenceLine.id, (line) => ({
                          ...line,
                          lineDate: normalized,
                        }));
                      }}
                      className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
                    />
                  </div>
                )}
              </div>
              <div>
                <p className="text-[10px] text-slate-500">색상</p>
                <div className="mt-1 grid grid-cols-5 gap-1">
                  {referenceLineColorPalette.map((color) => (
                    <button
                      key={`ref-line-color-${color}`}
                      type="button"
                      onClick={() =>
                        updateReferenceLineFromMenu(selectedMenuReferenceLine.id, (line) => ({
                          ...line,
                          lineColor: color,
                        }))
                      }
                      className={`h-4 w-4 rounded-full border ${
                        (selectedMenuReferenceLine.lineColor || referenceLineColorPalette[0]) === color
                          ? "border-slate-900"
                          : "border-slate-200"
                      }`}
                      style={{ backgroundColor: color }}
                      aria-label={`색상 ${color}`}
                    />
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="block text-[10px] text-slate-500">
                  <p className="pointer-events-none">선 굵기</p>
                  <div className="relative mt-1">
                    <select
                      value={selectedMenuReferenceLine.lineWidth}
                      onChange={(event) =>
                        updateReferenceLineFromMenu(selectedMenuReferenceLine.id, (line) => ({
                          ...line,
                          lineWidth: Number(event.target.value),
                        }))
                      }
                      className="mt-0 w-full appearance-none rounded border border-slate-200 bg-white py-1 pl-2 pr-6 text-[11px]"
                    >
                      {referenceLineWidthOptions.map((width) => (
                        <option key={`ref-line-width-${width}`} value={width}>
                          {width}px
                        </option>
                      ))}
                    </select>
                    <svg
                      className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M2 4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </div>
                <div className="block text-[10px] text-slate-500">
                  <p className="pointer-events-none">선 종류</p>
                  <div className="relative mt-1">
                  <button
                    type="button"
                    onClick={() => setDetailReferenceLineDashDropdownOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between rounded border border-slate-200 px-2 py-1"
                  >
                    <svg viewBox="0 0 80 10" className="h-3 w-32">
                      <line
                        x1={2}
                        y1={5}
                        x2={78}
                        y2={5}
                        stroke="#334155"
                        strokeWidth={1.8}
                        strokeDasharray={
                          referenceLineDashOptions.find((option) => option.value === selectedMenuReferenceLine.lineDash)
                            ?.previewDash
                        }
                      />
                    </svg>
                    <svg
                      className="h-3 w-3 shrink-0 text-slate-500"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M2 4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {detailReferenceLineDashDropdownOpen ? (
                    <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-full rounded border border-slate-200 bg-white p-1 shadow-lg">
                      {referenceLineDashOptions.map((option) => (
                        <button
                          key={`ref-line-dash-${option.value}`}
                          type="button"
                          onClick={() => {
                            updateReferenceLineFromMenu(selectedMenuReferenceLine.id, (line) => ({
                              ...line,
                              lineDash: option.value,
                            }));
                            setDetailReferenceLineDashDropdownOpen(false);
                          }}
                          className={`flex w-full items-center rounded px-1 py-1 ${
                            selectedMenuReferenceLine.lineDash === option.value
                              ? "bg-slate-100"
                              : "hover:bg-slate-50"
                          }`}
                          title={option.title}
                          aria-label={option.title}
                        >
                          <svg viewBox="0 0 80 10" className="h-3 w-full">
                            <line
                              x1={2}
                              y1={5}
                              x2={78}
                              y2={5}
                              stroke="#334155"
                              strokeWidth={1.8}
                              strokeDasharray={option.previewDash}
                            />
                          </svg>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => deleteReferenceLineFromMenu(selectedMenuReferenceLine.id)}
                className="w-full rounded border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50"
              >
                삭제
              </button>
            </div>
          </div>
        ) : null}
        {hoveredDetailIndex !== null && detailTooltipPlacement !== null ? (
          <div
            ref={detailTooltipRef}
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow"
            style={{
              left: detailTooltipPlacement.left,
              transform: detailTooltipPlacement.transform,
              top: 8,
            }}
          >
            <p className="font-semibold text-slate-900">
              {detailLabelsInView[hoveredDetailIndex]?.slice(2).replaceAll("-", ".")}
            </p>
            {detailHoverRows.length === 0 ? (
              <p className="mt-1 text-slate-500">데이터 없음</p>
            ) : (
              detailHoverRows.map((row) => (
                <p
                  key={`tooltip-${row.seriesId}`}
                  className="mt-1 flex items-center gap-2 text-slate-700"
                >
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                  <span>
                    {row.seriesName}: {formatValue(Number(row.value))}
                  </span>
                </p>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">데이터 시각화</h2>
        <p className="mt-2 text-sm text-slate-600">그래프 목록/상세/추가를 관리합니다.</p>
      </header>

      <div className="rounded-3xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap gap-2">
          {topics.map((topic) => (
            <button
              key={topic.key}
              onClick={() => setActiveTopic(topic.key)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                activeTopic === topic.key
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {topic.label}
              {!topic.ready ? " (준비중)" : ""}
            </button>
          ))}
        </div>
      </div>

      {activeTopic === "ingestionStatus" ? (
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">데이터 수집 현황</h3>
              <button
                onClick={() => void fetchIngestionStatus()}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                새로고침
              </button>
            </div>
            {ingestionLoading ? <p className="mt-3 text-sm text-slate-500">불러오는 중...</p> : null}
            {ingestionError ? <p className="mt-3 text-sm text-rose-600">{ingestionError}</p> : null}
            {!ingestionLoading && !ingestionError && ingestionSummary ? (
              <div className="mt-4 grid gap-3 md:grid-cols-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[11px] text-slate-500">전체 실행</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{formatValue(ingestionSummary.totalRuns)}</p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-[11px] text-emerald-700">성공</p>
                  <p className="mt-1 text-lg font-semibold text-emerald-700">{formatValue(ingestionSummary.successRuns)}</p>
                </div>
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3">
                  <p className="text-[11px] text-rose-700">실패</p>
                  <p className="mt-1 text-lg font-semibold text-rose-700">{formatValue(ingestionSummary.errorRuns)}</p>
                </div>
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-3">
                  <p className="text-[11px] text-indigo-700">성공률</p>
                  <p className="mt-1 text-lg font-semibold text-indigo-700">{ingestionSummary.successRate.toFixed(1)}%</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-3">
                  <p className="text-[11px] text-slate-500">누적 적재건수</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{formatValue(ingestionSummary.insertedTotal)}</p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <h4 className="text-sm font-semibold text-slate-900">일별 실행 추이 (최근 14일)</h4>
              <div className="mt-3 space-y-2">
                {ingestionDailyRows.length === 0 ? (
                  <p className="text-xs text-slate-500">실행 로그가 없습니다.</p>
                ) : (
                  ingestionDailyRows.map((row) => {
                    const width = Math.max(4, Math.round((row.totalRuns / ingestionDailyMaxRuns) * 100));
                    return (
                      <div key={`daily-${row.runDate}`} className="grid grid-cols-[88px_1fr_62px] items-center gap-2">
                        <span className="text-[11px] text-slate-600">{row.runDate.slice(5).replace("-", ".")}</span>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="h-2 rounded-full bg-slate-700" style={{ width: `${width}%` }} />
                        </div>
                        <span className="text-right text-[11px] text-slate-600">{row.totalRuns}회</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <h4 className="text-sm font-semibold text-slate-900">소스별 성공률 (최근 30일)</h4>
              <div className="mt-3 space-y-2">
                {ingestionSourceRows.length === 0 ? (
                  <p className="text-xs text-slate-500">실행 로그가 없습니다.</p>
                ) : (
                  ingestionSourceRows.map((row) => (
                    <div key={`source-${row.sourceId}`} className="rounded-xl border border-slate-200 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-semibold text-slate-800">{row.sourceName}</p>
                        <p className="text-[11px] text-slate-500">
                          {row.successRuns}/{row.totalRuns}
                        </p>
                      </div>
                      <div className="mt-2 h-1.5 rounded-full bg-slate-100">
                        <div
                          className="h-1.5 rounded-full bg-emerald-500"
                          style={{ width: `${Math.max(0, Math.min(100, row.successRate))}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <h4 className="text-sm font-semibold text-slate-900">최근 실패 로그</h4>
            <div className="mt-3 space-y-2">
              {ingestionFailureRows.length === 0 ? (
                <p className="text-xs text-slate-500">최근 실패 로그가 없습니다.</p>
              ) : (
                ingestionFailureRows.map((row) => (
                  <div key={`fail-${row.loadLogId}`} className="rounded-xl border border-rose-200 bg-rose-50 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-rose-700">
                      <span className="font-semibold">{new Date(row.startedAt).toLocaleString()}</span>
                      <span>{row.sourceName}</span>
                      <span>{row.groupName || "-"}</span>
                      <span className="rounded-full border border-rose-300 px-2 py-0.5">{row.errorStage || "unknown"}</span>
                    </div>
                    <p className="mt-1 text-xs text-rose-700">{row.errorMessage || "에러 메시지 없음"}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : activeTopic === "analysis" ? (
        <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
          <div className="space-y-3 rounded-3xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">분석 리스트</h3>
              </div>
              <button
                onClick={() => {
                  setShowAnalysisCreate(true);
                  setAnalysisCreateError("");
                }}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                분석 추가
              </button>
            </div>
            {analysisLoading ? <p className="text-xs text-slate-500">불러오는 중...</p> : null}
            {analysisError ? <p className="text-xs text-rose-600">{analysisError}</p> : null}
            {analysisActionError ? <p className="text-xs text-rose-600">{analysisActionError}</p> : null}
            {!analysisLoading && analysisCharts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-xs text-slate-500">
                생성된 분석이 없습니다. `분석 추가`로 시작하세요.
              </div>
            ) : null}
            {analysisCharts.map((chart) => (
              <div
                key={`analysis-chart-${chart.chartId}`}
                role="button"
                tabIndex={0}
                onClick={() => setAnalysisSelectedChartId(chart.chartId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setAnalysisSelectedChartId(chart.chartId);
                  }
                }}
                className={`cursor-pointer rounded-2xl border px-3 py-2 text-xs ${
                  analysisSelectedChartId === chart.chartId
                    ? "border-slate-900 bg-slate-50"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <p className="font-semibold text-slate-900">{chart.chartName}</p>
                <p className="mt-1 text-slate-500">
                  {chart.seriesCount}개 시리즈 · {new Date(chart.updatedAt).toLocaleDateString()}
                </p>
                <div className="mt-2 flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                  <button
                    onClick={() => void handleEditAnalysis(chart.chartId)}
                    disabled={analysisActionBusyId === chart.chartId}
                    className="rounded-full border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-60"
                  >
                    수정
                  </button>
                  <button
                    onClick={() => void handleDeleteAnalysis(chart)}
                    disabled={analysisActionBusyId === chart.chartId}
                    className="rounded-full border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                  >
                    삭제
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5">
            {!analysisSelectedChartId ? (
              <p className="text-sm text-slate-500">좌측에서 분석 대시보드를 선택하세요.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      value={analysisTitle}
                      onChange={(event) => setAnalysisTitle(event.target.value)}
                      className="w-full max-w-md rounded border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-900"
                    />
                    <span className="text-xs text-slate-500">{analysisRows.length}개 시리즈 기반</span>
                  </div>
                  <button
                    onClick={() => void handleSaveAnalysis()}
                    disabled={analysisSaving}
                    className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                  >
                    {analysisSaving ? "저장 중..." : "분석 저장"}
                  </button>
                </div>
                <div className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-2">
                  <label className="text-[11px] text-slate-600">
                    기준 주기
                    <select
                      value={analysisConfig.baseFreq ?? ""}
                      onChange={(event) =>
                        setAnalysisConfig((prev) => ({
                          ...prev,
                          baseFreq: toFreq(event.target.value) ?? null,
                        }))
                      }
                      className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs"
                    >
                      <option value="">자동</option>
                      {freqOrder.map((freq) => (
                        <option key={`analysis-config-freq-${freq}`} value={freq}>
                          {freqLabelMap[freq]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="text-[11px] text-slate-600">
                    분석 기법
                    <div className="mt-1 space-y-1.5">
                      {analysisTechniqueCategories.map((category) => (
                        <div key={`analysis-config-category-${category.categoryId}`}>
                          <p className="text-[10px] font-semibold text-slate-500">{category.categoryLabel}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {category.items.map((item) => (
                              <button
                                key={`analysis-config-technique-${item.value}`}
                                onClick={() =>
                                  setAnalysisConfig((prev) => {
                                    const exists = prev.techniques.includes(item.value);
                                    const next = exists
                                      ? prev.techniques.filter((value) => value !== item.value)
                                      : [...prev.techniques, item.value];
                                    return {
                                      ...prev,
                                      techniques: next.length ? next : prev.techniques,
                                    };
                                  })
                                }
                                className={`rounded-full border px-2 py-0.5 ${
                                  analysisTechniques.includes(item.value)
                                    ? "border-slate-900 bg-white text-slate-900"
                                    : "border-slate-200 bg-white text-slate-500"
                                }`}
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {analysisSaveError ? <p className="text-xs text-rose-600">{analysisSaveError}</p> : null}
                {analysisSaveStatus ? <p className="text-xs text-emerald-600">{analysisSaveStatus}</p> : null}
                {analysisFreqMismatch ? (
                  <p className="text-xs text-amber-600">
                    선택한 기준 주기와 다른 시리즈가 포함되어 있습니다. 해석 시 주의하세요.
                  </p>
                ) : null}

                <div className="grid gap-4 xl:grid-cols-2">
                  {analysisTechniques.includes("correlation") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">상관 분석</p>
                    <div className="mt-3 grid grid-cols-[120px_repeat(4,minmax(0,1fr))] gap-1 text-[10px]">
                      <div />
                      {analysisRows.map((row) => (
                        <div key={`corr-col-${row.seriesId}`} className="truncate text-center text-slate-500">
                          {row.seriesName}
                        </div>
                      ))}
                      {analysisRows.map((rowA, i) => (
                        <div key={`corr-row-wrap-${rowA.seriesId}`} className="contents">
                          <div className="truncate pr-1 text-slate-500">{rowA.seriesName}</div>
                          {analysisRows.map((rowB, j) => {
                            const v = analysisCorrelation[i]?.[j] ?? 0;
                            const intensity = Math.min(1, Math.abs(v));
                            const bg =
                              v >= 0
                                ? `rgba(37,99,235,${0.08 + intensity * 0.5})`
                                : `rgba(220,38,38,${0.08 + intensity * 0.5})`;
                            return (
                              <div
                                key={`corr-cell-${rowA.seriesId}-${rowB.seriesId}`}
                                className="rounded px-1 py-1 text-center font-semibold text-slate-700"
                                style={{ backgroundColor: bg }}
                              >
                                {v.toFixed(2)}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                  ) : null}

                  {analysisTechniques.includes("distribution") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">분포 분석 (히스토그램)</p>
                    <div className="mt-3 h-44 rounded-xl border border-slate-100 p-3">
                      {analysisDistribution.bins.length === 0 ? (
                        <p className="text-xs text-slate-500">분포를 계산할 데이터가 없습니다.</p>
                      ) : (
                        <div className="flex h-full items-end gap-1">
                          {analysisDistribution.bins.map((bin, idx) => {
                            const maxCount = Math.max(...analysisDistribution.bins.map((b) => b.count), 1);
                            const h = Math.max(4, (bin.count / maxCount) * 100);
                            return (
                              <div key={`hist-${idx}`} className="group relative flex-1">
                                <div className="w-full rounded-t bg-indigo-400/80" style={{ height: `${h}%` }} />
                                <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-white opacity-0 group-hover:opacity-100">
                                  {bin.count}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">
                      평균 {formatValue(analysisDistribution.mean)} / 표준편차 {formatValue(analysisDistribution.std)}
                    </p>
                  </div>
                  ) : null}

                  {analysisTechniques.includes("kpi") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">KPI 카드</p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {analysisRows.map((row) => {
                        const finite = row.values.filter((v) => Number.isFinite(v)).map((v) => Number(v));
                        const latest = finite[finite.length - 1] ?? 0;
                        const avg = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
                        return (
                          <div key={`kpi-${row.seriesId}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <p className="truncate text-[11px] font-semibold text-slate-700">{row.seriesName}</p>
                            <p className="mt-2 text-lg font-semibold text-slate-900">{formatValue(latest)}</p>
                            <p className="text-[11px] text-slate-500">평균 {formatValue(avg)}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  ) : null}

                  {analysisTechniques.includes("regression") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">회귀 요약</p>
                    {analysisRows.length < 2 || !analysisRegression ? (
                      <p className="mt-3 text-xs text-slate-500">회귀를 계산할 2개 이상의 시리즈가 필요합니다.</p>
                    ) : (
                      <div className="mt-3 space-y-2 text-sm text-slate-700">
                        <p>
                          종속변수: <span className="font-semibold">{analysisRows[1]?.seriesName}</span>
                        </p>
                        <p>
                          독립변수: <span className="font-semibold">{analysisRows[0]?.seriesName}</span>
                        </p>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[13px]">
                          <p>y = {analysisRegression.slope.toFixed(4)}x + {analysisRegression.intercept.toFixed(4)}</p>
                          <p className="mt-1">R² = {analysisRegression.r2.toFixed(4)}</p>
                          <p className="mt-1 text-xs text-slate-500">표본 수: {analysisRegression.n}</p>
                        </div>
                      </div>
                    )}
                  </div>
                  ) : null}

                  {analysisTechniques.includes("trend") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">추세 분석</p>
                    {!analysisTrend ? (
                      <p className="mt-3 text-xs text-slate-500">추세를 계산할 데이터가 부족합니다.</p>
                    ) : (
                      <div className="mt-3 space-y-2 text-sm text-slate-700">
                        <p>기울기(기간당): {analysisTrend.slope.toFixed(4)}</p>
                        <p>
                          시작값 {formatValue(analysisTrend.first)} → 최신값 {formatValue(analysisTrend.last)}
                        </p>
                        <p>
                          누적 변화율:{" "}
                          {analysisTrend.growthRate === null
                            ? "-"
                            : `${analysisTrend.growthRate >= 0 ? "+" : ""}${analysisTrend.growthRate.toFixed(2)}%`}
                        </p>
                        <p className="text-xs text-slate-500">표본 수: {analysisTrend.n}</p>
                      </div>
                    )}
                  </div>
                  ) : null}

                  {analysisTechniques.includes("volatility") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">변동성 분석</p>
                    {!analysisVolatility ? (
                      <p className="mt-3 text-xs text-slate-500">변동성을 계산할 데이터가 부족합니다.</p>
                    ) : (
                      <div className="mt-3 space-y-2 text-sm text-slate-700">
                        <p>평균: {formatValue(analysisVolatility.mean)}</p>
                        <p>표준편차: {formatValue(analysisVolatility.std)}</p>
                        <p>
                          변동계수(CV):{" "}
                          {analysisVolatility.cv === null ? "-" : `${analysisVolatility.cv.toFixed(2)}%`}
                        </p>
                        <p>
                          범위: {formatValue(analysisVolatility.min)} ~ {formatValue(analysisVolatility.max)}
                        </p>
                        <p className="text-xs text-slate-500">표본 수: {analysisVolatility.n}</p>
                      </div>
                    )}
                  </div>
                  ) : null}

                  {analysisTechniques.includes("anomaly") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">이상치 탐지</p>
                    {!analysisAnomaly ? (
                      <p className="mt-3 text-xs text-slate-500">이상치를 탐지할 데이터가 부족합니다.</p>
                    ) : (
                      <div className="mt-3 space-y-2 text-sm text-slate-700">
                        <p>
                          이상치 {analysisAnomaly.anomalyCount}건 / 전체 {analysisAnomaly.total}건
                        </p>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-2">
                          {analysisAnomaly.top.length === 0 ? (
                            <p className="text-xs text-slate-500">임계치(|z|≥2)를 넘는 이상치가 없습니다.</p>
                          ) : (
                            analysisAnomaly.top.map((item) => (
                              <p key={`anomaly-${item.label}`} className="text-xs text-slate-700">
                                {item.label}: z={item.z.toFixed(2)}
                              </p>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  ) : null}

                  {analysisTechniques.includes("seasonality") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">계절성 분석</p>
                    {!analysisSeasonality ? (
                      <p className="mt-3 text-xs text-slate-500">월별 계절성을 계산할 데이터가 부족합니다.</p>
                    ) : (
                      <div className="mt-3 space-y-2 text-sm text-slate-700">
                        <p>
                          최고 월: {analysisSeasonality.peak.month}월 ({formatValue(analysisSeasonality.peak.avg)})
                        </p>
                        <p>
                          최저 월: {analysisSeasonality.trough.month}월 ({formatValue(analysisSeasonality.trough.avg)})
                        </p>
                        <div className="mt-2 flex h-24 items-end gap-1">
                          {analysisSeasonality.monthly.map((item) => {
                            const maxAbs = Math.max(
                              ...analysisSeasonality.monthly.map((entry) => Math.abs(entry.avg)),
                              1,
                            );
                            const h = Math.max(6, (Math.abs(item.avg) / maxAbs) * 100);
                            return (
                              <div key={`season-${item.month}`} className="flex-1 text-center">
                                <div className="mx-auto w-full rounded-t bg-cyan-400/80" style={{ height: `${h}%` }} />
                                <p className="mt-1 text-[10px] text-slate-500">{item.month}</p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                  ) : null}

                  {analysisTechniques.includes("forecast") ? (
                  <div className="rounded-3xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-900">단기 예측</p>
                    {!analysisForecast ? (
                      <p className="mt-3 text-xs text-slate-500">예측을 계산할 데이터가 부족합니다.</p>
                    ) : (
                      <div className="mt-3 space-y-2 text-sm text-slate-700">
                        <p>다음 시점 예측값(최근 3개 평균): {formatValue(analysisForecast.next)}</p>
                        <p>최근 구간 변동성(표준편차): {formatValue(analysisForecast.recentStd)}</p>
                        <p className="text-xs text-slate-500">기반 표본 수: 최근 {analysisForecast.recentCount}개</p>
                      </div>
                    )}
                  </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      ) : activeTopic !== "trendChart" ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
          선택한 화면은 다음 단계에서 구현 예정입니다.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
          <div className="space-y-3 rounded-3xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">그래프 리스트</h3>
              <button
                onClick={() => {
                  setShowCreate(true);
                  setCreateError("");
                  setCreateStatus("");
                  setCreateSeriesQuery("");
                  setCreateFreqTab("M");
                  setCreateSeriesAxisMap({});
                }}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                그래프 추가
              </button>
            </div>
            {chartsLoading ? <p className="text-xs text-slate-500">불러오는 중...</p> : null}
            {chartsError ? <p className="text-xs text-rose-600">{chartsError}</p> : null}
            {chartActionError ? <p className="text-xs text-rose-600">{chartActionError}</p> : null}
            {!chartsLoading && charts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-xs text-slate-500">
                생성된 그래프가 없습니다. `그래프 추가`로 시작하세요.
              </div>
            ) : null}
            {charts.map((chart) => (
              <div
                key={chart.chartId}
                className={`relative w-full cursor-pointer rounded-2xl border px-3 py-3 text-left text-xs ${
                  selectedChartId === chart.chartId
                    ? "border-slate-900 bg-slate-50"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <div className="relative z-10 pointer-events-none">
                <p className="font-semibold text-slate-900">{chart.chartName}</p>
                <p className="mt-1 text-slate-500">
                  {chart.seriesCount}개 시리즈 · {new Date(chart.updatedAt).toLocaleDateString()}
                </p>
                <div className="relative z-20 mt-2 flex justify-end gap-1 pointer-events-auto" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => void handleOpenEditChartModal(chart)}
                    disabled={chartActionBusyId === chart.chartId}
                    className="rounded-full border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-60"
                  >
                    수정
                  </button>
                  <button
                    onClick={() => void handleDeleteChart(chart)}
                    disabled={chartActionBusyId === chart.chartId}
                    className="rounded-full border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                  >
                    삭제
                  </button>
                </div>
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  className="absolute inset-0 z-0 rounded-2xl"
                  onClick={() => setSelectedChartId(chart.chartId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedChartId(chart.chartId);
                    }
                  }}
                  aria-label={`그래프 선택: ${chart.chartName}`}
                />
              </div>
            ))}
          </div>

          <div className="space-y-3 rounded-3xl border border-slate-200 bg-white p-5">
            {!selectedChartId ? (
              <p className="text-sm text-slate-500">좌측에서 그래프를 선택하세요.</p>
            ) : detailLoading ? (
              <p className="text-sm text-slate-500">그래프를 불러오는 중...</p>
            ) : detailError ? (
              <p className="text-sm text-rose-600">{detailError}</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">{detailTitle}</h3>
                    <button
                      onClick={() => setShowDetailFullscreen(true)}
                      className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      차트 크게 보기
                    </button>
                </div>
                <span className="text-xs text-slate-500">
                  표시 중 {detailChartRows.length}/{detailSeries.length}개 시리즈
                </span>
                {renderDetailLegend()}
                {showDetailFullscreen ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">
                    전체 화면 모드에서 차트를 표시 중입니다.
                  </div>
                ) : (
                  renderDetailInteractiveChart()
                )}
                <div className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">기준선 (상세 화면 편집)</p>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setDetailReferenceLineMenu(null);
                          setDetailReferenceLineGuide(null);
                          setDetailReferenceLineDraggingId(null);
                          setDetailReferenceLinePlacing((prev) =>
                            prev === "horizontal" ? null : "horizontal",
                          );
                        }}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                          detailReferenceLinePlacing === "horizontal"
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        가로선 찍기
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDetailReferenceLineMenu(null);
                          setDetailReferenceLineGuide(null);
                          setDetailReferenceLineDraggingId(null);
                          setDetailReferenceLinePlacing((prev) => (prev === "vertical" ? null : "vertical"));
                        }}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                          detailReferenceLinePlacing === "vertical"
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        세로선 찍기
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSaveDetailReferenceLines()}
                        disabled={detailReferenceLineSaving}
                        className="rounded-full bg-slate-900 px-2.5 py-0.5 text-[10px] font-semibold text-white disabled:opacity-60"
                      >
                        저장
                      </button>
                    </div>
                  </div>
                  <p className={`mt-2 min-h-4 text-[11px] ${detailReferenceLineError ? "text-rose-600" : "invisible"}`}>
                    {detailReferenceLineError || "placeholder"}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showDetailFullscreen ? (
        <div className="fixed inset-0 z-[65] bg-slate-950/60 p-4">
          <div className="flex h-full w-full flex-col rounded-2xl border border-slate-200 bg-white p-4 md:p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">{detailTitle}</h3>
                <p className="text-xs text-slate-500">
                  표시 중 {detailChartRows.length}/{detailSeries.length}개 시리즈
                </p>
              </div>
              <button
                onClick={() => setShowDetailFullscreen(false)}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>
            {renderDetailLegend()}
            <div className="mt-3 flex-1">{renderDetailInteractiveChart()}</div>
          </div>
        </div>
      ) : null}

      {showEdit ? (
        <div className="fixed inset-0 z-[71] flex items-center justify-center bg-slate-950/45 p-6">
          <div className="h-[760px] max-h-[calc(100vh-48px)] w-full max-w-[1200px] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">그래프 수정</h3>
              <button
                onClick={resetEditModal}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr] lg:items-stretch">
              <div className="space-y-3">
                <label className="space-y-1 text-xs text-slate-600">
                  그래프 이름
                  <input
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>
                <div className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">시리즈 선택</p>
                    <button
                      onClick={() => handleOpenDeriveModal("edit")}
                      className="rounded-full border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      데이터 조작
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {availableFreqTabs.map((freq) => (
                      <button
                        key={`edit-freq-${freq}`}
                        onClick={() => {
                          if (selectedEditFreq && selectedEditFreq !== freq) {
                            setEditError("같은 주기의 데이터만 선택할 수 있습니다.");
                            return;
                          }
                          setEditError("");
                          setEditFreqTab(freq);
                        }}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                          editFreqTab === freq
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {freqLabelMap[freq]}
                      </button>
                    ))}
                  </div>
                  <input
                    value={editSeriesQuery}
                    onChange={(event) => setEditSeriesQuery(event.target.value)}
                    placeholder={`${freqLabelMap[editFreqTab]} 시리즈 검색`}
                    className="mt-2 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                  />
                  <div className="mt-2 h-72 space-y-2 overflow-auto pr-1">
                    {seriesLoading ? (
                      <p className="text-xs text-slate-500">목록 로딩 중...</p>
                    ) : (
                      filteredEditSeriesList.map((series) => (
                        <label
                          key={series.seriesId}
                          className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-700"
                        >
                          <input
                            type="checkbox"
                            checked={editSeriesIds.includes(series.seriesId)}
                            onChange={(event) => {
                              setEditError("");
                              setEditSeriesIds((prev) =>
                                event.target.checked
                                  ? [...prev, series.seriesId]
                                  : prev.filter((id) => id !== series.seriesId),
                              );
                              setEditSeriesAxisMap((prev) => {
                                if (event.target.checked) {
                                  return { ...prev, [series.seriesId]: prev[series.seriesId] ?? "left" };
                                }
                                const { [series.seriesId]: _removed, ...rest } = prev;
                                return rest;
                              });
                            }}
                          />
                          <span className="flex-1">
                            {series.sourceOrg === "derived" ? (
                              <span className="mr-1 text-[10px] font-semibold text-indigo-600">[파생]</span>
                            ) : null}
                            {series.seriesName}
                          </span>
                          {series.sourceOrg === "derived" ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleDeleteDerivedSeries(
                                  { seriesId: series.seriesId, seriesName: series.seriesName },
                                  "edit",
                                );
                              }}
                              disabled={deletingDerivedSeriesId === series.seriesId}
                              className="rounded-full border border-rose-200 px-2 py-0.5 text-[10px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                            >
                              삭제
                            </button>
                          ) : null}
                          <div
                            className="flex items-center gap-1"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setEditSeriesAxisMap((prev) => ({
                                  ...prev,
                                  [series.seriesId]: "left",
                                }))
                              }
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                                (editSeriesAxisMap[series.seriesId] ?? "left") === "left"
                                  ? "border-slate-900 bg-slate-900 text-white"
                                  : "border-slate-200 text-slate-500"
                              }`}
                            >
                              좌
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setEditSeriesAxisMap((prev) => ({
                                  ...prev,
                                  [series.seriesId]: "right",
                                }))
                              }
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                                (editSeriesAxisMap[series.seriesId] ?? "left") === "right"
                                  ? "border-slate-900 bg-slate-900 text-white"
                                  : "border-slate-200 text-slate-500"
                              }`}
                            >
                              우
                            </button>
                          </div>
                        </label>
                      ))
                    )}
                    {!seriesLoading && filteredEditSeriesList.length === 0 ? (
                      <p className="text-xs text-slate-500">검색 결과가 없습니다.</p>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="space-y-2 lg:flex lg:h-full lg:flex-col">
                <p className="text-xs font-semibold text-slate-700">미리보기</p>
                <div className="flex flex-wrap gap-1.5">
                  {editPreviewRows.map((series, index) => (
                    <span
                      key={`edit-preview-legend-${series.seriesId}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: series.lineColor || colorPalette[index % colorPalette.length] }}
                      />
                      {series.seriesName}
                      <button
                        onClick={() => {
                          setEditError("");
                          setEditSeriesIds((prev) => prev.filter((id) => id !== series.seriesId));
                          setEditSeriesAxisMap((prev) => {
                            const { [series.seriesId]: _removed, ...rest } = prev;
                            return rest;
                          });
                        }}
                        className="ml-1 rounded-full px-1 text-[11px] leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        aria-label={`${series.seriesName} 시리즈 선택 해제`}
                        title="선택 해제"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="overflow-x-auto rounded-2xl border border-slate-200 p-4 lg:flex-1 lg:min-h-0">
                  <svg
                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                    className="h-full w-full"
                    role="img"
                    aria-label="수정 그래프 미리보기"
                  >
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
                    {editPreviewRows.map((series, index) => (
                      <polyline
                        key={series.seriesId}
                        fill="none"
                        stroke={series.lineColor || colorPalette[index % colorPalette.length]}
                        strokeWidth={2.3}
                        points={buildPolyline(
                          series.values.map((v) => (Number.isFinite(v) ? v : editPreviewRange.min)),
                          editPreviewRange.min,
                          editPreviewRange.max,
                        )}
                      />
                    ))}
                    {editPreviewLabels.length > 0
                      ? editPreviewLabels.map((label, index) => {
                          const drawableWidth = chartWidth - padding.left - padding.right;
                          const x =
                            padding.left + (drawableWidth * index) / Math.max(editPreviewLabels.length - 1, 1);
                          const step = Math.ceil(editPreviewLabels.length / 8);
                          const shouldRender =
                            index === 0 || index === editPreviewLabels.length - 1 || index % step === 0;
                          if (!shouldRender) return null;
                          return (
                            <text key={label} x={x} y={chartHeight - 10} textAnchor="middle" fontSize="10" fill="#64748b">
                              {label.slice(2).replaceAll("-", ".")}
                            </text>
                          );
                        })
                      : null}
                  </svg>
                </div>
              </div>
            </div>
            <p className={`mt-3 min-h-4 text-xs ${editError ? "text-rose-600" : "invisible"}`}>
              {editError || "placeholder"}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={resetEditModal}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                취소
              </button>
              <button
                onClick={() => void handleUpdateChart()}
                disabled={!editChartId || chartActionBusyId === editChartId}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDerive ? (
        <div className="fixed inset-0 z-[72] flex items-center justify-center overflow-y-auto bg-slate-950/45 p-6">
          <div className="w-full max-w-[520px] rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">데이터 조작 (주기 변환 시리즈 생성)</h3>
              <button
                onClick={closeDeriveModal}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="space-y-1 text-xs text-slate-600">
                원본 시리즈
                <select
                  value={deriveSourceSeriesId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const nextSeries = deriveSourceOptions.find((item) => item.seriesId === nextId);
                    const nextSourceFreq = nextSeries?.freq ?? "M";
                    const nextTarget =
                      nextSourceFreq === "D"
                        ? "M"
                        : nextSourceFreq === "M"
                          ? "Q"
                          : nextSourceFreq === "Q"
                            ? "Y"
                            : "Y";
                    setDeriveSourceSeriesId(nextId);
                    setDeriveTargetFreq(nextTarget);
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                >
                  <option value="">시리즈를 선택하세요</option>
                  {deriveSourceOptions.map((item) => (
                    <option key={`derive-src-${item.seriesId}`} value={item.seriesId}>
                      [{freqLabelMap[item.freq]}] {item.seriesName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs text-slate-600">
                  대상 주기
                  <select
                    value={deriveTargetFreq}
                    onChange={(event) => setDeriveTargetFreq(event.target.value as "M" | "Q" | "Y")}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    {deriveTargetOptions.map((freq) => (
                      <option key={`derive-target-${freq}`} value={freq}>
                        {freqLabelMap[freq]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs text-slate-600">
                  집계 방식
                  <select
                    value={deriveAggRule}
                    onChange={(event) => setDeriveAggRule(event.target.value as "sum" | "avg" | "last")}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    <option value="sum">sum</option>
                    <option value="avg">avg</option>
                    <option value="last">last</option>
                  </select>
                </label>
              </div>
              <label className="space-y-1 text-xs text-slate-600">
                새 시리즈 이름
                <input
                  value={deriveSeriesName}
                  onChange={(event) => setDeriveSeriesName(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <p className={`min-h-4 text-xs ${deriveError ? "text-rose-600" : "invisible"}`}>
                {deriveError || "placeholder"}
              </p>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={closeDeriveModal}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                취소
              </button>
              <button
                onClick={() => void handleCreateDerivedSeries()}
                disabled={!deriveSourceSeriesId || deriveTargetOptions.length === 0 || deriveLoading}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                생성
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCreate ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="h-[760px] max-h-[calc(100vh-48px)] w-full max-w-[1200px] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">그래프 추가</h3>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setCreateSeriesQuery("");
                  setCreateFreqTab("M");
                  setCreateSeriesAxisMap({});
                }}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr] lg:items-stretch">
              <div className="space-y-3">
                <label className="space-y-1 text-xs text-slate-600">
                  그래프 이름
                  <input
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>
                <div className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">시리즈 선택</p>
                    <button
                      onClick={() => handleOpenDeriveModal("create")}
                      className="rounded-full border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      데이터 조작
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {availableFreqTabs.map((freq) => (
                      <button
                        key={`create-freq-${freq}`}
                        onClick={() => {
                          if (selectedCreateFreq && selectedCreateFreq !== freq) {
                            setCreateError("같은 주기의 데이터만 선택할 수 있습니다.");
                            return;
                          }
                          setCreateError("");
                          setCreateFreqTab(freq);
                        }}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                          createFreqTab === freq
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {freqLabelMap[freq]}
                      </button>
                    ))}
                  </div>
                  <input
                    value={createSeriesQuery}
                    onChange={(event) => setCreateSeriesQuery(event.target.value)}
                    placeholder={`${freqLabelMap[createFreqTab]} 시리즈 검색`}
                    className="mt-2 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                  />
                  <div className="mt-2 h-72 space-y-2 overflow-auto pr-1">
                    {seriesLoading ? (
                      <p className="text-xs text-slate-500">목록 로딩 중...</p>
                    ) : (
                      filteredCreateSeriesList.map((series) => (
                        <label
                          key={series.seriesId}
                          className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-700"
                        >
                          <input
                            type="checkbox"
                            checked={selectedSeriesIds.includes(series.seriesId)}
                            onChange={(event) => {
                              setCreateError("");
                              setSelectedSeriesIds((prev) =>
                                event.target.checked
                                  ? [...prev, series.seriesId]
                                  : prev.filter((id) => id !== series.seriesId),
                              );
                              setCreateSeriesAxisMap((prev) => {
                                if (event.target.checked) {
                                  return { ...prev, [series.seriesId]: prev[series.seriesId] ?? "left" };
                                }
                                const { [series.seriesId]: _removed, ...rest } = prev;
                                return rest;
                              });
                            }}
                          />
                          <span className="flex-1">
                            {series.sourceOrg === "derived" ? (
                              <span className="mr-1 text-[10px] font-semibold text-indigo-600">[파생]</span>
                            ) : null}
                            {series.seriesName}
                          </span>
                          {series.sourceOrg === "derived" ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleDeleteDerivedSeries(
                                  { seriesId: series.seriesId, seriesName: series.seriesName },
                                  "create",
                                );
                              }}
                              disabled={deletingDerivedSeriesId === series.seriesId}
                              className="rounded-full border border-rose-200 px-2 py-0.5 text-[10px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                            >
                              삭제
                            </button>
                          ) : null}
                          <div
                            className="flex items-center gap-1"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setCreateSeriesAxisMap((prev) => ({
                                  ...prev,
                                  [series.seriesId]: "left",
                                }))
                              }
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                                (createSeriesAxisMap[series.seriesId] ?? "left") === "left"
                                  ? "border-slate-900 bg-slate-900 text-white"
                                  : "border-slate-200 text-slate-500"
                              }`}
                            >
                              좌
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setCreateSeriesAxisMap((prev) => ({
                                  ...prev,
                                  [series.seriesId]: "right",
                                }))
                              }
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                                (createSeriesAxisMap[series.seriesId] ?? "left") === "right"
                                  ? "border-slate-900 bg-slate-900 text-white"
                                  : "border-slate-200 text-slate-500"
                              }`}
                            >
                              우
                            </button>
                          </div>
                        </label>
                      ))
                    )}
                    {!seriesLoading && filteredCreateSeriesList.length === 0 ? (
                      <p className="text-xs text-slate-500">검색 결과가 없습니다.</p>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="space-y-2 lg:flex lg:h-full lg:flex-col">
                <p className="text-xs font-semibold text-slate-700">미리보기</p>
                <div className="flex flex-wrap gap-1.5">
                  {previewRows.map((series, index) => (
                    <span
                      key={`create-preview-legend-${series.seriesId}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: series.lineColor || colorPalette[index % colorPalette.length] }}
                      />
                      {series.seriesName}
                      <button
                        onClick={() => {
                          setCreateError("");
                          setSelectedSeriesIds((prev) => prev.filter((id) => id !== series.seriesId));
                          setCreateSeriesAxisMap((prev) => {
                            const { [series.seriesId]: _removed, ...rest } = prev;
                            return rest;
                          });
                        }}
                        className="ml-1 rounded-full px-1 text-[11px] leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        aria-label={`${series.seriesName} 시리즈 선택 해제`}
                        title="선택 해제"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="overflow-x-auto rounded-2xl border border-slate-200 p-4 lg:flex-1 lg:min-h-0">
                  <svg
                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                    className="h-full w-full"
                    role="img"
                    aria-label="그래프 미리보기"
                  >
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
                    {previewRows.map((series, index) => (
                      <polyline
                        key={series.seriesId}
                        fill="none"
                        stroke={series.lineColor || colorPalette[index % colorPalette.length]}
                        strokeWidth={2.3}
                        points={buildPolyline(
                          series.values.map((v) => (Number.isFinite(v) ? v : previewRange.min)),
                          previewRange.min,
                          previewRange.max,
                        )}
                      />
                    ))}
                  </svg>
                </div>
              </div>
            </div>
            <p
              className={`mt-3 min-h-4 text-xs ${
                createError
                  ? "text-rose-600"
                  : createStatus
                    ? "text-emerald-600"
                    : "invisible"
              }`}
            >
              {createError || createStatus || "placeholder"}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowCreate(false);
                  setCreateSeriesQuery("");
                  setCreateFreqTab("M");
                  setCreateSeriesAxisMap({});
                }}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                취소
              </button>
              <button
                onClick={handleCreateChart}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showAnalysisCreate ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
          <div className="h-[760px] max-h-[calc(100vh-48px)] w-full max-w-[1200px] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">분석 추가</h3>
              <button
                onClick={closeAnalysisCreateModal}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr] lg:items-stretch">
              <div className="space-y-3">
                <label className="space-y-1 text-xs text-slate-600">
                  분석 이름
                  <input
                    value={analysisCreateName}
                    onChange={(event) => setAnalysisCreateName(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>
                <div className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">데이터 선택</p>
                    <button
                      onClick={() => handleOpenDeriveModal("analysisCreate")}
                      className="rounded-full border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      데이터 조작
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {freqOrder.map((freq) => (
                      <button
                        key={`analysis-create-modal-freq-${freq}`}
                        onClick={() => {
                          setAnalysisCreateError("");
                          setAnalysisCreateFreqTab(freq);
                        }}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                          analysisCreateFreqTab === freq
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {freqLabelMap[freq]}
                      </button>
                    ))}
                  </div>
                  <input
                    value={analysisCreateSeriesQuery}
                    onChange={(event) => setAnalysisCreateSeriesQuery(event.target.value)}
                    placeholder={`${freqLabelMap[analysisCreateFreqTab]} 시리즈 검색`}
                    className="mt-2 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                  />
                  <div className="mt-2 h-72 space-y-2 overflow-auto pr-1">
                    {analysisSeriesPoolLoading ? (
                      <p className="text-xs text-slate-500">목록 로딩 중...</p>
                    ) : (
                      analysisCreateSeriesOptions.map((series) => (
                        <label
                          key={`analysis-create-modal-series-${series.seriesId}`}
                          className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-700"
                        >
                          <input
                            type="checkbox"
                            checked={analysisCreateSeriesIds.includes(series.seriesId)}
                            onChange={(event) => {
                              setAnalysisCreateError("");
                              setAnalysisCreateSeriesIds((prev) =>
                                event.target.checked
                                  ? [...prev, series.seriesId]
                                  : prev.filter((id) => id !== series.seriesId),
                              );
                            }}
                          />
                          <span className="flex-1 truncate">
                            {series.sourceOrg === "derived" ? (
                              <span className="mr-1 text-[10px] font-semibold text-indigo-600">[파생]</span>
                            ) : null}
                            {series.seriesName}
                          </span>
                          {series.sourceOrg === "derived" ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleDeleteDerivedSeries(
                                  { seriesId: series.seriesId, seriesName: series.seriesName },
                                  "analysisCreate",
                                );
                              }}
                              disabled={deletingDerivedSeriesId === series.seriesId}
                              className="rounded-full border border-rose-200 px-2 py-0.5 text-[10px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                            >
                              삭제
                            </button>
                          ) : null}
                        </label>
                      ))
                    )}
                    {!analysisSeriesPoolLoading && analysisCreateSeriesOptions.length === 0 ? (
                      <p className="text-xs text-slate-500">검색 결과가 없습니다.</p>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="space-y-3 lg:flex lg:h-full lg:flex-col">
                <p className="text-xs font-semibold text-slate-700">분석 설정 및 미리보기</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1 text-xs text-slate-600">
                    <p>분석기법</p>
                    <div className="space-y-2">
                      {analysisTechniqueCategories.map((category) => (
                        <div key={`analysis-create-category-${category.categoryId}`}>
                          <p className="text-[10px] font-semibold text-slate-500">{category.categoryLabel}</p>
                          <div className="mt-1 grid grid-cols-2 gap-1">
                            {category.items.map((item) => (
                              <label
                                key={`analysis-create-modal-tech-${item.value}`}
                                className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700"
                              >
                                <input
                                  type="checkbox"
                                  checked={analysisCreateTechniques.includes(item.value)}
                                  onChange={(event) =>
                                    setAnalysisCreateTechniques((prev) =>
                                      event.target.checked
                                        ? [...prev, item.value]
                                        : prev.filter((value) => value !== item.value),
                                    )
                                  }
                                />
                                <span>{item.label}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4 lg:flex-1">
                  <p className="text-xs font-semibold text-slate-700">선택된 시리즈</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {analysisCreateSelectedSeries.map((series) => (
                      <span
                        key={`analysis-create-selected-${series.seriesId}`}
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                      >
                        {series.seriesName}
                        <button
                          onClick={() =>
                            setAnalysisCreateSeriesIds((prev) =>
                              prev.filter((id) => id !== series.seriesId),
                            )
                          }
                          className="rounded-full px-1 text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          title="선택 해제"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {analysisCreateSelectedSeries.length === 0 ? (
                      <p className="text-xs text-slate-500">선택된 시리즈가 없습니다.</p>
                    ) : null}
                  </div>
                  <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] text-slate-600">
                      선택 기법:{" "}
                      {analysisCreateTechniques.length
                        ? analysisCreateTechniques
                            .map((value) => analysisTechniqueOptions.find((item) => item.value === value)?.label ?? value)
                            .join(", ")
                        : "없음"}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-600">
                      기준 주기: {freqLabelMap[analysisCreateFreqTab]} / 조작: 파생 시리즈 생성
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <p
              className={`mt-3 min-h-4 text-xs ${
                analysisCreateError ? "text-rose-600" : "invisible"
              }`}
            >
              {analysisCreateError || "placeholder"}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={closeAnalysisCreateModal}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                취소
              </button>
              <button
                onClick={() => void handleCreateAnalysis()}
                disabled={analysisCreateBusy}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                {analysisCreateBusy ? "생성 중..." : "저장"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showAnalysisEdit ? (
        <div className="fixed inset-0 z-[71] flex items-center justify-center bg-slate-950/45 p-6">
          <div className="h-[760px] max-h-[calc(100vh-48px)] w-full max-w-[1200px] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">분석 수정</h3>
              <button
                onClick={closeAnalysisEditModal}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr] lg:items-stretch">
              <div className="space-y-3">
                <label className="space-y-1 text-xs text-slate-600">
                  분석 이름
                  <input
                    value={analysisEditName}
                    onChange={(event) => setAnalysisEditName(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>
                <div className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-700">데이터 선택</p>
                    <button
                      onClick={() => handleOpenDeriveModal("analysisEdit")}
                      className="rounded-full border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      데이터 조작
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {freqOrder.map((freq) => (
                      <button
                        key={`analysis-edit-modal-freq-${freq}`}
                        onClick={() => {
                          if (selectedAnalysisEditFreq && selectedAnalysisEditFreq !== freq) {
                            setAnalysisEditError("같은 주기의 데이터만 선택할 수 있습니다.");
                            return;
                          }
                          setAnalysisEditError("");
                          setAnalysisEditFreqTab(freq);
                        }}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                          analysisEditFreqTab === freq
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {freqLabelMap[freq]}
                      </button>
                    ))}
                  </div>
                  <input
                    value={analysisEditSeriesQuery}
                    onChange={(event) => setAnalysisEditSeriesQuery(event.target.value)}
                    placeholder={`${freqLabelMap[analysisEditFreqTab]} 시리즈 검색`}
                    className="mt-2 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
                  />
                  <div className="mt-2 h-72 space-y-2 overflow-auto pr-1">
                    {analysisSeriesPoolLoading ? (
                      <p className="text-xs text-slate-500">목록 로딩 중...</p>
                    ) : (
                      analysisEditSeriesOptions.map((series) => (
                        <label
                          key={`analysis-edit-modal-series-${series.seriesId}`}
                          className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-2 text-xs text-slate-700"
                        >
                          <input
                            type="checkbox"
                            checked={analysisEditSeriesIds.includes(series.seriesId)}
                            onChange={(event) => {
                              setAnalysisEditError("");
                              setAnalysisEditSeriesIds((prev) =>
                                event.target.checked
                                  ? [...prev, series.seriesId]
                                  : prev.filter((id) => id !== series.seriesId),
                              );
                            }}
                          />
                          <span className="flex-1 truncate">
                            {series.sourceOrg === "derived" ? (
                              <span className="mr-1 text-[10px] font-semibold text-indigo-600">[파생]</span>
                            ) : null}
                            {series.seriesName}
                          </span>
                          {series.sourceOrg === "derived" ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleDeleteDerivedSeries(
                                  { seriesId: series.seriesId, seriesName: series.seriesName },
                                  "analysisEdit",
                                );
                              }}
                              disabled={deletingDerivedSeriesId === series.seriesId}
                              className="rounded-full border border-rose-200 px-2 py-0.5 text-[10px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                            >
                              삭제
                            </button>
                          ) : null}
                        </label>
                      ))
                    )}
                    {!analysisSeriesPoolLoading && analysisEditSeriesOptions.length === 0 ? (
                      <p className="text-xs text-slate-500">검색 결과가 없습니다.</p>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="space-y-3 lg:flex lg:h-full lg:flex-col">
                <p className="text-xs font-semibold text-slate-700">분석 설정 및 미리보기</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1 text-xs text-slate-600">
                    <p>분석기법</p>
                    <div className="space-y-2">
                      {analysisTechniqueCategories.map((category) => (
                        <div key={`analysis-edit-category-${category.categoryId}`}>
                          <p className="text-[10px] font-semibold text-slate-500">{category.categoryLabel}</p>
                          <div className="mt-1 grid grid-cols-2 gap-1">
                            {category.items.map((item) => (
                              <label
                                key={`analysis-edit-modal-tech-${item.value}`}
                                className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700"
                              >
                                <input
                                  type="checkbox"
                                  checked={analysisEditTechniques.includes(item.value)}
                                  onChange={(event) =>
                                    setAnalysisEditTechniques((prev) =>
                                      event.target.checked
                                        ? [...prev, item.value]
                                        : prev.filter((value) => value !== item.value),
                                    )
                                  }
                                />
                                <span>{item.label}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4 lg:flex-1">
                  <p className="text-xs font-semibold text-slate-700">선택된 시리즈</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {analysisEditSelectedSeries.map((series) => (
                      <span
                        key={`analysis-edit-selected-${series.seriesId}`}
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                      >
                        {series.seriesName}
                        <button
                          onClick={() =>
                            setAnalysisEditSeriesIds((prev) =>
                              prev.filter((id) => id !== series.seriesId),
                            )
                          }
                          className="rounded-full px-1 text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          title="선택 해제"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {analysisEditSelectedSeries.length === 0 ? (
                      <p className="text-xs text-slate-500">선택된 시리즈가 없습니다.</p>
                    ) : null}
                  </div>
                  <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] text-slate-600">
                      기준 주기: {freqLabelMap[analysisEditFreqTab]} / 조작: 파생 시리즈 생성
                    </p>
                    <p className="mt-1 text-[11px] text-slate-600">
                      선택 기법:{" "}
                      {analysisEditTechniques.length
                        ? analysisEditTechniques
                            .map((value) => analysisTechniqueOptions.find((item) => item.value === value)?.label ?? value)
                            .join(", ")
                        : "없음"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <p className={`mt-3 min-h-4 text-xs ${analysisEditError ? "text-rose-600" : "invisible"}`}>
              {analysisEditError || "placeholder"}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={closeAnalysisEditModal}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                취소
              </button>
              <button
                onClick={() => void handleUpdateAnalysis()}
                disabled={!analysisEditChartId || analysisEditBusy}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

