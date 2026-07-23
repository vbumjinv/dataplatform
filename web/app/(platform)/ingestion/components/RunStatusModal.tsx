"use client";

// 수집/매핑/파이프라인 공용 실행 상태 모달 (적재·생성·실행 중 스피너 + 결과).
export type RunState = "loading" | "success" | "error" | "cancelled";

export default function RunStatusModal({
  open,
  state,
  title,
  message,
  subMessage,
  onConfirm,
  loadingAction,
}: {
  open: boolean;
  state: RunState;
  title: string;
  message?: string;
  subMessage?: string;
  onConfirm?: () => void;
  loadingAction?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  if (!open) return null;

  const tone =
    state === "success"
      ? { bg: "bg-emerald-100", text: "text-emerald-700", icon: "✓" }
      : state === "cancelled"
        ? { bg: "bg-amber-100", text: "text-amber-700", icon: "■" }
        : { bg: "bg-rose-100", text: "text-rose-700", icon: "!" };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/50 p-6 backdrop-blur-[1px]">
      <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          {state === "loading" ? (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
            </div>
          ) : (
            <div className={`flex h-14 w-14 items-center justify-center rounded-full ${tone.bg} ${tone.text}`}>
              <span className="text-2xl leading-none">{tone.icon}</span>
            </div>
          )}
          <p
            className={`mt-4 text-base font-semibold ${
              state === "loading" ? "text-slate-900" : tone.text
            }`}
          >
            {title}
          </p>
          {message ? <p className="mt-1 text-xs text-slate-600">{message}</p> : null}
          {subMessage ? <p className="mt-1 text-[11px] text-slate-500">{subMessage}</p> : null}
        </div>

        {state === "loading" ? (
          loadingAction ? (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={loadingAction.onClick}
                disabled={loadingAction.disabled}
                className="rounded-full border border-rose-200 bg-rose-50 px-5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              >
                {loadingAction.label}
              </button>
            </div>
          ) : null
        ) : (
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-full bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              확인
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
