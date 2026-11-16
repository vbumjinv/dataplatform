"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveNewsDateToken } from "@/app/api/ingestion/_lib/news-date-token";

type StockJob = {
  running: boolean;
  startedAt: number;
  date: string;
  startDate: string;
  endDate: string;
  dayIndex: number;
  dayCount: number;
  phase: "list" | "body" | "done" | "error";
  listCount: number;
  bodyTotal: number;
  bodyDone: number;
  bodyOk: number;
  elapsedMs: number;
  message: string;
  error: string;
};

type StockArticle = {
  articleKey: string;
  publishedAt: string;
  publisher: string;
  title: string;
  bodyStatus: string;
  bodyChars: number;
};

type ScheduleType = "interval" | "cron";

type SourceSetting = {
  startExpr: string;
  endExpr: string;
  scheduleEnabled: boolean;
  scheduleType: ScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleCronExpr: string;
};

const defaultSetting = (): SourceSetting => ({
  startExpr: "__TODAY_MINUS_1D__",
  endExpr: "__TODAY_MINUS_1D__",
  scheduleEnabled: false,
  scheduleType: "cron",
  scheduleIntervalMinutes: 60,
  scheduleCronExpr: "",
});

const formatElapsed = (elapsedMs: number) => {
  const total = Math.max(0, Math.round(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
};

const bodyStatusLabel = (status: string) => {
  if (status === "ok") return "본문 저장";
  if (status === "low_quality") return "본문 짧음";
  if (status === "failed") return "본문 실패";
  return "목록만";
};

const scheduleLabel = (setting: SourceSetting) => {
  if (!setting.scheduleEnabled) return "미사용";
  if (setting.scheduleType === "cron") return `CRON: ${setting.scheduleCronExpr || ""}`;
  return `${setting.scheduleIntervalMinutes ?? 0}분 간격`;
};

const dateErrorText = "날짜를 확인하세요. YYYY-MM-DD, __TODAY__, __TODAY_MINUS_1D__ 를 사용할 수 있습니다.";

const NEWS_DATE_PARAM_GUIDE = [
  "__TODAY__: 실행 시점의 오늘 날짜",
  "__TODAY_MINUS_{n}D__: n일 전",
  "__TODAY_MINUS_{n}M__: n개월 전",
  "__TODAY_MINUS_{n}Q__: n분기 전(3개월 단위)",
  "__TODAY_MINUS_{n}Y__ 또는 __TODAY_MINUS_{n}A__: n년 전",
  "YYYY-MM-DD 또는 YYYYMMDD: 지정한 날짜",
];

const NEWS_DATE_PARAMS = [
  {
    key: "시작일",
    label: "조회 시작일",
    description: "수집 시작일입니다. YYYY-MM-DD 또는 __TODAY__, __TODAY_MINUS_1D__ 같은 변수를 사용할 수 있습니다.",
  },
  {
    key: "종료일",
    label: "조회 종료일",
    description: "수집 종료일입니다. __TODAY__를 입력하면 실행 시점의 오늘 날짜로 바뀝니다.",
  },
];

export default function NewsSettingsPanel({ dbSettingId }: { dbSettingId: string }) {
  const [setting, setSetting] = useState<SourceSetting>(defaultSetting);
  const [settingReady, setSettingReady] = useState(false);
  const [stockJob, setStockJob] = useState<StockJob | null>(null);
  const [stockTotal, setStockTotal] = useState(0);
  const [stockOk, setStockOk] = useState(0);
  const [stockPending, setStockPending] = useState(0);
  const [stockArticles, setStockArticles] = useState<StockArticle[]>([]);
  const [stockError, setStockError] = useState("");
  const [stockLoading, setStockLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dateOpen, setDateOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(setting.startExpr);
  const [draftEnd, setDraftEnd] = useState(setting.endExpr);
  const [draftSchedule, setDraftSchedule] = useState(setting);
  const [saving, setSaving] = useState(false);

  const withDb = useCallback(
    (extra: Record<string, unknown>) => {
      const numericId = Number(dbSettingId);
      if (dbSettingId && Number.isFinite(numericId) && numericId > 0) {
        return { ...extra, dbSettingId: numericId };
      }
      return extra;
    },
    [dbSettingId],
  );

  const loadStockRange = useCallback(async (startExpr: string, endExpr: string) => {
    const resolvedStart = resolveNewsDateToken(startExpr);
    const resolvedEnd = resolveNewsDateToken(endExpr);
    if (!resolvedStart || !resolvedEnd) return null;
    const params = new URLSearchParams({ startDate: resolvedStart, endDate: resolvedEnd });
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) {
      params.set("dbSettingId", String(numericId));
    }
    const response = await fetch(`/api/ingestion/news-stock?${params.toString()}`);
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      job?: StockJob;
      total?: number;
      okCount?: number;
      pendingCount?: number;
      articles?: StockArticle[];
    };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "수집 현황을 불러오지 못했습니다.");
    }
    setStockJob(payload.job ?? null);
    setStockTotal(payload.total ?? 0);
    setStockOk(payload.okCount ?? 0);
    setStockPending(payload.pendingCount ?? 0);
    setStockArticles(payload.articles ?? []);
    setStockError("");
    return payload.job ?? null;
  }, [dbSettingId]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) {
      params.set("dbSettingId", String(numericId));
    }
    void fetch(`/api/ingestion/news-stock/setting?${params.toString()}`)
      .then(async (response) => {
        const payload = (await response.json()) as { ok?: boolean; error?: string; setting?: SourceSetting };
        if (!response.ok || !payload.ok || !payload.setting) {
          throw new Error(payload.error || "뉴스 설정을 불러오지 못했습니다.");
        }
        if (cancelled) return;
        setSetting(payload.setting);
        setSettingReady(true);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setSettingReady(true);
          setStockError(loadError instanceof Error ? loadError.message : "뉴스 설정을 불러오지 못했습니다.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dbSettingId]);

  useEffect(() => {
    if (!settingReady) return;
    void loadStockRange(setting.startExpr, setting.endExpr).catch((loadError: unknown) => {
      setStockError(loadError instanceof Error ? loadError.message : "수집 현황을 불러오지 못했습니다.");
    });
  }, [loadStockRange, setting.endExpr, setting.startExpr, settingReady]);

  const resolvedStart = resolveNewsDateToken(setting.startExpr);
  const resolvedEnd = resolveNewsDateToken(setting.endExpr);
  const stockRunning = Boolean(stockJob?.running) || stockLoading;
  const sameRange = Boolean(
    resolvedStart && resolvedEnd && stockJob?.startDate === resolvedStart && stockJob?.endDate === resolvedEnd,
  );

  useEffect(() => {
    if (!stockJob?.running) return;
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void loadStockRange(setting.startExpr, setting.endExpr).catch((loadError: unknown) => {
        setStockError(loadError instanceof Error ? loadError.message : "수집 현황을 불러오지 못했습니다.");
      });
    }, 2000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [loadStockRange, setting.endExpr, setting.startExpr, stockJob?.running]);

  const elapsedMs =
    sameRange && stockJob?.running && stockJob.startedAt > 0
      ? Math.max(0, nowMs - stockJob.startedAt)
      : sameRange
        ? stockJob?.elapsedMs ?? 0
        : 0;

  const handleRun = async () => {
    if (!resolvedStart || !resolvedEnd) {
      setStockError(dateErrorText);
      return;
    }
    setStockLoading(true);
    setStockError("");
    try {
      const response = await fetch("/api/ingestion/news-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDb({ startDate: resolvedStart, endDate: resolvedEnd })),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; job?: StockJob };
      if (response.status === 409 && payload.job) {
        setStockJob(payload.job);
        setNowMs(Date.now());
        setStockError(payload.job.running ? "" : payload.error || "이미 수집이 진행 중입니다.");
        return;
      }
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "수집을 시작하지 못했습니다.");
      }
      setStockJob(payload.job ?? null);
      setNowMs(Date.now());
    } catch (crawlError) {
      setStockError(crawlError instanceof Error ? crawlError.message : "수집을 시작하지 못했습니다.");
    } finally {
      setStockLoading(false);
    }
  };

  const saveSetting = async (body: Record<string, unknown>) => {
    setSaving(true);
    setStockError("");
    try {
      const response = await fetch("/api/ingestion/news-stock/setting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDb(body)),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; setting?: SourceSetting };
      if (!response.ok || !payload.ok || !payload.setting) {
        throw new Error(payload.error || "뉴스 설정을 저장하지 못했습니다.");
      }
      setSetting(payload.setting);
      return true;
    } catch (saveError) {
      setStockError(saveError instanceof Error ? saveError.message : "뉴스 설정을 저장하지 못했습니다.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDates = async () => {
    if (!resolveNewsDateToken(draftStart) || !resolveNewsDateToken(draftEnd)) {
      setStockError(dateErrorText);
      return;
    }
    const saved = await saveSetting({ startExpr: draftStart.trim(), endExpr: draftEnd.trim() });
    if (saved) setDateOpen(false);
  };

  const handleSaveSchedule = async () => {
    const saved = await saveSetting({
      schedule: {
        enabled: draftSchedule.scheduleEnabled,
        type: draftSchedule.scheduleType,
        intervalMinutes: draftSchedule.scheduleIntervalMinutes,
        cronExpr: draftSchedule.scheduleCronExpr,
      },
    });
    if (saved) setScheduleOpen(false);
  };

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold leading-6 text-slate-900">뉴스 설정 목록</h3>
        <span className="inline-flex h-7 items-center rounded-full border border-slate-200 px-3 text-xs font-semibold text-slate-500">
          3건
        </span>
      </div>
      <div className="mt-4 space-y-3">
        <section className="overflow-hidden rounded-2xl border border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <div className="min-w-[200px] flex-1">
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">기관명</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">네이버페이</p>
            </div>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600">
              그룹 1건
            </span>
          </div>
          <div className="divide-y divide-slate-200 text-[11px]">
            <div className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.2fr_0.9fr_220px] gap-2 bg-white px-4 py-2 font-semibold text-slate-600">
              <span>뉴스 명</span>
              <span>시작일</span>
              <span>종료일</span>
              <span>적재</span>
              <span>스케줄</span>
              <span className="text-center">작업</span>
            </div>
            <div className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.2fr_0.9fr_220px] items-center gap-2 px-4 py-2 text-slate-700">
              <span>네이버페이 증권 뉴스</span>
              <span className="text-slate-500">{resolvedStart ?? ""}</span>
              <span className="text-slate-500">{resolvedEnd ?? ""}</span>
              <span className="break-all text-slate-500">dp.news_stock_article</span>
              <span className="text-slate-500">{scheduleLabel(setting)}</span>
              <div className="flex items-center justify-center gap-1">
                <button
                  type="button"
                  onClick={() => void handleRun()}
                  disabled={stockRunning || !resolvedStart || !resolvedEnd}
                  className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {stockRunning ? "수집 중" : "실행"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftStart(setting.startExpr);
                    setDraftEnd(setting.endExpr);
                    setDateOpen(true);
                  }}
                  className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                >
                  설정
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftSchedule(setting);
                    setScheduleOpen(true);
                  }}
                  className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100"
                >
                  스케줄
                </button>
              </div>
            </div>
          </div>
          <div className="border-t border-slate-100 px-4 py-3">
            <p className="text-xs text-slate-500">
              저장된 목록 {stockTotal}건 · 저장된 본문 {stockOk}건 · 본문 미저장 {stockPending}건
            </p>
            {sameRange && stockJob?.message ? (
              <p className={`mt-2 text-xs font-medium ${stockJob.phase === "error" ? "text-rose-600" : "text-emerald-700"}`}>
                {stockJob.running ? `이번 실행 ${formatElapsed(elapsedMs)} · ` : ""}
                {stockJob.message}
              </p>
            ) : null}
            {stockError ? <p className="mt-2 text-xs font-medium text-rose-600">{stockError}</p> : null}
            {stockArticles.length > 0 ? (
              <div className="mt-3 overflow-auto rounded-xl border border-slate-100">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 font-semibold">시각</th>
                      <th className="px-3 py-2 font-semibold">언론사</th>
                      <th className="px-3 py-2 font-semibold">제목</th>
                      <th className="px-3 py-2 font-semibold">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockArticles.map((article) => (
                      <tr key={article.articleKey} className="border-t border-slate-100">
                        <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                          {new Date(article.publishedAt).toLocaleString("ko-KR", { hour12: false })}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{article.publisher}</td>
                        <td className="px-3 py-1.5 text-slate-800">{article.title}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                          {bodyStatusLabel(article.bodyStatus)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </section>
        <DartDisclosureSample dbSettingId={dbSettingId} />
        <NytNewsSection dbSettingId={dbSettingId} />
      </div>
      {dateOpen ? (
        <DateSettingModal
          title="네이버페이 증권 뉴스"
          startExpr={draftStart}
          endExpr={draftEnd}
          saving={saving}
          onStartChange={setDraftStart}
          onEndChange={setDraftEnd}
          onClose={() => setDateOpen(false)}
          onSave={() => void handleSaveDates()}
        />
      ) : null}
      {scheduleOpen ? (
        <ScheduleSettingModal
          title="네이버페이 증권 뉴스"
          draft={draftSchedule}
          saving={saving}
          onChange={setDraftSchedule}
          onClose={() => setScheduleOpen(false)}
          onSave={() => void handleSaveSchedule()}
        />
      ) : null}
    </div>
  );
}

function DateSettingModal({
  title,
  startExpr,
  endExpr,
  saving,
  onStartChange,
  onEndChange,
  apiKey,
  apiKeyLabel,
  onApiKeyChange,
  keywords,
  onKeywordsChange,
  onClose,
  onSave,
}: {
  title: string;
  startExpr: string;
  endExpr: string;
  saving: boolean;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  apiKey?: string;
  apiKeyLabel?: string;
  onApiKeyChange?: (value: string) => void;
  keywords?: string;
  onKeywordsChange?: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [showGuide, setShowGuide] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [keywordHint, setKeywordHint] = useState("");
  const resolvedStart = resolveNewsDateToken(startExpr);
  const resolvedEnd = resolveNewsDateToken(endExpr);
  const sortKeywords = (terms: string[]) =>
    [...terms].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
  const keywordTerms = sortKeywords(
    (keywords ?? "")
      .split(/[\n,]/)
      .map((term) => term.trim())
      .filter(Boolean),
  );
  const addKeyword = () => {
    const next = keywordDraft.trim();
    if (!next || !onKeywordsChange) return;
    if (keywordTerms.some((term) => term.toLowerCase() === next.toLowerCase())) {
      setKeywordHint("이미 추가된 키워드입니다.");
      return;
    }
    onKeywordsChange(sortKeywords([...keywordTerms, next]).join("\n"));
    setKeywordDraft("");
    setKeywordHint("");
  };
  const removeKeyword = (index: number) => {
    if (!onKeywordsChange) return;
    onKeywordsChange(keywordTerms.filter((_, termIndex) => termIndex !== index).join("\n"));
  };
  return (
    <>
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">기간 설정</p>
            <p className="mt-1 text-xs text-slate-500">{title} 시작일과 종료일을 설정합니다.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowGuide(true)}
              className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              파라미터 설명 보기
            </button>
            <button type="button" onClick={onClose} className="text-sm font-semibold text-slate-400 hover:text-slate-600">
              ×
            </button>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <label className="block space-y-1 text-xs text-slate-600">
            시작일
            <input
              value={startExpr}
              onChange={(event) => onStartChange(event.target.value)}
              spellCheck={false}
              placeholder="__TODAY_MINUS_1D__"
              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs"
            />
            <span className="block text-[11px] text-slate-400">{resolvedStart ?? "형식을 확인하세요"}</span>
          </label>
          <label className="block space-y-1 text-xs text-slate-600">
            종료일
            <input
              value={endExpr}
              onChange={(event) => onEndChange(event.target.value)}
              spellCheck={false}
              placeholder="__TODAY__"
              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs"
            />
            <span className="block text-[11px] text-slate-400">{resolvedEnd ?? "형식을 확인하세요"}</span>
          </label>
          {onApiKeyChange ? (
            <label className="block space-y-1 text-xs text-slate-600">
              {apiKeyLabel ?? "OpenDART 인증키"}
              <input
                value={apiKey ?? ""}
                onChange={(event) => onApiKeyChange(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder={apiKeyLabel ? "developer.nytimes.com 에서 발급한 키" : "opendart.fss.or.kr 에서 발급한 키"}
                className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs"
              />
            </label>
          ) : null}
          {onKeywordsChange ? (
            <div className="space-y-2 text-xs text-slate-600">
              <p>키워드</p>
              <div className="flex items-center gap-2">
                <input
                  value={keywordDraft}
                  onChange={(event) => {
                    setKeywordDraft(event.target.value);
                    if (keywordHint) setKeywordHint("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addKeyword();
                  }}
                  spellCheck={false}
                  placeholder="키워드를 입력하세요"
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={addKeyword}
                  disabled={!keywordDraft.trim()}
                  className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                >
                  추가
                </button>
              </div>
              {keywordHint ? <p className="text-[11px] text-amber-600">{keywordHint}</p> : null}
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {keywordTerms.map((term, index) => (
                  <div
                    key={`${term}-${index}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <span className="min-w-0 break-words text-xs font-medium text-slate-800">{term}</span>
                    <button
                      type="button"
                      onClick={() => removeKeyword(index)}
                      aria-label={`${term} 삭제`}
                      className="shrink-0 text-sm font-semibold leading-none text-slate-400 hover:text-slate-700"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            저장
          </button>
        </div>
      </div>
    </div>
    {showGuide ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">파라미터 설명</p>
              <p className="mt-1 text-xs text-slate-500">날짜 파라미터 사용값과 현재 파라미터 의미를 확인합니다.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="text-sm font-semibold text-slate-400 hover:text-slate-600"
            >
              ×
            </button>
          </div>
          <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <p className="font-semibold text-slate-900">현재 파라미터 설명</p>
              <div className="mt-2 space-y-1.5">
                {NEWS_DATE_PARAMS.map((item) => (
                  <div key={item.key} className="rounded-lg bg-white px-2 py-1.5">
                    <p className="font-semibold text-slate-800">
                      {item.key} - {item.label}
                    </p>
                    <p className="mt-0.5 text-slate-600">{item.description}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-slate-700">
              <p className="font-semibold text-sky-900">날짜 파라미터 지원 값</p>
              <div className="mt-2 space-y-1">
                {NEWS_DATE_PARAM_GUIDE.map((guide) => (
                  <p key={guide}>- {guide}</p>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              닫기
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function ScheduleSettingModal({
  title,
  draft,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  title: string;
  draft: SourceSetting;
  saving: boolean;
  onChange: (next: SourceSetting) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">스케줄 설정</p>
            <p className="mt-1 text-xs text-slate-500">{title} 실행 주기를 설정합니다.</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm font-semibold text-slate-400 hover:text-slate-600">
            ×
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={draft.scheduleEnabled}
              onChange={(event) => onChange({ ...draft, scheduleEnabled: event.target.checked })}
            />
            스케줄 활성화
          </label>
          <label className="space-y-1 text-xs text-slate-600">
            실행 방식
            <select
              value={draft.scheduleType}
              onChange={(event) => onChange({ ...draft, scheduleType: event.target.value as ScheduleType })}
              className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
            >
              <option value="interval">간격(분)</option>
              <option value="cron">CRON</option>
            </select>
          </label>
          {draft.scheduleType === "interval" ? (
            <label className="space-y-1 text-xs text-slate-600">
              실행 주기(분)
              <input
                type="number"
                min={1}
                value={draft.scheduleIntervalMinutes ?? 60}
                onChange={(event) =>
                  onChange({ ...draft, scheduleIntervalMinutes: Math.max(1, Number(event.target.value) || 1) })
                }
                className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
              />
            </label>
          ) : (
            <label className="space-y-1 text-xs text-slate-600">
              CRON 표현식
              <input
                value={draft.scheduleCronExpr}
                onChange={(event) => onChange({ ...draft, scheduleCronExpr: event.target.value })}
                placeholder="예: 0 8 * * *"
                className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
              />
            </label>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

type DartJob = {
  running: boolean;
  startedAt: number;
  startDate: string;
  endDate: string;
  phase: "list" | "done" | "error";
  saved: number;
  elapsedMs: number;
  message: string;
  error: string;
};

type DartDisclosure = {
  rceptNo: string;
  rceptDt: string;
  corpName: string;
  stockCode: string;
  corpClsName: string;
  reportNm: string;
  url: string;
};

function DartDisclosureSample({ dbSettingId }: { dbSettingId: string }) {
  const [setting, setSetting] = useState<SourceSetting>({
    ...defaultSetting(),
    startExpr: "__TODAY__",
    endExpr: "__TODAY__",
  });
  const [settingReady, setSettingReady] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [draftStart, setDraftStart] = useState(setting.startExpr);
  const [draftEnd, setDraftEnd] = useState(setting.endExpr);
  const [draftSchedule, setDraftSchedule] = useState(setting);
  const [job, setJob] = useState<DartJob | null>(null);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<DartDisclosure[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const resolvedStart = resolveNewsDateToken(setting.startExpr);
  const resolvedEnd = resolveNewsDateToken(setting.endExpr);
  const running = Boolean(job?.running) || loading;
  const sameRange = Boolean(resolvedStart && resolvedEnd && job?.startDate === resolvedStart && job?.endDate === resolvedEnd);
  const elapsedMs =
    sameRange && job?.running && job.startedAt > 0 ? Math.max(0, nowMs - job.startedAt) : 0;

  const withDb = (extra: Record<string, unknown>) => {
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) {
      return { ...extra, dbSettingId: numericId };
    }
    return extra;
  };

  const loadRange = useCallback(async (startExpr: string, endExpr: string) => {
    const startDate = resolveNewsDateToken(startExpr);
    const endDate = resolveNewsDateToken(endExpr);
    if (!startDate || !endDate) return;
    const params = new URLSearchParams({ startDate, endDate });
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) params.set("dbSettingId", String(numericId));
    const response = await fetch(`/api/ingestion/dart?${params.toString()}`);
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      job?: DartJob;
      total?: number;
      disclosures?: DartDisclosure[];
    };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "공시 현황을 불러오지 못했습니다.");
    setJob(payload.job ?? null);
    setTotal(payload.total ?? 0);
    setRows(payload.disclosures ?? []);
    setError("");
  }, [dbSettingId]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) params.set("dbSettingId", String(numericId));
    void fetch(`/api/ingestion/dart/setting?${params.toString()}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
          setting?: SourceSetting & { apiKey?: string };
        };
        if (!response.ok || !payload.ok || !payload.setting) {
          throw new Error(payload.error || "DART 설정을 불러오지 못했습니다.");
        }
        if (cancelled) return;
        setSetting(payload.setting);
        setApiKey(payload.setting.apiKey ?? "");
        setSettingReady(true);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setSettingReady(true);
          setError(loadError instanceof Error ? loadError.message : "DART 설정을 불러오지 못했습니다.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dbSettingId]);

  useEffect(() => {
    if (!settingReady) return;
    void loadRange(setting.startExpr, setting.endExpr).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "공시 현황을 불러오지 못했습니다.");
    });
  }, [loadRange, setting.endExpr, setting.startExpr, settingReady]);

  useEffect(() => {
    if (!job?.running) return;
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void loadRange(setting.startExpr, setting.endExpr).catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "공시 현황을 불러오지 못했습니다.");
      });
    }, 2000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [job?.running, loadRange, setting.endExpr, setting.startExpr]);

  const handleRun = async () => {
    if (!resolvedStart || !resolvedEnd) {
      setError(dateErrorText);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/ingestion/dart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDb({ startDate: resolvedStart, endDate: resolvedEnd })),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; job?: DartJob };
      if (response.status === 409 && payload.job) {
        setJob(payload.job);
        setNowMs(Date.now());
        return;
      }
      if (!response.ok || !payload.ok) throw new Error(payload.error || "수집을 시작하지 못했습니다.");
      setJob(payload.job ?? null);
      setNowMs(Date.now());
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "수집을 시작하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const saveSetting = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/ingestion/dart/setting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDb(body)),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        setting?: SourceSetting & { apiKey?: string };
      };
      if (!response.ok || !payload.ok || !payload.setting) {
        throw new Error(payload.error || "DART 설정을 저장하지 못했습니다.");
      }
      setSetting(payload.setting);
      if (typeof payload.setting.apiKey === "string") setApiKey(payload.setting.apiKey);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "DART 설정을 저장하지 못했습니다.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        <div className="min-w-[200px] flex-1">
          <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">기관명</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">DART</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600">
          그룹 1건
        </span>
      </div>
      <div className="divide-y divide-slate-200 text-[11px]">
        <div className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.2fr_0.9fr_220px] gap-2 bg-white px-4 py-2 font-semibold text-slate-600">
          <span>데이터 명</span>
          <span>시작일</span>
          <span>종료일</span>
          <span>적재</span>
          <span>스케줄</span>
          <span className="text-center">작업</span>
        </div>
        <div className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.2fr_0.9fr_220px] items-center gap-2 px-4 py-2 text-slate-700">
          <span>DART 공시데이터</span>
          <span className="text-slate-500">{resolvedStart ?? ""}</span>
          <span className="text-slate-500">{resolvedEnd ?? ""}</span>
          <span className="break-all text-slate-500">dp.dart_disclosure</span>
          <span className="text-slate-500">{scheduleLabel(setting)}</span>
          <div className="flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={running || !resolvedStart || !resolvedEnd}
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              {running ? "수집 중" : "실행"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftStart(setting.startExpr);
                setDraftEnd(setting.endExpr);
                setDraftApiKey(apiKey);
                setDateOpen(true);
              }}
              className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              설정
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftSchedule(setting);
                setScheduleOpen(true);
              }}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100"
            >
              스케줄
            </button>
          </div>
        </div>
      </div>
      <div className="border-t border-slate-100 px-4 py-3">
        <p className="text-xs text-slate-500">저장된 공시 {total}건</p>
        {sameRange && job?.message ? (
          <p className={`mt-2 text-xs font-medium ${job.phase === "error" ? "text-rose-600" : "text-emerald-700"}`}>
            {job.running ? `이번 실행 ${formatElapsed(elapsedMs)} · ` : ""}
            {job.message}
          </p>
        ) : null}
        {error ? <p className="mt-2 text-xs font-medium text-rose-600">{error}</p> : null}
        {rows.length > 0 ? (
          <div className="mt-3 overflow-auto rounded-xl border border-slate-100">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-semibold">접수일</th>
                  <th className="px-3 py-2 font-semibold">시장</th>
                  <th className="px-3 py-2 font-semibold">회사</th>
                  <th className="px-3 py-2 font-semibold">공시</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.rceptNo} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{row.rceptDt}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{row.corpClsName}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                      {row.corpName}
                      {row.stockCode ? ` ${row.stockCode}` : ""}
                    </td>
                    <td className="px-3 py-1.5 text-slate-800">
                      <a href={row.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {row.reportNm}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {dateOpen ? (
        <DateSettingModal
          title="DART 공시데이터"
          startExpr={draftStart}
          endExpr={draftEnd}
          apiKey={draftApiKey}
          saving={saving}
          onStartChange={setDraftStart}
          onEndChange={setDraftEnd}
          onApiKeyChange={setDraftApiKey}
          onClose={() => setDateOpen(false)}
          onSave={() => {
            void (async () => {
              if (!resolveNewsDateToken(draftStart) || !resolveNewsDateToken(draftEnd)) {
                setError(dateErrorText);
                return;
              }
              const saved = await saveSetting({
                startExpr: draftStart.trim(),
                endExpr: draftEnd.trim(),
                apiKey: draftApiKey.trim(),
              });
              if (saved) setDateOpen(false);
            })();
          }}
        />
      ) : null}
      {scheduleOpen ? (
        <ScheduleSettingModal
          title="DART 공시데이터"
          draft={draftSchedule}
          saving={saving}
          onChange={setDraftSchedule}
          onClose={() => setScheduleOpen(false)}
          onSave={() => {
            void (async () => {
              const saved = await saveSetting({
                schedule: {
                  enabled: draftSchedule.scheduleEnabled,
                  type: draftSchedule.scheduleType,
                  intervalMinutes: draftSchedule.scheduleIntervalMinutes,
                  cronExpr: draftSchedule.scheduleCronExpr,
                },
              });
              if (saved) setScheduleOpen(false);
            })();
          }}
        />
      ) : null}
    </section>
  );
}

type NytJob = {
  running: boolean;
  startedAt: number;
  startDate: string;
  endDate: string;
  phase: "list" | "done" | "error";
  saved: number;
  elapsedMs: number;
  message: string;
  error: string;
};

type NytArticle = {
  articleId: string;
  webUrl: string;
  headline: string;
  sectionName: string;
  publishedAt: string;
};

function NytNewsSection({ dbSettingId }: { dbSettingId: string }) {
  const [setting, setSetting] = useState<SourceSetting>({
    ...defaultSetting(),
    startExpr: "__TODAY__",
    endExpr: "__TODAY__",
  });
  const [settingReady, setSettingReady] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [keywords, setKeywords] = useState("");
  const [draftKeywords, setDraftKeywords] = useState("");
  const [draftStart, setDraftStart] = useState(setting.startExpr);
  const [draftEnd, setDraftEnd] = useState(setting.endExpr);
  const [draftSchedule, setDraftSchedule] = useState(setting);
  const [job, setJob] = useState<NytJob | null>(null);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<NytArticle[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const resolvedStart = resolveNewsDateToken(setting.startExpr);
  const resolvedEnd = resolveNewsDateToken(setting.endExpr);
  const running = Boolean(job?.running) || loading;
  const sameRange = Boolean(resolvedStart && resolvedEnd && job?.startDate === resolvedStart && job?.endDate === resolvedEnd);
  const elapsedMs = sameRange && job?.running && job.startedAt > 0 ? Math.max(0, nowMs - job.startedAt) : 0;

  const withDb = (extra: Record<string, unknown>) => {
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) return { ...extra, dbSettingId: numericId };
    return extra;
  };

  const loadRange = useCallback(async (startExpr: string, endExpr: string) => {
    const startDate = resolveNewsDateToken(startExpr);
    const endDate = resolveNewsDateToken(endExpr);
    if (!startDate || !endDate) return;
    const params = new URLSearchParams({ startDate, endDate });
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) params.set("dbSettingId", String(numericId));
    const response = await fetch(`/api/ingestion/nyt?${params.toString()}`);
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      job?: NytJob;
      total?: number;
      articles?: NytArticle[];
    };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "NYT 뉴스 현황을 불러오지 못했습니다.");
    setJob(payload.job ?? null);
    setTotal(payload.total ?? 0);
    setRows(payload.articles ?? []);
    setError("");
  }, [dbSettingId]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    const numericId = Number(dbSettingId);
    if (dbSettingId && Number.isFinite(numericId) && numericId > 0) params.set("dbSettingId", String(numericId));
    void fetch(`/api/ingestion/nyt/setting?${params.toString()}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
          setting?: SourceSetting & { apiKey?: string };
        };
        if (!response.ok || !payload.ok || !payload.setting) {
          throw new Error(payload.error || "NYT 설정을 불러오지 못했습니다.");
        }
        if (cancelled) return;
        setSetting(payload.setting);
        setApiKey(payload.setting.apiKey ?? "");
        setKeywords((payload.setting as { keywords?: string }).keywords ?? "");
        setSettingReady(true);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setSettingReady(true);
          setError(loadError instanceof Error ? loadError.message : "NYT 설정을 불러오지 못했습니다.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dbSettingId]);

  useEffect(() => {
    if (!settingReady) return;
    void loadRange(setting.startExpr, setting.endExpr).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "NYT 뉴스 현황을 불러오지 못했습니다.");
    });
  }, [loadRange, setting.endExpr, setting.startExpr, settingReady]);

  useEffect(() => {
    if (!job?.running) return;
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void loadRange(setting.startExpr, setting.endExpr).catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "NYT 뉴스 현황을 불러오지 못했습니다.");
      });
    }, 2000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [job?.running, loadRange, setting.endExpr, setting.startExpr]);

  const saveSetting = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/ingestion/nyt/setting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDb(body)),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        setting?: SourceSetting & { apiKey?: string; keywords?: string };
      };
      if (!response.ok || !payload.ok || !payload.setting) {
        throw new Error(payload.error || "NYT 설정을 저장하지 못했습니다.");
      }
      setSetting(payload.setting);
      if (typeof payload.setting.apiKey === "string") setApiKey(payload.setting.apiKey);
      if (typeof payload.setting.keywords === "string") setKeywords(payload.setting.keywords);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "NYT 설정을 저장하지 못했습니다.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (!resolvedStart || !resolvedEnd) {
      setError(dateErrorText);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/ingestion/nyt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDb({ startDate: resolvedStart, endDate: resolvedEnd })),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; job?: NytJob };
      if (response.status === 409 && payload.job) {
        setJob(payload.job);
        setNowMs(Date.now());
        return;
      }
      if (!response.ok || !payload.ok) throw new Error(payload.error || "수집을 시작하지 못했습니다.");
      setJob(payload.job ?? null);
      setNowMs(Date.now());
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "수집을 시작하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        <div className="min-w-[200px] flex-1">
          <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">기관명</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">뉴욕타임스</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600">
          그룹 1건
        </span>
      </div>
      <div className="divide-y divide-slate-200 text-[11px]">
        <div className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.2fr_0.9fr_220px] gap-2 bg-white px-4 py-2 font-semibold text-slate-600">
          <span>뉴스 명</span>
          <span>시작일</span>
          <span>종료일</span>
          <span>적재</span>
          <span>스케줄</span>
          <span className="text-center">작업</span>
        </div>
        <div className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.2fr_0.9fr_220px] items-center gap-2 px-4 py-2 text-slate-700">
          <span>NYT 해외 뉴스</span>
          <span className="text-slate-500">{resolvedStart ?? ""}</span>
          <span className="text-slate-500">{resolvedEnd ?? ""}</span>
          <span className="break-all text-slate-500">dp.news_nyt_article</span>
          <span className="text-slate-500">{scheduleLabel(setting)}</span>
          <div className="flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={running || !resolvedStart || !resolvedEnd}
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              {running ? "수집 중" : "실행"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftStart(setting.startExpr);
                setDraftEnd(setting.endExpr);
                setDraftApiKey(apiKey);
                setDraftKeywords(keywords);
                setDateOpen(true);
              }}
              className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              설정
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftSchedule(setting);
                setScheduleOpen(true);
              }}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100"
            >
              스케줄
            </button>
          </div>
        </div>
      </div>
      <div className="border-t border-slate-100 px-4 py-3">
        <p className="text-xs text-slate-500">저장된 기사 {total}건</p>
        {sameRange && job?.message ? (
          <p className={`mt-2 text-xs font-medium ${job.phase === "error" ? "text-rose-600" : "text-emerald-700"}`}>
            {job.running ? `이번 실행 ${formatElapsed(elapsedMs)} · ` : ""}
            {job.message}
          </p>
        ) : null}
        {error ? <p className="mt-2 text-xs font-medium text-rose-600">{error}</p> : null}
        {rows.length > 0 ? (
          <div className="mt-3 overflow-auto rounded-xl border border-slate-100">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-semibold">시각</th>
                  <th className="px-3 py-2 font-semibold">섹션</th>
                  <th className="px-3 py-2 font-semibold">제목</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.articleId} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                      {row.publishedAt ? new Date(row.publishedAt).toLocaleString("ko-KR", { hour12: false }) : ""}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{row.sectionName}</td>
                    <td className="px-3 py-1.5 text-slate-800">
                      {row.webUrl ? (
                        <a href={row.webUrl} target="_blank" rel="noreferrer" className="hover:underline">
                          {row.headline}
                        </a>
                      ) : (
                        row.headline
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {dateOpen ? (
        <DateSettingModal
          title="NYT 해외 뉴스"
          startExpr={draftStart}
          endExpr={draftEnd}
          apiKey={draftApiKey}
          apiKeyLabel="NYT API 키"
          keywords={draftKeywords}
          saving={saving}
          onStartChange={setDraftStart}
          onEndChange={setDraftEnd}
          onApiKeyChange={setDraftApiKey}
          onKeywordsChange={setDraftKeywords}
          onClose={() => setDateOpen(false)}
          onSave={() => {
            void (async () => {
              if (!resolveNewsDateToken(draftStart) || !resolveNewsDateToken(draftEnd)) {
                setError(dateErrorText);
                return;
              }
              const saved = await saveSetting({
                startExpr: draftStart.trim(),
                endExpr: draftEnd.trim(),
                apiKey: draftApiKey.trim(),
                keywords: draftKeywords,
              });
              if (saved) setDateOpen(false);
            })();
          }}
        />
      ) : null}
      {scheduleOpen ? (
        <ScheduleSettingModal
          title="NYT 해외 뉴스"
          draft={draftSchedule}
          saving={saving}
          onChange={setDraftSchedule}
          onClose={() => setScheduleOpen(false)}
          onSave={() => {
            void (async () => {
              const saved = await saveSetting({
                schedule: {
                  enabled: draftSchedule.scheduleEnabled,
                  type: draftSchedule.scheduleType,
                  intervalMinutes: draftSchedule.scheduleIntervalMinutes,
                  cronExpr: draftSchedule.scheduleCronExpr,
                },
              });
              if (saved) setScheduleOpen(false);
            })();
          }}
        />
      ) : null}
    </section>
  );
}
