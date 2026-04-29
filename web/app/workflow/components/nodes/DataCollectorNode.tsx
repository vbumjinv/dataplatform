'use client';

import { Handle, NodeProps, Position } from "reactflow";
import { useWorkflowActions } from "../WorkflowContext";
import type { DataCollectorData } from "../../types";

const statusStyles: Record<
  DataCollectorData["status"],
  { label: string; className: string }
> = {
  idle: {
    label: "대기",
    className:
      "bg-slate-300 text-slate-700 shadow-[0_0_6px_rgba(148,163,184,0.9)]",
  },
  running: {
    label: "실행",
    className:
      "bg-blue-500 text-blue-50 shadow-[0_0_8px_rgba(59,130,246,0.9)]",
  },
  success: {
    label: "완료",
    className:
      "bg-emerald-500 text-emerald-50 shadow-[0_0_8px_rgba(16,185,129,0.9)]",
  },
  error: {
    label: "오류",
    className:
      "bg-rose-500 text-rose-50 shadow-[0_0_8px_rgba(244,63,94,0.9)]",
  },
};

export function DataCollectorNode({ id, data, selected }: NodeProps<DataCollectorData>) {
  const { onRunNode, onSelectNode, onDeleteNode, onOpenNodeMenu } =
    useWorkflowActions();
  const status = statusStyles[data.status];
  const showDbConfigHandle = data.kind === "dbSink";
  const showDbSaveHandles = data.kind === "dbSave";
  const showFileSaveHandle = data.kind === "fileSave";
  const showDbQueryHandles = data.kind === "db";
  const showExcelHandle = data.kind === "excel";
  const showApiHandle = data.kind === "api";

  return (
    <div
      className={`group relative flex w-16 flex-col items-center justify-center gap-1 overflow-visible rounded-2xl border border-slate-200 bg-white px-1.5 py-2 shadow-sm transition ring-2 ring-transparent hover:shadow-md ${
        selected ? "ring-blue-300" : ""
      }`}
      onClick={() => onSelectNode(id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenNodeMenu(id, { x: event.clientX, y: event.clientY });
      }}
      title={data.label ?? "Data Collector"}
    >
      {showDbSaveHandles || showDbQueryHandles || showFileSaveHandle ? (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={true}
          className="!h-3 !w-3 !border-2 !border-white !bg-slate-400"
          style={{ zIndex: 10 }}
        />
      ) : null}
      {showDbConfigHandle ||
      showDbSaveHandles ||
      showDbQueryHandles ||
      showExcelHandle ||
      showApiHandle ? (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={true}
          className="!h-3 !w-3 !border-2 !border-white !bg-slate-400"
          style={{ zIndex: 10 }}
        />
      ) : null}
      <button
        onClick={(event) => {
          event.stopPropagation();
          onDeleteNode(id);
        }}
        className="absolute -right-1.5 -top-1.5 cursor-pointer rounded-full border border-slate-200 bg-white px-1 text-[10px] font-semibold text-slate-500 opacity-0 shadow-sm transition hover:border-slate-300 hover:bg-rose-50 hover:text-rose-600 hover:shadow group-hover:opacity-100"
        aria-label="노드 삭제"
      >
        ×
      </button>
      <div className="relative flex h-9 w-9 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <rect x="3" y="4" width="18" height="6" rx="2" />
          <rect x="3" y="14" width="18" height="6" rx="2" />
          <path d="M7 8h.01M7 18h.01" />
        </svg>
        <span
          className={`absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-white ${status.className}`}
          aria-label={status.label}
        />
      </div>
      <span className="text-[10px] font-semibold text-slate-900">
        {data.label}
      </span>
    </div>
  );
}
