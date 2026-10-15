"use client";

import { useEffect, useMemo, useState } from "react";
import {
  FILTER_OPERATORS,
  applyFilterRows,
  valueNeeded,
  type FilterCondition,
  type FilterNodeOptions,
  type FilterOperator,
} from "../lib/filter-rows";
import { readNodeRows } from "../lib/source-rows";
import type { DataCollectorNode } from "../types";

const PREVIEW_LIMITS = [10, 20, 50] as const;

export function FilterNodeForm({
  options,
  source,
  onChange,
}: {
  options: FilterNodeOptions;
  source: DataCollectorNode | null;
  onChange: (options: FilterNodeOptions) => void;
}) {
  const sourceRows = useMemo(() => (source ? readNodeRows(source) : null), [source]);
  const sourceColumns = sourceRows?.columns ?? [];
  const sourceColumnKey = sourceColumns.join("|");
  const [leftPicked, setLeftPicked] = useState<string[]>([]);
  const [rightPicked, setRightPicked] = useState<string[]>([]);
  const [previewLimit, setPreviewLimit] = useState<(typeof PREVIEW_LIMITS)[number]>(10);
  const [preview, setPreview] = useState<{
    columns: string[];
    rows: Record<string, string>[];
    total: number;
  } | null>(null);
  const [previewMessage, setPreviewMessage] = useState("");

  useEffect(() => {
    if (!sourceColumnKey) return;
    const allowed = new Set(sourceColumns);
    const selectedColumns = options.selectedColumns.filter((column) => allowed.has(column));
    const conditions = options.conditions.map((condition) =>
      !condition.column || allowed.has(condition.column)
        ? condition
        : { ...condition, column: "" },
    );
    const sameSelected =
      selectedColumns.length === options.selectedColumns.length &&
      selectedColumns.every((column, index) => column === options.selectedColumns[index]);
    const sameConditions = conditions.every(
      (condition, index) => condition.column === options.conditions[index]?.column,
    );
    if (sameSelected && sameConditions) return;
    onChange({
      ...options,
      columnsChosen: selectedColumns.length > 0,
      selectedColumns,
      conditions,
    });
  }, [onChange, options, sourceColumnKey, sourceColumns]);

  const availableColumns = sourceColumns.filter(
    (column) => !options.selectedColumns.includes(column),
  );
  const chosenColumns = sourceColumns.filter((column) =>
    options.selectedColumns.includes(column),
  );

  const update = (patch: Partial<FilterNodeOptions>) => {
    setPreview(null);
    setPreviewMessage("");
    onChange({ ...options, ...patch });
  };

  const setChosenColumns = (columns: string[]) => {
    const ordered = sourceColumns.filter((column) => columns.includes(column));
    update({ columnsChosen: ordered.length > 0, selectedColumns: ordered });
  };

  const togglePick = (side: "left" | "right", column: string) => {
    const setPicked = side === "left" ? setLeftPicked : setRightPicked;
    setPicked((current) =>
      current.includes(column) ? current.filter((item) => item !== column) : [...current, column],
    );
  };

  const addCondition = () => {
    const condition: FilterCondition = {
      id: `cond-${Date.now()}`,
      column: sourceColumns[0] ?? "",
      operator: "eq",
      value: "",
    };
    update({ conditions: [...options.conditions, condition] });
  };

  const showPreview = () => {
    if (!source || !sourceRows || sourceRows.rows.length === 0) {
      setPreview(null);
      setPreviewMessage("앞 노드를 연결하고 먼저 실행해주세요.");
      return;
    }
    if (options.selectedColumns.length === 0) {
      setPreview(null);
      setPreviewMessage("표시할 컬럼을 선택해주세요.");
      return;
    }
    const filtered = applyFilterRows(sourceRows.rows, {
      ...options,
      columnsChosen: true,
    });
    setPreview({
      columns: options.selectedColumns,
      rows: filtered.slice(0, previewLimit),
      total: filtered.length,
    });
    setPreviewMessage("");
  };

  return (
    <div className="space-y-4 sm:col-span-2">
      <p className="text-xs text-slate-500">
        {source
          ? `앞 노드: ${source.data.label}${
              sourceRows && sourceRows.rows.length > 0
                ? ` · ${sourceRows.rows.length.toLocaleString("ko-KR")}건`
                : " · 실행 결과가 없습니다"
            }`
          : "앞 노드를 연결하면 컬럼을 불러올 수 있습니다."}
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <ColumnList
          title="전체 컬럼"
          columns={availableColumns}
          picked={leftPicked}
          empty="컬럼이 없습니다."
          onToggle={(column) => togglePick("left", column)}
        />
        <div className="flex flex-row items-center justify-center gap-2 sm:flex-col">
          <TransferButton label=">" disabled={leftPicked.length === 0} onClick={() => {
            setChosenColumns([...options.selectedColumns, ...leftPicked]);
            setLeftPicked([]);
          }} />
          <TransferButton label=">>" disabled={availableColumns.length === 0} onClick={() => {
            setChosenColumns([...options.selectedColumns, ...availableColumns]);
            setLeftPicked([]);
          }} />
          <TransferButton label="<" disabled={rightPicked.length === 0} onClick={() => {
            const removing = new Set(rightPicked);
            setChosenColumns(options.selectedColumns.filter((column) => !removing.has(column)));
            setRightPicked([]);
          }} />
          <TransferButton label="<<" disabled={chosenColumns.length === 0} onClick={() => {
            setChosenColumns([]);
            setRightPicked([]);
          }} />
        </div>
        <ColumnList
          title="선택 컬럼"
          columns={chosenColumns}
          picked={rightPicked}
          empty="선택한 컬럼이 없습니다."
          onToggle={(column) => togglePick("right", column)}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-600">조건</span>
          <button
            type="button"
            onClick={addCondition}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            조건 추가
          </button>
        </div>
        <p className="text-xs text-slate-500">조건은 모두 만족하는 행만 남깁니다. 조건이 없으면 선택한 컬럼만 가져옵니다.</p>
        {options.conditions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">
            조건이 없습니다.
          </p>
        ) : (
          <div className="space-y-2">
            {options.conditions.map((condition) => (
              <div key={condition.id} className="grid gap-2 sm:grid-cols-[1fr_8rem_1fr_auto]">
                <select
                  aria-label="조건 컬럼"
                  value={condition.column}
                  onChange={(event) =>
                    update({
                      conditions: options.conditions.map((item) =>
                        item.id === condition.id ? { ...item, column: event.target.value } : item,
                      ),
                    })
                  }
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                >
                  <option value="">컬럼 선택</option>
                  {sourceColumns.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="조건 연산"
                  value={condition.operator}
                  onChange={(event) =>
                    update({
                      conditions: options.conditions.map((item) =>
                        item.id === condition.id
                          ? { ...item, operator: event.target.value as FilterOperator }
                          : item,
                      ),
                    })
                  }
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                >
                  {FILTER_OPERATORS.map((operator) => (
                    <option key={operator.id} value={operator.id}>
                      {operator.label}
                    </option>
                  ))}
                </select>
                {valueNeeded(condition.operator) ? (
                  <input
                    aria-label="조건 값"
                    value={condition.value}
                    onChange={(event) =>
                      update({
                        conditions: options.conditions.map((item) =>
                          item.id === condition.id ? { ...item, value: event.target.value } : item,
                        ),
                      })
                    }
                    placeholder="값"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                  />
                ) : (
                  <span className="flex items-center px-1 text-xs text-slate-400">값 없음</span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    update({
                      conditions: options.conditions.filter((item) => item.id !== condition.id),
                    })
                  }
                  className="rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                >
                  삭제
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-slate-600">미리보기</span>
          <div className="flex items-center gap-2">
            {preview ? (
              <span className="text-xs text-slate-500">
                조건에 맞는 {preview.total.toLocaleString("ko-KR")}건 중{" "}
                {preview.rows.length.toLocaleString("ko-KR")}건
              </span>
            ) : null}
            <select
              aria-label="미리보기 건수"
              value={previewLimit}
              onChange={(event) =>
                setPreviewLimit(Number(event.target.value) as (typeof PREVIEW_LIMITS)[number])
              }
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
            >
              {PREVIEW_LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  {limit}건
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={showPreview}
              className="rounded-full border border-blue-200 bg-blue-50 px-4 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
            >
              미리보기
            </button>
          </div>
        </div>
        {previewMessage ? <p className="text-xs text-rose-600">{previewMessage}</p> : null}
        {preview ? (
          preview.rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">
              조건에 맞는 데이터가 없습니다.
            </p>
          ) : (
            <div className="max-h-56 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full border-collapse text-[11px]">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    {preview.columns.map((column) => (
                      <th
                        key={column}
                        className="whitespace-nowrap border border-slate-200 px-2 py-1 text-left font-semibold"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr key={index} className="bg-white">
                      {preview.columns.map((column) => (
                        <td
                          key={`${index}-${column}`}
                          className="whitespace-nowrap border border-slate-200 px-2 py-1"
                        >
                          {row[column] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : !previewMessage ? (
          <p className="text-xs text-slate-400">미리보기를 누르면 선택한 컬럼과 조건의 결과가 표시됩니다.</p>
        ) : null}
      </div>
    </div>
  );
}

function ColumnList({
  title,
  columns,
  picked,
  empty,
  onToggle,
}: {
  title: string;
  columns: string[];
  picked: string[];
  empty: string;
  onToggle: (column: string) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-slate-600">{title}</span>
      <div className="h-40 space-y-1 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
        {columns.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-400">{empty}</p>
        ) : (
          columns.map((column) => {
            const selected = picked.includes(column);
            return (
              <button
                key={column}
                type="button"
                onClick={() => onToggle(column)}
                className={`block w-full truncate rounded-lg px-2 py-1 text-left text-xs ${
                  selected ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                {column}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function TransferButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}
