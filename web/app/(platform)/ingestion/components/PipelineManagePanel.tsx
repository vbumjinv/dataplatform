"use client";

import { useCallback, useEffect, useState } from "react";

type PipelineListItem = {
  pipeline_id: number;
  name: string;
  schedule_enabled: boolean;
  schedule_type: "interval" | "cron";
  schedule_interval_minutes: number | null;
  schedule_cron_expr: string | null;
  collection_label: string | null;
  map_count: number;
  last_status: string | null;
  last_run_at: string | null;
};

type RunLog = {
  run_log_id: number;
  trigger_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
  step_results: Array<{ type: string; status: string; affectedCount?: number; message?: string }> | null;
  error_message: string | null;
};

const scheduleLabel = (p: PipelineListItem) => {
  if (!p.schedule_enabled) return "미사용";
  if (p.schedule_type === "cron") return `CRON ${p.schedule_cron_expr ?? ""}`;
  return `${p.schedule_interval_minutes ?? 0}분 간격`;
};

export default function PipelineManagePanel() {
  const [pipelines, setPipelines] = useState<PipelineListItem[]>([]);
  const [listError, setListError] = useState("");
  const [listMsg, setListMsg] = useState("");
  const [runningId, setRunningId] = useState<number | null>(null);

  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runModalTitle, setRunModalTitle] = useState("");
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState("");

  const fetchPipelines = useCallback(async () => {
    try {
      const res = await fetch("/api/pipeline");
      const payload = (await res.json()) as { ok?: boolean; items?: PipelineListItem[]; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "파이프라인 목록을 불러오지 못했습니다.");
      setPipelines(payload.items ?? []);
      setListError("");
    } catch (error) {
      setListError(error instanceof Error ? error.message : "목록 오류");
    }
  }, []);

  useEffect(() => {
    void fetchPipelines();
  }, [fetchPipelines]);

  const handleRunById = async (pipelineId: number) => {
    setRunningId(pipelineId);
    setListMsg("");
    try {
      const res = await fetch(`/api/pipeline/${pipelineId}/run`, { method: "POST" });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(payload.error || "실행에 실패했습니다.");
      setListMsg(payload.ok ? "실행 완료." : "실행됨(일부 실패) — 이력 확인.");
      await fetchPipelines();
    } catch (error) {
      setListMsg(error instanceof Error ? error.message : "실행 오류");
    } finally {
      setRunningId(null);
    }
  };

  const openRuns = async (pipelineId: number, pipelineName: string) => {
    setRunModalOpen(true);
    setRunModalTitle(pipelineName);
    setRuns([]);
    setRunsError("");
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/pipeline/${pipelineId}/runs`);
      const payload = (await res.json()) as { ok?: boolean; runs?: RunLog[]; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "실행 이력을 불러오지 못했습니다.");
      setRuns(payload.runs ?? []);
    } catch (error) {
      setRunsError(error instanceof Error ? error.message : "실행 이력 오류");
    } finally {
      setRunsLoading(false);
    }
  };

  return (
    <>
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h4 className="text-base font-semibold leading-6 text-slate-900">파이프라인 관리</h4>
            <p className="mt-1 text-xs text-slate-500">실행 상태를 모니터링하고 즉시 실행/이력을 확인합니다.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {listMsg ? <span className="text-xs text-slate-600">{listMsg}</span> : null}
            <button
              type="button"
              onClick={() => void fetchPipelines()}
              className="inline-flex h-8 items-center rounded-full border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              새로고침
            </button>
          </div>
        </div>
        {listError ? <p className="mt-2 text-xs text-rose-600">{listError}</p> : null}
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full table-fixed text-center text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="w-[18%] px-3 py-2 text-left">이름</th>
                <th className="w-[20%] px-3 py-2">수집</th>
                <th className="w-[10%] px-3 py-2">매핑수</th>
                <th className="w-[16%] px-3 py-2">스케줄</th>
                <th className="w-[18%] px-3 py-2">최근 실행</th>
                <th className="w-[18%] px-3 py-2">작업</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.length === 0 ? (
                <tr>
                  <td className="px-2 py-4 text-slate-500" colSpan={6}>
                    등록된 파이프라인이 없습니다.
                  </td>
                </tr>
              ) : (
                pipelines.map((p) => (
                  <tr key={p.pipeline_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-left font-medium text-slate-800">{p.name}</td>
                    <td className="px-3 py-2 text-slate-600">{p.collection_label ?? "미지정"}</td>
                    <td className="px-3 py-2 text-slate-600">{p.map_count}건</td>
                    <td className="px-3 py-2 text-slate-500">{scheduleLabel(p)}</td>
                    <td className="px-3 py-2 text-slate-500">
                      <div>{p.last_run_at ? new Date(p.last_run_at).toLocaleString("ko-KR") : "-"}</div>
                      <div
                        className={`text-[11px] ${
                          p.last_status === "success"
                            ? "text-emerald-700"
                            : p.last_status === "error"
                              ? "text-rose-600"
                              : "text-slate-400"
                        }`}
                      >
                        {p.last_status ?? "미실행"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleRunById(p.pipeline_id)}
                          disabled={runningId === p.pipeline_id}
                          className="rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {runningId === p.pipeline_id ? "실행 중…" : "즉시 실행"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void openRuns(p.pipeline_id, p.name)}
                          className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          이력
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {runModalOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-900/45 p-4">
          <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4">
              <h4 className="text-sm font-semibold text-slate-900">{runModalTitle} 실행 이력</h4>
              <button
                type="button"
                onClick={() => setRunModalOpen(false)}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {runsLoading ? <p className="text-xs text-slate-500">불러오는 중...</p> : null}
              {runsError ? <p className="text-xs text-rose-600">{runsError}</p> : null}
              {!runsLoading && !runsError && runs.length === 0 ? (
                <p className="text-xs text-slate-500">실행 이력이 없습니다.</p>
              ) : null}
              {!runsLoading && runs.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2">시작</th>
                        <th className="px-3 py-2">유형</th>
                        <th className="px-3 py-2">상태</th>
                        <th className="px-3 py-2">결과</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => {
                        const ok = (r.step_results ?? []).filter((s) => s.status === "success").length;
                        const err = (r.step_results ?? []).filter((s) => s.status === "error").length;
                        return (
                          <tr key={r.run_log_id} className="border-t border-slate-100">
                            <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                              {new Date(r.started_at).toLocaleString("ko-KR")}
                            </td>
                            <td className="px-3 py-1.5 text-slate-600">{r.trigger_type === "schedule" ? "자동" : "수동"}</td>
                            <td className="px-3 py-1.5">
                              <span
                                className={
                                  r.status === "success"
                                    ? "text-emerald-700"
                                    : r.status === "error"
                                      ? "text-rose-600"
                                      : "text-slate-500"
                                }
                              >
                                {r.status}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-slate-600">
                              성공 {ok}{err ? ` · 실패 ${err}` : ""}
                              {r.error_message ? <span className="ml-1 text-rose-600">({r.error_message})</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

