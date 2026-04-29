'use client';

import { useState } from "react";
import type { IngestionKind, StorageKind } from "../types";

interface NodeSidebarProps {
  onAddNode: (
    type: "dataCollector" | "dbSink" | "dataStorage",
    kind?: IngestionKind | StorageKind,
  ) => void;
}

const ingestionItems: Array<{
  kind: IngestionKind;
  title: string;
  description: string;
}> = [
  { kind: "excel", title: "엑셀 업로드", description: "파일 기반 업로드" },
  { kind: "api", title: "API 수집", description: "HTTP 엔드포인트 호출" },
  { kind: "db", title: "DB 조회", description: "데이터베이스 조회" },
];

const integrationItems = [
  {
    type: "dbSink" as const,
    kind: undefined,
    title: "DB 설정",
    description: "데이터베이스 연결 설정",
  },
];

const storageItems: Array<{
  kind: StorageKind;
  title: string;
  description: string;
}> = [
  { kind: "dbSave", title: "DB 저장", description: "DB로 데이터 저장" },
  { kind: "fileSave", title: "파일 저장", description: "파일로 데이터 저장" },
];

const tabs = [
  { id: "integration", label: "DB 연동", items: integrationItems },
  {
    id: "ingestion",
    label: "데이터 조회 & 수집",
    items: ingestionItems.map((item) => ({
      type: "dataCollector" as const,
      kind: item.kind,
      title: item.title,
      description: item.description,
    })),
  },
  {
    id: "storage",
    label: "데이터 저장",
    items: storageItems.map((item) => ({
      type: "dataStorage" as const,
      kind: item.kind,
      title: item.title,
      description: item.description,
    })),
  },
] as const;

type TabId = (typeof tabs)[number]["id"];

export function NodeSidebar({ onAddNode }: NodeSidebarProps) {
  const [openTabs, setOpenTabs] = useState<Set<TabId>>(
    () => new Set<TabId>(),
  );

  const toggleTab = (tabId: TabId) => {
    setOpenTabs((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-slate-900">노드 라이브러리</p>
        <p className="text-xs text-slate-500">
          필요한 기능 노드를 캔버스에 배치하세요.
        </p>
      </div>

      <div className="space-y-3">
        {tabs.map((tab) => {
          const isOpen = openTabs.has(tab.id);
          return (
            <div key={tab.id} className="space-y-2">
              <button
                type="button"
                onClick={() => toggleTab(tab.id)}
                className="flex w-full items-center justify-between rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] text-slate-400 transition ${
                    isOpen ? "rotate-180" : ""
                  }`}
                >
                  ▼
                </span>
              </button>
              {isOpen ? (
                <div className="space-y-2">
                  {tab.items.map((item) => (
                    <div
                      key={`${item.type}-${item.kind ?? item.title}`}
                      role="button"
                      tabIndex={0}
                      draggable
                      onDoubleClick={() => onAddNode(item.type, item.kind)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onAddNode(item.type, item.kind);
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          "application/reactflow",
                          item.type === "dataCollector"
                            ? `dataCollector|${item.kind}`
                            : item.type === "dataStorage"
                              ? `dataStorage|${item.kind}`
                              : "dbSink",
                        );
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      className="flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left text-xs transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                        <svg
                          viewBox="0 0 24 24"
                          className="h-5 w-5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        >
                          <rect x="3" y="4" width="18" height="6" rx="2" />
                          <rect x="3" y="14" width="18" height="6" rx="2" />
                          <path d="M7 8h.01M7 18h.01" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {item.title}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
