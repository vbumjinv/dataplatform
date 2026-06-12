"use client";

import { useEffect, useMemo, useState } from "react";

type SeriesMeta = {
  seriesId: string;
  seriesNameKo: string | null;
  unitName: string | null;
  freqCd: string | null;
  domainLarge: string | null;
  domainSmall: string | null;
  isRepresentative: boolean;
};

type TimeSeriesPoint = {
  ds: string;
  y: number;
};

type LlmForecastPoint = {
  ds: string;
  yhat: number;
  actual: number;
};

type RunResult = {
  meta: SeriesMeta;
  seriesId: string;
  horizonMonths: number;
  trainCount: number;
  testCount: number;
  trainStart: string | null;
  trainEnd: string | null;
  testStart: string | null;
  testEnd: string | null;
  model: string;
  llmProvider?: "ollama" | "openai" | null;
  llmModel?: string | null;
  codeInterpreterUsed?: boolean;
  totalElapsedMs?: number | null;
  llmElapsedMs?: number | null;
  summaryElapsedMs?: number | null;
  forecastTokenUsage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  summaryTokenUsage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  totalTokenUsage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  summaryLlmModel?: string | null;
  llmSummary?: string | null;
  llmWarning?: string | null;
  llmSummaryEnabled?: boolean;
  requestedForecastMethod?: string | null;
  metrics: { mae: number | null; rmse: number | null; mape: number | null };
  compositeScore?: {
    value: number | null;
    grade: "S" | "A" | "B" | "C" | "D" | null;
    sampleCount: number;
    directionAccuracy: number | null;
    note: string | null;
  } | null;
  history: TimeSeriesPoint[];
  forecast: LlmForecastPoint[];
  llmPrompt: string | null;
  llmRawOutput: string | null;
  llmCodeInterpreterTrace?: Array<{
    label: string;
    content: string;
  }> | null;
};

type PromptPreviewResult = {
  ok?: boolean;
  error?: string;
  prompt?: string;
};

type RunPendingResult = {
  ok?: boolean;
  error?: string;
  pending?: boolean;
  pollResponseId?: string;
  pollStatus?: string;
};

const LLM_PROVIDERS = ["ollama", "openai"] as const;
const OLLAMA_MODELS = [
  "qwen3:8b",
  "gemma3:4b",
  "gemma4:e4b",
  "llama3.2:latest",
] as const;
const OPENAI_MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4.1-nano",
] as const;
const FORECAST_METHOD_OPTIONS = [
  { value: "prophet", label: "Prophet" },
  { value: "linear_trend", label: "Linear Trend" },
  { value: "arima", label: "ARIMA" },
  { value: "sarima", label: "SARIMA" },
  { value: "chronos_2", label: "Chronos-2" },
  { value: "chronos_bolt_base", label: "Chronos-Bolt Base" },
  { value: "timesfm_2_5_200m", label: "TimesFM 2.5 200M" },
] as const;
const FORECAST_STRENGTH_OPTIONS = [
  { value: "relaxed", label: "완화 (유연)" },
  { value: "balanced", label: "균형 (기본)" },
  { value: "strict", label: "엄격 (기법 고정 우선)" },
] as const;

const chartWidth = 980;
const chartHeight = 340;
const padding = { top: 20, right: 52, bottom: 36, left: 52 };
const yTickCount = 5;

const formatNum = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value)
    : "-";

const formatMs = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(2)}초` : "-";

export function AiForecastTest2PageContent({
  openAiOnly = false,
  pageTitle = "AI 분석 테스트 2",
  useCodeInterpreterForOpenAi = false,
  executionMode = "llm_direct",
}: {
  openAiOnly?: boolean;
  pageTitle?: string;
  useCodeInterpreterForOpenAi?: boolean;
  executionMode?: "llm_direct" | "llm_select_python";
}) {
  const [seriesQuery, setSeriesQuery] = useState("");
  const [representativeOnly, setRepresentativeOnly] = useState(true);
  const [seriesList, setSeriesList] = useState<SeriesMeta[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState("");
  const [selectedSeriesId, setSelectedSeriesId] = useState("");
  const [horizonMonths, setHorizonMonths] = useState(12);
  const [llmProvider, setLlmProvider] = useState<(typeof LLM_PROVIDERS)[number]>(
    openAiOnly ? "openai" : "ollama",
  );
  const [ollamaModel, setOllamaModel] = useState<(typeof OLLAMA_MODELS)[number]>("qwen3:8b");
  const [openAiModel, setOpenAiModel] = useState("gpt-4o-mini");
  const [temperatureInput, setTemperatureInput] = useState("");
  const [optionsModalOpen, setOptionsModalOpen] = useState(false);
  const [enableLlmSummary, setEnableLlmSummary] = useState(false);
  const [forecastMethodPreset, setForecastMethodPreset] = useState<
    (typeof FORECAST_METHOD_OPTIONS)[number]["value"]
  >("prophet");
  const [forecastInstructionStrength, setForecastInstructionStrength] = useState<
    (typeof FORECAST_STRENGTH_OPTIONS)[number]["value"]
  >("balanced");
  const [running, setRunning] = useState(false);
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
  const [promptPreviewLoading, setPromptPreviewLoading] = useState(false);
  const [promptPreviewText, setPromptPreviewText] = useState("");
  const [promptPreviewError, setPromptPreviewError] = useState("");
  const [runError, setRunError] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [latestPoint, setLatestPoint] = useState<TimeSeriesPoint | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const effectiveProvider = openAiOnly ? "openai" : llmProvider;

  const selectedMeta = useMemo(
    () => seriesList.find((item) => item.seriesId === selectedSeriesId) ?? result?.meta ?? null,
    [result?.meta, selectedSeriesId, seriesList],
  );

  const chartSeries = useMemo(() => {
    if (!result) return null;
    const byDate = new Map<string, { ds: string; actual: number | null; forecast: number | null }>();
    result.history.forEach((item) => {
      byDate.set(item.ds, { ds: item.ds, actual: item.y, forecast: null });
    });
    result.forecast.forEach((item) => {
      const prev = byDate.get(item.ds);
      byDate.set(item.ds, {
        ds: item.ds,
        actual: item.actual ?? prev?.actual ?? null,
        forecast: item.yhat,
      });
    });
    const all = Array.from(byDate.values()).sort((a, b) => a.ds.localeCompare(b.ds));
    const values = all.flatMap((item) => [item.actual, item.forecast]).filter((v): v is number => v != null);
    if (!values.length) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1e-6, max - min);
    const xStep = (chartWidth - padding.left - padding.right) / Math.max(1, all.length - 1);
    const toY = (value: number) =>
      padding.top + ((max - value) / span) * (chartHeight - padding.top - padding.bottom);

    const actualPoints = all
      .map((item, index) => (item.actual == null ? null : `${padding.left + index * xStep},${toY(item.actual)}`))
      .filter((item): item is string => item != null)
      .join(" ");
    const forecastPoints = all
      .map((item, index) =>
        item.forecast == null ? null : `${padding.left + index * xStep},${toY(item.forecast)}`,
      )
      .filter((item): item is string => item != null)
      .join(" ");

    const forecastDates = new Set(result.forecast.map((item) => item.ds));
    const forecastIndices = all
      .map((item, index) => (forecastDates.has(item.ds) ? index : -1))
      .filter((index) => index >= 0);
    const xLabelStep = Math.max(1, Math.floor(all.length / 8));
    const xLabels = all.filter((_, idx) => idx % xLabelStep === 0);
    const yTicks = Array.from({ length: yTickCount }, (_, index) => {
      if (yTickCount <= 1) return min;
      const ratio = index / (yTickCount - 1);
      return max - (max - min) * ratio;
    }).map((value) => ({ value, y: toY(value) }));

    return {
      all,
      min,
      max,
      actualPoints,
      forecastPoints,
      xStep,
      toY,
      xLabels,
      yTicks,
      forecastStartIndex: forecastIndices.length ? Math.min(...forecastIndices) : null,
      forecastEndIndex: forecastIndices.length ? Math.max(...forecastIndices) : null,
    };
  }, [result]);

  const hoveredDatum = useMemo(() => {
    if (!chartSeries || hoveredIndex == null) return null;
    const row = chartSeries.all[hoveredIndex];
    if (!row) return null;
    const x = padding.left + chartSeries.xStep * hoveredIndex;
    return { ...row, x };
  }, [chartSeries, hoveredIndex]);

  const fetchSeriesList = async () => {
    setSeriesLoading(true);
    setSeriesError("");
    try {
      const response = await fetch(
        `/api/ai-forecast/series-list?q=${encodeURIComponent(seriesQuery)}&representativeOnly=${
          representativeOnly ? "true" : "false"
        }`,
      );
      const payload = (await response.json()) as { ok?: boolean; error?: string; items?: SeriesMeta[] };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "시계열 목록 조회에 실패했습니다.");
      setSeriesList(payload.items ?? []);
    } catch (error) {
      setSeriesError(error instanceof Error ? error.message : "시계열 목록 조회에 실패했습니다.");
    } finally {
      setSeriesLoading(false);
    }
  };

  const runForecast = async (customPrompt?: string) => {
    if (!selectedSeriesId) {
      setRunError("시계열을 먼저 선택해주세요.");
      return;
    }
    setRunning(true);
    setRunError("");
    setRunStatus("");
    setResult(null);
    try {
      const runStartedAt = Date.now();
      const forecastMethod = forecastMethodPreset;
      const normalizedCustomPrompt = (customPrompt ?? "").trim();
      const useAsyncPolling = useCodeInterpreterForOpenAi && effectiveProvider === "openai";
      const baseRequestBody = {
        seriesId: selectedSeriesId,
        horizonMonths,
        executionMode,
        useCodeInterpreter:
          useCodeInterpreterForOpenAi && effectiveProvider === "openai",
        enableLlmSummary,
        forecastMethod,
        forecastInstructionStrength,
        provider: effectiveProvider,
        ollamaModel,
        openaiModel: openAiModel,
        temperature:
          temperatureInput.trim().length > 0 && Number.isFinite(Number(temperatureInput))
            ? Number(temperatureInput)
            : undefined,
        customPrompt: normalizedCustomPrompt.length > 0 ? normalizedCustomPrompt : undefined,
      };
      let currentPollResponseId: string | null = null;
      let pollCount = 0;
      while (true) {
        const response = await fetch("/api/ai-forecast-llm/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseRequestBody,
            asyncExecution: useAsyncPolling && !currentPollResponseId,
            pollResponseId: currentPollResponseId ?? undefined,
          }),
        });
        const payload = (await response.json()) as RunPendingResult & RunResult;
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "LLM 예측 실행에 실패했습니다.");
        }
        if (payload.pending) {
          if (!payload.pollResponseId) {
            throw new Error("비동기 작업 ID를 찾지 못했습니다.");
          }
          currentPollResponseId = payload.pollResponseId;
          pollCount += 1;
          if (pollCount > 240) {
            throw new Error("응답 대기 시간이 너무 길어 실행을 중단했습니다.");
          }
          setRunStatus(`Code Interpreter 실행 중... (${payload.pollStatus ?? "in_progress"})`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        setRunStatus("");
        if (useAsyncPolling) {
          const wallElapsedMs = Date.now() - runStartedAt;
          setResult({
            ...payload,
            totalElapsedMs: wallElapsedMs,
            llmElapsedMs: wallElapsedMs,
          });
        } else {
          setResult(payload);
        }
        break;
      }
    } catch (error) {
      setRunStatus("");
      setRunError(error instanceof Error ? error.message : "LLM 예측 실행에 실패했습니다.");
    } finally {
      setRunning(false);
    }
  };

  const openPromptPreview = async () => {
    if (!selectedSeriesId || promptPreviewLoading) return;
    setPromptPreviewOpen(true);
    setPromptPreviewLoading(true);
    setPromptPreviewError("");
    setPromptPreviewText("");
    try {
      const response = await fetch("/api/ai-forecast-llm/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewOnly: true,
          seriesId: selectedSeriesId,
          horizonMonths,
          executionMode,
          useCodeInterpreter:
            useCodeInterpreterForOpenAi && effectiveProvider === "openai",
          forecastMethod: forecastMethodPreset,
          forecastInstructionStrength,
          provider: effectiveProvider,
          ollamaModel,
          openaiModel: openAiModel,
          temperature:
            temperatureInput.trim().length > 0 && Number.isFinite(Number(temperatureInput))
              ? Number(temperatureInput)
              : undefined,
        }),
      });
      const payload = (await response.json()) as PromptPreviewResult;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "프롬프트 미리보기를 불러오지 못했습니다.");
      }
      setPromptPreviewText(payload.prompt ?? "");
    } catch (error) {
      setPromptPreviewError(
        error instanceof Error ? error.message : "프롬프트 미리보기를 불러오지 못했습니다.",
      );
    } finally {
      setPromptPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedSeriesId) {
      setLatestPoint(null);
      setDetailError("");
      return;
    }
    const fetchDetail = async () => {
      setDetailLoading(true);
      setDetailError("");
      try {
        const response = await fetch(
          `/api/ai-forecast/series-data?seriesId=${encodeURIComponent(selectedSeriesId)}`,
        );
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
          latest?: TimeSeriesPoint | null;
        };
        if (!response.ok || !payload.ok) throw new Error(payload.error || "시계열 상세 조회 실패");
        setLatestPoint(payload.latest ?? null);
      } catch (error) {
        setDetailError(error instanceof Error ? error.message : "시계열 상세 조회 실패");
        setLatestPoint(null);
      } finally {
        setDetailLoading(false);
      }
    };
    void fetchDetail();
  }, [selectedSeriesId]);

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">{pageTitle}</h2>
        <p className="mt-2 text-sm text-slate-600">
          선택 시계열을 Ollama/OpenAI에 직접 전달해 미래 값을 예측하고, holdout 성능을 비교하는 PoC 화면입니다. LLM 요약은 옵션 활성화 시에만 수행됩니다.
        </p>
        {useCodeInterpreterForOpenAi ? (
          <p className="mt-1 text-xs text-blue-700">
            OpenAI 선택 시 code interpreter 실행 경로를 사용합니다.
          </p>
        ) : null}
      </header>

      <div className="rounded-3xl border border-slate-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.5fr_1fr_auto_auto]">
          <input
            value={seriesQuery}
            onChange={(e) => setSeriesQuery(e.target.value)}
            placeholder="시리즈 ID/한글명 검색"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={representativeOnly}
              onChange={(e) => setRepresentativeOnly(e.target.checked)}
            />
            대표 시계열만
          </label>
          <button
            onClick={() => void fetchSeriesList()}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            {seriesLoading ? "조회 중..." : "시계열 조회"}
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">제공자</span>
            {openAiOnly ? (
              <span className="rounded-lg border border-slate-200 px-2 py-2 text-sm text-slate-700">
                openai
              </span>
            ) : (
              <select
                value={llmProvider}
                onChange={(e) => setLlmProvider(e.target.value as (typeof LLM_PROVIDERS)[number])}
                className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
              >
                {LLM_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            )}
            <span className="text-xs text-slate-500">LLM 모델</span>
            {effectiveProvider === "openai" ? (
              <>
                <select
                  value={OPENAI_MODELS.includes(openAiModel as (typeof OPENAI_MODELS)[number]) ? openAiModel : "custom"}
                  onChange={(e) => {
                    if (e.target.value === "custom") return;
                    setOpenAiModel(e.target.value);
                  }}
                  className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
                >
                  {OPENAI_MODELS.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value="custom">직접입력</option>
                </select>
                <input
                  value={openAiModel}
                  onChange={(e) => setOpenAiModel(e.target.value)}
                  placeholder="예: gpt-4o-mini"
                  className="w-36 rounded-lg border border-slate-200 px-2 py-2 text-sm"
                />
              </>
            ) : (
              <select
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value as (typeof OLLAMA_MODELS)[number])}
                className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
              >
                {OLLAMA_MODELS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <span className="text-xs text-slate-500">예측개월</span>
            <input
              type="number"
              min={1}
              max={24}
              value={horizonMonths}
              onChange={(e) => setHorizonMonths(Math.max(1, Math.min(24, Number(e.target.value) || 12)))}
              className="w-20 rounded-lg border border-slate-200 px-2 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => setOptionsModalOpen(true)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              옵션 설정
            </button>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={enableLlmSummary}
                onChange={(e) => setEnableLlmSummary(e.target.checked)}
              />
              LLM 요약 사용
            </label>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          옵션: 기법 {FORECAST_METHOD_OPTIONS.find((item) => item.value === forecastMethodPreset)?.label} / 강도{" "}
          {FORECAST_STRENGTH_OPTIONS.find((item) => item.value === forecastInstructionStrength)?.label} /
          temperature {temperatureInput.trim() ? temperatureInput : "기본값"}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          temperature를 비워두면 모델 기본값을 사용합니다. 일부 모델은 temperature 변경을 지원하지 않아 자동으로 기본값으로 재시도됩니다.
        </p>
        {seriesError ? <p className="mt-3 text-sm text-rose-600">{seriesError}</p> : null}

        <div className="mt-4 max-h-64 overflow-auto rounded-xl border border-slate-200">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-2 py-2">선택</th>
                <th className="px-2 py-2">series_id</th>
                <th className="px-2 py-2">시리즈명</th>
                <th className="px-2 py-2">단위</th>
                <th className="px-2 py-2">주기</th>
              </tr>
            </thead>
            <tbody>
              {seriesList.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-slate-500" colSpan={5}>
                    조회 결과가 없습니다.
                  </td>
                </tr>
              ) : (
                seriesList.map((item) => (
                  <tr key={item.seriesId} className="border-t border-slate-100">
                    <td className="px-2 py-2">
                      <input
                        type="radio"
                        checked={selectedSeriesId === item.seriesId}
                        onChange={() => setSelectedSeriesId(item.seriesId)}
                      />
                    </td>
                    <td className="px-2 py-2">{item.seriesId}</td>
                    <td className="px-2 py-2">{item.seriesNameKo ?? "-"}</td>
                    <td className="px-2 py-2">{item.unitName ?? "-"}</td>
                    <td className="px-2 py-2">{item.freqCd ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => void openPromptPreview()}
            disabled={!selectedSeriesId || promptPreviewLoading}
            className="rounded-full border border-slate-300 px-5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {promptPreviewLoading ? "프롬프트 로딩..." : "프롬프트 미리보기"}
          </button>
          <button
            onClick={() => void runForecast()}
            disabled={!selectedSeriesId || running}
            className="rounded-full bg-slate-900 px-5 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {running ? "LLM 예측 실행 중..." : "LLM 예측 실행"}
          </button>
        </div>
        {runStatus ? <p className="mt-3 text-sm text-slate-600">{runStatus}</p> : null}
        {runError ? <p className="mt-3 text-sm text-rose-600">{runError}</p> : null}
      </div>

      {selectedMeta ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6">
          <h3 className="text-base font-semibold text-slate-900">선택 시계열 정보</h3>
          <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 lg:grid-cols-2">
            <p>
              <span className="font-semibold">시계열:</span> {selectedMeta.seriesNameKo ?? "-"} (
              {selectedMeta.seriesId})
            </p>
            <p>
              <span className="font-semibold">주기/단위:</span> {selectedMeta.freqCd ?? "-"} /{" "}
              {selectedMeta.unitName ?? "-"}
            </p>
            <p>
              <span className="font-semibold">최근 값:</span>{" "}
              {detailLoading ? "조회 중..." : latestPoint ? `${formatNum(latestPoint.y)} (${latestPoint.ds})` : "-"}
            </p>
          </div>
          {detailError ? <p className="mt-2 text-sm text-rose-600">{detailError}</p> : null}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">과거 + LLM 예측 그래프</h3>
            <p className="mb-2 text-xs text-slate-600">
              모델: {result.model}
              {result.llmProvider ? ` [${result.llmProvider}]` : ""}
              {result.llmModel ? ` (${result.llmModel})` : ""} / MAE: {formatNum(result.metrics.mae)} / RMSE: {formatNum(result.metrics.rmse)} /
              MAPE: {formatNum(result.metrics.mape)} / 종합점수: {formatNum(result.compositeScore?.value)}
              {result.compositeScore?.grade ? ` (${result.compositeScore.grade})` : ""}
            </p>
            <p className="mb-2 text-xs text-slate-500">
              Code Interpreter:{" "}
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  result.codeInterpreterUsed
                    ? "border border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border border-slate-300 bg-slate-100 text-slate-700"
                }`}
              >
                {result.codeInterpreterUsed ? "ON" : "OFF"}
              </span>
            </p>
            <p className="mb-2 text-xs text-slate-500">
              LLM 내부 예측 기법 지시: {result.requestedForecastMethod ?? "자동"}
            </p>
            <p className="mb-2 text-xs text-slate-500">
              수행시간: 총 {formatMs(result.totalElapsedMs)} / 예측 LLM {formatMs(result.llmElapsedMs)}
              {result.llmSummaryEnabled &&
              result.summaryElapsedMs != null &&
              Number.isFinite(result.summaryElapsedMs)
                ? ` / 요약 Ollama ${formatMs(result.summaryElapsedMs)}`
                : ""}
            </p>
            <p className="mb-2 text-xs text-slate-500">
              토큰(예측): prompt {formatNum(result.forecastTokenUsage?.promptTokens)} / completion{" "}
              {formatNum(result.forecastTokenUsage?.completionTokens)} / total{" "}
              {formatNum(result.forecastTokenUsage?.totalTokens)}
            </p>
            <p className="mb-2 text-xs text-slate-500">
              토큰(요약):{" "}
              {result.llmSummaryEnabled
                ? `prompt ${formatNum(result.summaryTokenUsage?.promptTokens)} / completion ${formatNum(result.summaryTokenUsage?.completionTokens)} / total ${formatNum(result.summaryTokenUsage?.totalTokens)}`
                : "비활성"}{" "}
              / 합계 total{" "}
              {formatNum(result.totalTokenUsage?.totalTokens)}
            </p>
            <p className="mb-2 text-xs text-slate-500">
              방향정확도: {formatNum(result.compositeScore?.directionAccuracy)}% / 평가표본:{" "}
              {formatNum(result.compositeScore?.sampleCount)} /{" "}
              {result.compositeScore?.note ?? "종합점수는 MAE/RMSE/MAPE + 편향 + 방향정확도로 계산합니다."}
            </p>
            {chartSeries ? (
              <svg
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                className="w-full rounded-xl border border-slate-200 bg-white"
                onMouseLeave={() => setHoveredIndex(null)}
                onMouseMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const xInViewBox = ((event.clientX - rect.left) / rect.width) * chartWidth;
                  const drawableWidth = chartWidth - padding.left - padding.right;
                  const rawIndex =
                    ((xInViewBox - padding.left) / Math.max(drawableWidth, 1)) *
                    Math.max(1, chartSeries.all.length - 1);
                  const index = Math.round(rawIndex);
                  const clamped = Math.max(0, Math.min(chartSeries.all.length - 1, index));
                  setHoveredIndex(clamped);
                }}
              >
                {chartSeries.yTicks.map((tick, idx) => (
                  <g key={`ytick-${idx}`}>
                    <line
                      x1={padding.left}
                      y1={tick.y}
                      x2={chartWidth - padding.right}
                      y2={tick.y}
                      stroke="#e2e8f0"
                      strokeDasharray="3 3"
                    />
                    <text x={padding.left - 8} y={tick.y + 3} textAnchor="end" fontSize="10" fill="#64748b">
                      {formatNum(tick.value)}
                    </text>
                  </g>
                ))}
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
                {chartSeries.forecastStartIndex != null && chartSeries.forecastEndIndex != null ? (
                  <rect
                    x={padding.left + chartSeries.forecastStartIndex * chartSeries.xStep}
                    y={padding.top}
                    width={Math.max(
                      2,
                      (chartSeries.forecastEndIndex - chartSeries.forecastStartIndex) * chartSeries.xStep,
                    )}
                    height={chartHeight - padding.top - padding.bottom}
                    fill="#fef3c7"
                    fillOpacity="0.5"
                  />
                ) : null}
                <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={chartSeries.actualPoints} />
                <polyline
                  fill="none"
                  stroke="#dc2626"
                  strokeWidth="2"
                  strokeDasharray="6 4"
                  points={chartSeries.forecastPoints}
                />
                <text x={padding.left} y={14} fontSize="10" fill="#2563eb">
                  actual
                </text>
                <text x={padding.left + 55} y={14} fontSize="10" fill="#dc2626">
                  forecast
                </text>
                {chartSeries.xLabels.map((item) => {
                  const idx = chartSeries.all.findIndex((it) => it.ds === item.ds);
                  const x = padding.left + idx * chartSeries.xStep;
                  return (
                    <text key={`xlabel-${item.ds}`} x={x - 14} y={chartHeight - 10} fontSize="10" fill="#64748b">
                      {item.ds.slice(0, 7)}
                    </text>
                  );
                })}
                {hoveredDatum ? (
                  <line
                    x1={hoveredDatum.x}
                    y1={padding.top}
                    x2={hoveredDatum.x}
                    y2={chartHeight - padding.bottom}
                    stroke="#94a3b8"
                    strokeDasharray="3 3"
                  />
                ) : null}
              </svg>
            ) : (
              <p className="text-sm text-slate-500">그래프 데이터가 없습니다.</p>
            )}
            {hoveredDatum ? (
              <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                <span className="font-semibold">{hoveredDatum.ds}</span>
                <span className="ml-3">actual: {formatNum(hoveredDatum.actual)}</span>
                <span className="ml-3">forecast: {formatNum(hoveredDatum.forecast)}</span>
              </div>
            ) : null}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">예측 결과 (월별)</h3>
            <div className="max-h-72 overflow-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2 py-2">날짜</th>
                    <th className="px-2 py-2">실제값(holdout)</th>
                    <th className="px-2 py-2">예측값(LLM)</th>
                    <th className="px-2 py-2">오차</th>
                  </tr>
                </thead>
                <tbody>
                  {result.forecast.map((item) => (
                    <tr key={item.ds} className="border-t border-slate-100">
                      <td className="px-2 py-2">{item.ds}</td>
                      <td className="px-2 py-2">{formatNum(item.actual)}</td>
                      <td className="px-2 py-2">{formatNum(item.yhat)}</td>
                      <td className="px-2 py-2">{formatNum(item.yhat - item.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">
              LLM 요약 (Ollama{result.summaryLlmModel ? `: ${result.summaryLlmModel}` : ""})
            </h3>
            {result.llmWarning ? <p className="mb-2 text-sm text-amber-600">{result.llmWarning}</p> : null}
            {result.llmSummaryEnabled ? (
              <>
                <pre className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                  {result.llmSummary ?? "요약 결과가 없습니다."}
                </pre>
              </>
            ) : (
              <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                LLM 요약 옵션이 비활성화되어 요약을 실행하지 않았습니다.
              </p>
            )}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">LLM 전달 프롬프트 원문</h3>
            <pre className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-800">
              {result.llmPrompt ?? "프롬프트 원문이 없습니다."}
            </pre>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">LLM 원문 응답</h3>
            <pre className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-800">
              {result.llmRawOutput ?? "원문 응답이 없습니다."}
            </pre>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">
              Code Interpreter 실행 코드/로그
            </h3>
            {result.codeInterpreterUsed ? (
              result.llmCodeInterpreterTrace && result.llmCodeInterpreterTrace.length > 0 ? (
                <div className="space-y-3">
                  {result.llmCodeInterpreterTrace.map((trace, idx) => (
                    <div
                      key={`${trace.label}-${idx}`}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                    >
                      <p className="mb-2 text-xs font-semibold text-slate-600">{trace.label}</p>
                      <pre className="whitespace-pre-wrap text-xs text-slate-800">{trace.content}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  실행 로그를 찾지 못했습니다. (모델이 중간 코드를 노출하지 않는 경우가 있습니다.)
                </p>
              )
            ) : (
              <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                Code Interpreter가 OFF라서 표시할 실행 코드/로그가 없습니다.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {promptPreviewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-4xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">프롬프트 미리보기</h3>
              <button
                type="button"
                onClick={() => setPromptPreviewOpen(false)}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>
            {promptPreviewError ? (
              <p className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {promptPreviewError}
              </p>
            ) : null}
            <textarea
              value={promptPreviewText}
              onChange={(e) => setPromptPreviewText(e.target.value)}
              className="h-[60vh] w-full resize-none overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              placeholder={promptPreviewLoading ? "불러오는 중..." : "표시할 프롬프트가 없습니다."}
              disabled={promptPreviewLoading}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPromptPreviewOpen(false)}
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                닫기
              </button>
              <button
                type="button"
                onClick={() => {
                  setPromptPreviewOpen(false);
                  void runForecast(promptPreviewText);
                }}
                disabled={running || promptPreviewLoading || !selectedSeriesId}
                className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                수정 프롬프트로 실행
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {optionsModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">옵션 설정</h3>
              <button
                type="button"
                onClick={() => setOptionsModalOpen(false)}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  예측 기법 지시
                </label>
                <select
                  value={forecastMethodPreset}
                  onChange={(e) =>
                    setForecastMethodPreset(
                      e.target.value as (typeof FORECAST_METHOD_OPTIONS)[number]["value"],
                    )
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                >
                  {FORECAST_METHOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  기법 지시 강도
                </label>
                <select
                  value={forecastInstructionStrength}
                  onChange={(e) =>
                    setForecastInstructionStrength(
                      e.target.value as (typeof FORECAST_STRENGTH_OPTIONS)[number]["value"],
                    )
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                >
                  {FORECAST_STRENGTH_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">temperature</label>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  value={temperatureInput}
                  onChange={(e) => setTemperatureInput(e.target.value)}
                  placeholder="기본값"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500">
                  비워두면 모델 기본값을 사용합니다.
                </p>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setForecastInstructionStrength("balanced");
                  setTemperatureInput("");
                }}
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                기본값 복원
              </button>
              <button
                type="button"
                onClick={() => setOptionsModalOpen(false)}
                className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function AiForecastTest2Page() {
  return <AiForecastTest2PageContent />;
}
