"use client";

import { useCallback, useEffect, useState } from "react";

type PreviewItem = { item: string; obsValue: number };

type PreviewResult = {
  reportMonth: string;
  sourceFile: string;
  postUrl: string;
  items: PreviewItem[];
  count: number;
  note: string | null;
};

type RunLog = {
  trigger_type: string;
  status: string;
  report_month: string | null;
  source_file: string | null;
  inserted_count: number | null;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
};

const defaultReportTarget = () => {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: prev.getFullYear(), month: prev.getMonth() + 1 };
};

const formatNumber = (value: number) => new Intl.NumberFormat("ko-KR").format(value);

export default function PdfItemTradePanel({
  dbSettingId,
}: {
  dbSettingId: string;
}) {
  const initial = defaultReportTarget();
  const [year, setYear] = useState(String(initial.year));
  const [month, setMonth] = useState(String(initial.month));

  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState("");

  const [enabled, setEnabled] = useState(false);
  const [cronExpr, setCronExpr] = useState("0 9 1 * *");
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleMsg, setScheduleMsg] = useState("");
  const [recentRuns, setRecentRuns] = useState<RunLog[]>([]);
  const [runningNow, setRunningNow] = useState(false);

  const loadBody = useCallback(
    (extra: Record<string, unknown>) => {
      const numericId = Number(dbSettingId);
      if (dbSettingId && Number.isFinite(numericId) && numericId > 0) {
        return { ...extra, dbSettingId: numericId };
      }
      return extra;
    },
    [dbSettingId],
  );

  const fetchSchedule = useCallback(async () => {
    try {
      const response = await fetch("/api/ingestion/pdf-itemtrade/schedule");
      const payload = (await response.json()) as {
        ok?: boolean;
        enabled?: boolean;
        cronExpr?: string;
        recentRuns?: RunLog[];
      };
      if (response.ok && payload.ok) {
        setEnabled(Boolean(payload.enabled));
        if (payload.cronExpr) setCronExpr(payload.cronExpr);
        setRecentRuns(payload.recentRuns ?? []);
      }
    } catch {
      // 무시
    }
  }, []);

  useEffect(() => {
    void fetchSchedule();
  }, [fetchSchedule]);

  const handlePreview = async () => {
    setPreviewing(true);
    setPreviewError("");
    setPreview(null);
    setSaveSuccess("");
    setSaveError("");
    try {
      const response = await fetch("/api/ingestion/pdf-itemtrade/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: Number(year), month: Number(month) }),
      });
      const payload = (await response.json()) as PreviewResult & {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "미리보기에 실패했습니다.");
      }
      setPreview({
        reportMonth: payload.reportMonth,
        sourceFile: payload.sourceFile,
        postUrl: payload.postUrl,
        items: payload.items ?? [],
        count: payload.count ?? 0,
        note: payload.note ?? null,
      });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "미리보기에 실패했습니다.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    setSaveSuccess("");
    try {
      const response = await fetch("/api/ingestion/pdf-itemtrade/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadBody({ year: Number(year), month: Number(month) })),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        inserted?: number;
        reportMonth?: string;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "적재에 실패했습니다.");
      }
      setSaveSuccess(
        `${payload.reportMonth} 기준 ${payload.inserted ?? 0}건 적재 완료 (dp.pdf_itemtrade).`,
      );
      void fetchSchedule();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "적재에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSchedule = async () => {
    setScheduleSaving(true);
    setScheduleMsg("");
    try {
      const response = await fetch("/api/ingestion/pdf-itemtrade/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, cronExpr }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "스케줄 저장에 실패했습니다.");
      }
      setScheduleMsg(enabled ? "자동 적재가 설정되었습니다." : "자동 적재가 해제되었습니다.");
    } catch (error) {
      setScheduleMsg(error instanceof Error ? error.message : "스케줄 저장에 실패했습니다.");
    } finally {
      setScheduleSaving(false);
    }
  };

  const handleRunNow = async () => {
    setRunningNow(true);
    setScheduleMsg("");
    try {
      const response = await fetch("/api/ingestion/pdf-itemtrade/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadBody({})), // 전월 기준 자동
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        inserted?: number;
        reportMonth?: string;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "실행에 실패했습니다.");
      }
      setScheduleMsg(
        `즉시 실행 완료: ${payload.reportMonth} ${payload.inserted ?? 0}건.`,
      );
      void fetchSchedule();
    } catch (error) {
      setScheduleMsg(error instanceof Error ? error.message : "실행에 실패했습니다.");
    } finally {
      setRunningNow(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* 1) 가져오기 */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="border-b border-slate-100 pb-3">
          <h4 className="text-base font-semibold leading-6 text-slate-900">
            수출입동향 PDF 직접 적재
          </h4>
          <p className="mt-1 text-sm text-slate-600">
            산업통상부 보도자료의 &lsquo;수출입 동향&rsquo; PDF에서 【20대 주요 수출 품목 규모
            및 증감률】 표의 <strong>해당 월 금액</strong>을 직접 파싱해{" "}
            <code className="rounded bg-slate-100 px-1">dp.pdf_itemtrade</code>에
            적재합니다. (AI 미사용)
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700">연도</label>
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="mt-1 w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700">월</label>
            <input
              type="number"
              min={1}
              max={12}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="mt-1 w-20 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewing}
            className="inline-flex h-9 items-center rounded-full bg-slate-900 px-4 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {previewing ? "가져오는 중…" : "산업부에서 가져와 미리보기"}
          </button>
          {previewError ? (
            <span className="text-xs font-medium text-rose-600">{previewError}</span>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          매월 1일 전월 보고서가 게시됩니다. 기본값은 전월입니다.
        </p>
      </div>

      {/* 2) 미리보기 + 저장 */}
      {preview ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <h4 className="text-base font-semibold text-slate-900">
              미리보기 ({preview.count}건)
            </h4>
            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
              <span className="rounded-full bg-slate-100 px-2 py-1">
                기준일자 {preview.reportMonth}
              </span>
              <a
                href={preview.postUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-slate-100 px-2 py-1 text-blue-600 hover:underline"
              >
                원본: {preview.sourceFile}
              </a>
            </div>
          </div>
          {preview.note ? (
            <p className="mt-2 text-xs text-amber-600">참고: {preview.note}</p>
          ) : null}
          <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-slate-100">
            <table className="min-w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-semibold">obs_date</th>
                  <th className="px-3 py-2 font-semibold">item</th>
                  <th className="px-3 py-2 text-right font-semibold">obs_value</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((row, idx) => (
                  <tr key={idx} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                      {preview.reportMonth}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                      {row.item}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-slate-700">
                      {formatNumber(row.obsValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || preview.items.length === 0}
              className="inline-flex h-9 items-center rounded-full bg-emerald-600 px-4 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "저장 중…" : "dp.pdf_itemtrade에 저장"}
            </button>
            <span className="text-xs text-slate-400">
              해당 월(obs_date) 기존 데이터를 삭제 후 재적재합니다.
            </span>
            {saveError ? (
              <span className="text-xs font-medium text-rose-600">{saveError}</span>
            ) : null}
            {saveSuccess ? (
              <span className="text-xs font-medium text-emerald-700">{saveSuccess}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 3) 자동화 */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <h4 className="border-b border-slate-100 pb-3 text-base font-semibold text-slate-900">
          매월 자동 적재
        </h4>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            자동 적재 사용
          </label>
          <div>
            <label className="block text-xs font-semibold text-slate-700">
              cron 표현식
            </label>
            <input
              type="text"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              className="mt-1 w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={handleSaveSchedule}
            disabled={scheduleSaving}
            className="inline-flex h-9 items-center rounded-full bg-slate-900 px-4 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {scheduleSaving ? "저장 중…" : "스케줄 저장"}
          </button>
          <button
            type="button"
            onClick={handleRunNow}
            disabled={runningNow}
            className="inline-flex h-9 items-center rounded-full border border-slate-300 px-4 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {runningNow ? "실행 중…" : "지금 실행(전월)"}
          </button>
          {scheduleMsg ? (
            <span className="text-xs font-medium text-slate-600">{scheduleMsg}</span>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          기본 <code className="rounded bg-slate-100 px-1">0 9 1 * *</code> = 매월 1일
          09:00. 앱(서버)이 켜져 있는 동안에만 동작합니다.
        </p>

        {recentRuns.length > 0 ? (
          <div className="mt-4">
            <span className="block text-xs font-semibold text-slate-700">최근 실행</span>
            <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-slate-100">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-semibold">시작</th>
                    <th className="px-3 py-2 font-semibold">유형</th>
                    <th className="px-3 py-2 font-semibold">상태</th>
                    <th className="px-3 py-2 font-semibold">기준월</th>
                    <th className="px-3 py-2 text-right font-semibold">건수</th>
                    <th className="px-3 py-2 font-semibold">비고</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run, idx) => (
                    <tr key={idx} className="border-t border-slate-100">
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                        {new Date(run.started_at).toLocaleString("ko-KR")}
                      </td>
                      <td className="px-3 py-1.5 text-slate-600">
                        {run.trigger_type === "schedule" ? "자동" : "수동"}
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={
                            run.status === "success"
                              ? "text-emerald-700"
                              : run.status === "error"
                                ? "text-rose-600"
                                : "text-slate-500"
                          }
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                        {run.report_month ?? "-"}
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-700">
                        {run.inserted_count ?? "-"}
                      </td>
                      <td className="px-3 py-1.5 text-rose-600">
                        {run.error_message ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
