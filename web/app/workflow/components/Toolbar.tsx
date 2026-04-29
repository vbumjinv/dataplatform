'use client';

interface ToolbarProps {
  onRunAll: () => void;
  onExport: () => void;
  onImport: () => void;
  onImportJson: () => void;
  onReset: () => void;
  onResetRun: () => void;
  running?: boolean;
}

export function Toolbar({
  onRunAll,
  onExport,
  onImport,
  onImportJson,
  onReset,
  onResetRun,
  running = false,
}: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Workflow Controls
        </p>
        <p className="text-sm font-semibold text-slate-900">
          파이프라인 실행 및 상태 관리
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col items-start gap-1">
          <span className="text-[10px] font-semibold text-slate-400">
            실행/초기화
          </span>
          <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onRunAll}
            className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            disabled={running}
          >
            {running ? "실행 중..." : "전체 실행"}
          </button>
          <button
            onClick={onResetRun}
            className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            실행 결과 초기화
          </button>
          <button
            onClick={onReset}
            className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            워크플로우 초기화
          </button>
          </div>
        </div>
        <div className="flex flex-col items-start gap-1">
          <span className="text-[10px] font-semibold text-slate-400">
            저장/불러오기
          </span>
          <div className="flex flex-wrap items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
            <button
              onClick={onExport}
              className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100"
            >
              저장하기
            </button>
            <button
              onClick={onImport}
              className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100"
            >
              불러오기
            </button>
            <button
              onClick={onImportJson}
              className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100"
            >
              JSON 가져오기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
