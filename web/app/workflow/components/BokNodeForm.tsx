"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BOK_CYCLE_LABELS, BOK_CYCLES, primaryBokCycle } from "../lib/bok";
import type { BokCycle, BokNodeOptions } from "../types";

type BokStatItem = {
  p_stat_code: string;
  stat_code: string;
  stat_name: string;
  cycle: string;
  srch_yn: string;
  org_name: string;
};

type BokStatNode = BokStatItem & {
  children: BokStatNode[];
  searchable: boolean;
};

const isSearchable = (item: BokStatItem) => item.srch_yn.trim().toUpperCase() === "Y";

const buildStatTree = (items: BokStatItem[]) => {
  const nodeMap = new Map<string, BokStatNode>();
  items.forEach((item) => {
    if (!item.stat_code) return;
    nodeMap.set(item.stat_code, {
      ...item,
      children: [],
      searchable: isSearchable(item),
    });
  });

  const roots: BokStatNode[] = [];
  nodeMap.forEach((node) => {
    const parent = nodeMap.get(node.p_stat_code);
    if (!node.p_stat_code || node.p_stat_code === "*" || !parent || parent === node) {
      roots.push(node);
      return;
    }
    parent.children.push(node);
  });

  const sortNodes = (nodes: BokStatNode[]) => {
    nodes.sort((left, right) =>
      left.stat_name.localeCompare(right.stat_name, "ko", { numeric: true }),
    );
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
};

type RegisteredKey = {
  id: number;
  name: string;
  apiKey: string;
};

const DATE_MIN = "1000-01-01";
const DATE_MAX = "9999-12-31";

const clampDateValue = (value: string) => {
  const match = /^(\d+)-(\d{2})-(\d{2})$/.exec(value);
  if (!match || match[1].length <= 4) return value;
  return `${match[1].slice(0, 4)}-${match[2]}-${match[3]}`;
};

const DATE_RANGES = [
  { id: "1y", label: "최근 1년", months: 12 },
  { id: "6m", label: "최근 6개월", months: 6 },
  { id: "3m", label: "최근 3개월", months: 3 },
  { id: "1m", label: "최근 1개월", months: 1 },
] as const;

const formatInputDate = (date: Date) => {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const shiftMonths = (date: Date, months: number) => {
  const next = new Date(date.getFullYear(), date.getMonth(), 1);
  next.setMonth(next.getMonth() - months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), lastDay));
  return next;
};

export function BokNodeForm({
  options,
  onChange,
}: {
  options: BokNodeOptions;
  onChange: (options: BokNodeOptions) => void;
}) {
  const [keys, setKeys] = useState<RegisteredKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const syncedKeyRef = useRef(false);
  const [stats, setStats] = useState<BokStatItem[]>([]);
  const [statStatus, setStatStatus] = useState("");
  const [isStatOpen, setIsStatOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadKeys = async () => {
      try {
        const response = await fetch("/api/ingestion/api-config");
        const payload = (await response.json()) as {
          ok?: boolean;
          sources?: Array<{
            id: number;
            name?: string;
            provider?: string;
            api_key?: string | null;
            enabled?: boolean;
          }>;
        };
        if (!response.ok || !payload.ok || cancelled) return;
        setKeys(
          (payload.sources ?? [])
            .filter(
              (source) =>
                source.enabled !== false &&
                String(source.provider ?? "").toLowerCase() === "bok" &&
                String(source.api_key ?? "").trim(),
            )
            .map((source) => ({
              id: source.id,
              name: source.name?.trim() || `기관 ${source.id}`,
              apiKey: String(source.api_key ?? ""),
            })),
        );
      } catch {
        if (!cancelled) setKeys([]);
      }
    };
    void loadKeys();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (syncedKeyRef.current || keys.length === 0) return;
    syncedKeyRef.current = true;
    const matched = keys.find((item) => item.apiKey && item.apiKey === options.apiKey);
    if (matched) setSelectedKeyId(String(matched.id));
  }, [keys, options.apiKey]);

  useEffect(() => {
    if (!isStatOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isStatOpen]);

  const update = (patch: Partial<BokNodeOptions>) => {
    onChange({ ...options, ...patch });
  };

  const selectKeySource = (nextId: string) => {
    setSelectedKeyId(nextId);
    if (!nextId) {
      update({ apiKey: "" });
      return;
    }
    const selected = keys.find((item) => String(item.id) === nextId);
    if (selected) update({ apiKey: selected.apiKey });
  };

  const openStatList = async () => {
    setIsStatOpen(true);
    if (stats.length > 0) return;
    setStatStatus("통계표 목록을 불러오는 중입니다.");
    try {
      const response = await fetch("/api/ingestion/bok-stat-list");
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        items?: BokStatItem[];
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "통계표 목록을 불러오지 못했습니다.");
      }
      setStats(payload.items ?? []);
      setStatStatus("");
    } catch (error) {
      setStatStatus(
        error instanceof Error ? error.message : "통계표 목록을 불러오지 못했습니다.",
      );
    }
  };

  const applyDateRange = (months: number) => {
    const end = new Date();
    const start = shiftMonths(end, months);
    update({
      startDate: formatInputDate(start),
      endDate: formatInputDate(end),
    });
  };

  return (
    <div className="space-y-4 sm:col-span-2">
      <label className="block space-y-1 text-sm text-slate-800">
        <span className="text-xs text-slate-600">키 선택</span>
        <select
          value={selectedKeyId}
          onChange={(event) => selectKeySource(event.target.value)}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
        >
          <option value="">직접 입력</option>
          {keys.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm text-slate-800">
        <span className="text-xs text-slate-600">API KEY</span>
        <input
          value={options.apiKey}
          onChange={(event) => update({ apiKey: event.target.value })}
          disabled={Boolean(selectedKeyId)}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
          placeholder={selectedKeyId ? "" : "발급받은 키 입력"}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="space-y-1 text-sm text-slate-800">
          <span className="text-xs text-slate-600">통계코드</span>
          <input
            value={options.statCode}
            onChange={(event) => update({ statCode: event.target.value, statName: "" })}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
            placeholder="예: 722Y001"
          />
        </label>
        <button
          type="button"
          onClick={() => void openStatList()}
          className="self-end rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
        >
          통계표 찾기
        </button>
      </div>
      {options.statName ? (
        <p className="text-xs text-slate-500">{options.statName}</p>
      ) : null}
      <label className="block space-y-1 text-sm text-slate-800">
        <span className="text-xs text-slate-600">주기</span>
        <select
          value={options.cycle}
          onChange={(event) => update({ cycle: event.target.value as BokCycle })}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
        >
          {BOK_CYCLES.map((cycle) => (
            <option key={cycle} value={cycle}>
              {BOK_CYCLE_LABELS[cycle]} ({cycle})
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        {DATE_RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            onClick={() => applyDateRange(range.months)}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            {range.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-800">
          <span className="text-xs text-slate-600">시작일</span>
          <input
            type="date"
            min={DATE_MIN}
            max={DATE_MAX}
            value={options.startDate}
            onChange={(event) =>
              update({ startDate: clampDateValue(event.target.value) })
            }
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
          />
        </label>
        <label className="space-y-1 text-sm text-slate-800">
          <span className="text-xs text-slate-600">종료일</span>
          <input
            type="date"
            min={DATE_MIN}
            max={DATE_MAX}
            value={options.endDate}
            onChange={(event) =>
              update({ endDate: clampDateValue(event.target.value) })
            }
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
          />
        </label>
      </div>
      {isStatOpen
        ? createPortal(
            <BokStatModal
              stats={stats}
              status={statStatus}
              initialCode={options.statCode}
              onConfirm={(item) => {
                update({
                  statCode: item.stat_code,
                  statName: item.stat_name,
                  cycle: primaryBokCycle(item.cycle),
                });
                setIsStatOpen(false);
              }}
              onClose={() => setIsStatOpen(false)}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function BokStatModal({
  stats,
  status,
  initialCode,
  onConfirm,
  onClose,
}: {
  stats: BokStatItem[];
  status: string;
  initialCode: string;
  onConfirm: (item: BokStatItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set());
  const [selectedCode, setSelectedCode] = useState(initialCode);
  const tree = useMemo(() => buildStatTree(stats), [stats]);
  const results = useMemo(() => {
    const keyword = appliedQuery.trim().toLowerCase();
    if (!keyword) return [];
    return stats
      .filter(
        (item) =>
          isSearchable(item) &&
          `${item.stat_code} ${item.stat_name} ${item.org_name} ${item.cycle}`
            .toLowerCase()
            .includes(keyword),
      )
      .slice(0, 100);
  }, [appliedQuery, stats]);
  const selected = stats.find((item) => item.stat_code === selectedCode && isSearchable(item));

  const toggle = (code: string) => {
    setExpandedCodes((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-6">
      <div className="flex h-[min(820px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-900">통계표를 선택해주세요</h3>
            <p className="mt-2 text-sm text-slate-600">
              이름 중심으로 통계표를 찾고 선택할 수 있습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            닫기
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setAppliedQuery(query.trim());
              }
            }}
            placeholder="통계표명 또는 통계표 코드로 검색"
            className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-slate-400"
            autoFocus
          />
          <button
            type="button"
            onClick={() => setAppliedQuery(query.trim())}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            검색
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setAppliedQuery("");
            }}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            초기화
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          {appliedQuery
            ? `검색어 "${appliedQuery}" — 선택 가능한 통계표만 표시합니다.`
            : "기본 상태는 접힘입니다. 분류 카드를 눌러 펼쳐보세요."}
        </p>

        <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
          {status ? (
            <p className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-5 text-sm text-slate-500">
              {status}
            </p>
          ) : appliedQuery ? (
            results.length > 0 ? (
              results.map((item) => (
                <StatCard
                  key={item.stat_code}
                  item={item}
                  selected={selectedCode === item.stat_code}
                  expandable={false}
                  expanded={false}
                  onToggle={() => undefined}
                  onSelect={() => setSelectedCode(item.stat_code)}
                />
              ))
            ) : (
              <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
            )
          ) : tree.length > 0 ? (
            tree.map((node) => (
              <StatBranch
                key={node.stat_code}
                node={node}
                expandedCodes={expandedCodes}
                selectedCode={selectedCode}
                onToggle={toggle}
                onSelect={setSelectedCode}
              />
            ))
          ) : (
            <p className="px-2 py-4 text-sm text-slate-500">통계표 목록이 없습니다.</p>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          선택된 통계표:{" "}
          {selected ? `${selected.stat_name} (${selected.stat_code})` : "없음"}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            취소
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => {
              if (selected) onConfirm(selected);
            }}
            className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            선택
          </button>
        </div>
      </div>
    </div>
  );
}

function StatBranch({
  node,
  expandedCodes,
  selectedCode,
  onToggle,
  onSelect,
}: {
  node: BokStatNode;
  expandedCodes: Set<string>;
  selectedCode: string;
  onToggle: (code: string) => void;
  onSelect: (code: string) => void;
}) {
  const expanded = expandedCodes.has(node.stat_code);
  return (
    <div
      className={`rounded-xl border ${
        selectedCode === node.stat_code && node.searchable
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-200 bg-white"
      }`}
    >
      <StatCard
        item={node}
        selected={selectedCode === node.stat_code && node.searchable}
        expandable={node.children.length > 0}
        expanded={expanded}
        nested
        onToggle={() => onToggle(node.stat_code)}
        onSelect={() => {
          if (node.children.length > 0 && !node.searchable) {
            onToggle(node.stat_code);
            return;
          }
          if (node.searchable) onSelect(node.stat_code);
        }}
      />
      {node.children.length > 0 && expanded ? (
        <div className="space-y-2 border-t border-slate-100 px-2 pb-2 pt-2">
          <div className="space-y-2 pl-3">
            {node.children.map((child) => (
              <StatBranch
                key={child.stat_code}
                node={child}
                expandedCodes={expandedCodes}
                selectedCode={selectedCode}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  item,
  selected,
  expandable,
  expanded,
  nested = false,
  onToggle,
  onSelect,
}: {
  item: BokStatItem;
  selected: boolean;
  expandable: boolean;
  expanded: boolean;
  nested?: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const searchable = isSearchable(item);
  const button = (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
        selected ? "text-white" : "text-slate-900"
      }`}
    >
      {expandable ? (
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            selected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
          }`}
        >
          {expanded ? "접기" : "펼치기"}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <p className={`truncate text-sm font-semibold ${searchable || selected ? "" : "text-slate-600"}`}>
          {item.stat_name || item.stat_code}
        </p>
        <p className="text-[11px] opacity-80">
          코드 {searchable ? item.stat_code : "-"}
          {item.cycle ? ` / 주기 ${item.cycle}` : ""}
          {searchable ? " / 선택 가능" : " / 분류"}
        </p>
      </span>
    </button>
  );

  if (nested) return button;

  return (
    <div className={`rounded-xl border ${selected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700"}`}>
      {button}
    </div>
  );
}
