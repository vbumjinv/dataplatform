"use client";

import { useEffect, useMemo, useState } from "react";

type MappingTargetItem = {
  sourceOrg: string;
  apiName: string;
  targetTable: string;
  sourceTable: string;
  hasMapping: boolean;
  isActive: boolean;
  mapId: number | null;
};

type MappingRow = {
  mapId: number;
  sourceOrg: string;
  apiName: string;
  sourceTable: string;
  seriesName: string;
  seriesKey: string | null;
  dateColumn: string;
  dateFormat: string | null;
  valueColumn: string;
  whereClause: string | null;
  unitName: string | null;
  freq: string | null;
  isActive: boolean;
  dataCount: number;
  dataStartDate: string | null;
  dataEndDate: string | null;
  lastGeneratedAt: string | null;
};

type ColumnItem = {
  name: string;
  dataType: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

const initialForm = {
  mapId: null as number | null,
  sourceOrg: "",
  apiName: "",
  sourceTable: "",
  seriesName: "",
  seriesKey: "",
  dateColumn: "",
  dateFormat: "",
  valueColumn: "",
  whereClause: "",
  unitName: "",
  freq: "",
  isActive: true,
};

export default function DataMappingManagerModal({ open, onClose }: Props) {
  const [targets, setTargets] = useState<MappingTargetItem[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsError, setTargetsError] = useState("");
  const [query, setQuery] = useState("");

  const [columns, setColumns] = useState<ColumnItem[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError, setColumnsError] = useState("");

  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsError, setMappingsError] = useState("");

  const [form, setForm] = useState(initialForm);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewRows, setPreviewRows] = useState<
    Array<{ rawDate: string | null; rawValue: string | null; obsDate: string | null; obsValue: number | null }>
  >([]);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [generateStatus, setGenerateStatus] = useState("");
  const [lastGenerateResult, setLastGenerateResult] = useState<{
    affectedCount: number;
    startDate: string | null;
    endDate: string | null;
    generatedAt: string;
  } | null>(null);

  const filteredTargets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((item) =>
      [
        item.sourceOrg,
        item.apiName,
        item.targetTable,
        item.sourceTable,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [query, targets]);

  const fetchTargets = async () => {
    setTargetsLoading(true);
    setTargetsError("");
    try {
      const response = await fetch("/api/visualization/map-targets");
      const payload = (await response.json()) as {
        ok?: boolean;
        items?: MappingTargetItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "매핑 대상을 불러오지 못했습니다.");
      }
      setTargets(payload.items ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "매핑 대상을 불러오지 못했습니다.";
      setTargetsError(message);
    } finally {
      setTargetsLoading(false);
    }
  };

  const fetchMappings = async () => {
    setMappingsLoading(true);
    setMappingsError("");
    try {
      const response = await fetch("/api/visualization/map-mst");
      const payload = (await response.json()) as {
        ok?: boolean;
        items?: MappingRow[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "매핑 목록을 불러오지 못했습니다.");
      }
      const items = payload.items ?? [];
      setMappings(items);
      return items;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "매핑 목록을 불러오지 못했습니다.";
      setMappingsError(message);
    } finally {
      setMappingsLoading(false);
    }
    return [] as MappingRow[];
  };

  const fetchColumns = async (sourceTable: string) => {
    setColumns([]);
    setColumnsError("");
    if (!sourceTable.trim()) return;
    setColumnsLoading(true);
    try {
      const response = await fetch(
        `/api/visualization/map-columns?table=${encodeURIComponent(sourceTable.trim())}`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        columns?: ColumnItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "컬럼 목록을 불러오지 못했습니다.");
      }
      setColumns(payload.columns ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "컬럼 목록을 불러오지 못했습니다.";
      setColumnsError(message);
    } finally {
      setColumnsLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void fetchTargets();
    void fetchMappings();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void fetchColumns(form.sourceTable);
  }, [form.sourceTable, open]);

  const fillFromTarget = (item: MappingTargetItem) => {
    setForm((prev) => ({
      ...prev,
      mapId: null,
      sourceOrg: item.sourceOrg,
      apiName: item.apiName,
      sourceTable: item.sourceTable,
      seriesName: "",
      seriesKey: "",
      dateColumn: "",
      dateFormat: "",
      valueColumn: "",
      whereClause: "",
      unitName: "",
      freq: "",
      isActive: true,
    }));
    setSaveError("");
    setSaveStatus("");
    setPreviewRows([]);
    setPreviewError("");
    setGenerateError("");
    setGenerateStatus("");
    setLastGenerateResult(null);
  };

  const fillFromMapping = (item: MappingRow) => {
    setForm({
      mapId: item.mapId,
      sourceOrg: item.sourceOrg,
      apiName: item.apiName,
      sourceTable: item.sourceTable,
      seriesName: item.seriesName,
      seriesKey: item.seriesKey ?? "",
      dateColumn: item.dateColumn,
      dateFormat: item.dateFormat ?? "",
      valueColumn: item.valueColumn,
      whereClause: item.whereClause ?? "",
      unitName: item.unitName ?? "",
      freq: item.freq ?? "",
      isActive: item.isActive,
    });
    setSaveError("");
    setSaveStatus("");
    setPreviewRows([]);
    setPreviewError("");
    setGenerateError("");
    setGenerateStatus("");
    setLastGenerateResult(
      item.lastGeneratedAt
        ? {
            affectedCount: item.dataCount,
            startDate: item.dataStartDate,
            endDate: item.dataEndDate,
            generatedAt: item.lastGeneratedAt,
          }
        : null,
    );
  };

  const canSave =
    form.sourceTable.trim().length > 0 &&
    form.seriesName.trim().length > 0 &&
    form.dateColumn.trim().length > 0 &&
    form.valueColumn.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaveBusy(true);
    setSaveError("");
    setSaveStatus("");
    try {
      const body = {
        sourceOrg: form.sourceOrg.trim(),
        apiName: form.apiName.trim(),
        sourceTable: form.sourceTable.trim(),
        seriesName: form.seriesName.trim(),
        seriesKey: form.seriesKey.trim() || null,
        dateColumn: form.dateColumn.trim(),
        dateFormat: form.dateFormat.trim() || null,
        valueColumn: form.valueColumn.trim(),
        whereClause: form.whereClause.trim() || null,
        unitName: form.unitName.trim() || null,
        freq: form.freq.trim() || null,
        isActive: form.isActive,
      };

      const endpoint =
        form.mapId == null
          ? "/api/visualization/map-mst"
          : `/api/visualization/map-mst/${form.mapId}`;
      const method = form.mapId == null ? "POST" : "PATCH";
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; mapId?: number };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "저장에 실패했습니다.");
      }
      if (Number.isFinite(payload.mapId)) {
        setForm((prev) => ({ ...prev, mapId: Number(payload.mapId) }));
      }
      setSaveStatus("저장되었습니다.");
      const latestMappings = await fetchMappings();
      await fetchTargets();
      const savedMapId = Number.isFinite(payload.mapId) ? Number(payload.mapId) : form.mapId;
      if (savedMapId) {
        const matched = latestMappings.find((item) => item.mapId === savedMapId);
        if (matched) {
          setLastGenerateResult(
            matched.lastGeneratedAt
              ? {
                  affectedCount: matched.dataCount,
                  startDate: matched.dataStartDate,
                  endDate: matched.dataEndDate,
                  generatedAt: matched.lastGeneratedAt,
                }
              : null,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장에 실패했습니다.";
      setSaveError(message);
    } finally {
      setSaveBusy(false);
    }
  };

  const canUseDataAction = form.mapId != null;

  const handlePreview = async () => {
    if (!canUseDataAction) return;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const response = await fetch(`/api/visualization/map-mst/${form.mapId}/preview?limit=10`);
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        rows?: Array<{
          rawDate: string | null;
          rawValue: string | null;
          obsDate: string | null;
          obsValue: number | null;
        }>;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "미리보기에 실패했습니다.");
      }
      setPreviewRows(payload.rows ?? []);
      if ((payload.rows ?? []).length === 0) {
        setPreviewError("미리보기 결과가 없습니다.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "미리보기에 실패했습니다.";
      setPreviewError(message);
      setPreviewRows([]);
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleGenerate = async (mode: "generate" | "regenerate") => {
    if (!canUseDataAction) return;
    setGenerateBusy(true);
    setGenerateError("");
    setGenerateStatus("");
    try {
      const response = await fetch(`/api/visualization/map-mst/${form.mapId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        affectedCount?: number;
        startDate?: string | null;
        endDate?: string | null;
        generatedAt?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "데이터 생성에 실패했습니다.");
      }
      const generatedAt = payload.generatedAt ?? new Date().toISOString();
      setGenerateStatus(mode === "regenerate" ? "데이터 재생성이 완료되었습니다." : "데이터 생성이 완료되었습니다.");
      setLastGenerateResult({
        affectedCount: Number(payload.affectedCount ?? 0),
        startDate: payload.startDate ?? null,
        endDate: payload.endDate ?? null,
        generatedAt,
      });
      await Promise.all([fetchMappings(), fetchTargets()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "데이터 생성에 실패했습니다.";
      setGenerateError(message);
    } finally {
      setGenerateBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-slate-900/45 p-4">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">데이터 매핑 관리</h3>
            <p className="text-xs text-slate-500">
              원본 테이블 기준으로 그래프 시리즈 매핑을 등록/수정합니다.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            닫기
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[1.25fr_1fr]">
          <div className="min-h-0 border-r border-slate-100 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">매핑 대상</p>
              <button
                type="button"
                onClick={() => void fetchTargets()}
                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
              >
                새로고침
              </button>
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="기관/API/테이블 검색"
              className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
            />
            {targetsError ? <p className="mb-2 text-xs text-rose-600">{targetsError}</p> : null}
            <div className="max-h-[30vh] overflow-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5">기관</th>
                    <th className="px-2 py-1.5">API명</th>
                    <th className="px-2 py-1.5">원본 테이블</th>
                    <th className="px-2 py-1.5">매핑</th>
                    <th className="px-2 py-1.5">상태</th>
                  </tr>
                </thead>
                <tbody>
                  {targetsLoading ? (
                    <tr>
                      <td className="px-2 py-2 text-slate-500" colSpan={5}>
                        불러오는 중...
                      </td>
                    </tr>
                  ) : filteredTargets.length === 0 ? (
                    <tr>
                      <td className="px-2 py-2 text-slate-500" colSpan={5}>
                        대상이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    filteredTargets.map((item, idx) => (
                      <tr
                        key={`${item.sourceOrg}:${item.apiName}:${item.sourceTable}:${idx}`}
                        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                        onClick={() => fillFromTarget(item)}
                      >
                        <td className="px-2 py-1.5">{item.sourceOrg}</td>
                        <td className="px-2 py-1.5">{item.apiName}</td>
                        <td className="px-2 py-1.5">{item.sourceTable}</td>
                        <td className="px-2 py-1.5">{item.hasMapping ? "완료" : "미등록"}</td>
                        <td className="px-2 py-1.5">{item.isActive ? "활성" : "비활성"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">기존 매핑</p>
                <button
                  type="button"
                  onClick={() => void fetchMappings()}
                  className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                >
                  새로고침
                </button>
              </div>
              {mappingsError ? <p className="mb-2 text-xs text-rose-600">{mappingsError}</p> : null}
              <div className="max-h-[24vh] overflow-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5">시리즈명</th>
                      <th className="px-2 py-1.5">테이블</th>
                      <th className="px-2 py-1.5">값 컬럼</th>
                      <th className="px-2 py-1.5">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappingsLoading ? (
                      <tr>
                        <td className="px-2 py-2 text-slate-500" colSpan={4}>
                          불러오는 중...
                        </td>
                      </tr>
                    ) : mappings.length === 0 ? (
                      <tr>
                        <td className="px-2 py-2 text-slate-500" colSpan={4}>
                          저장된 매핑이 없습니다.
                        </td>
                      </tr>
                    ) : (
                      mappings.map((item) => (
                        <tr
                          key={item.mapId}
                          className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                          onClick={() => fillFromMapping(item)}
                        >
                          <td className="px-2 py-1.5">{item.seriesName}</td>
                          <td className="px-2 py-1.5">{item.sourceTable}</td>
                          <td className="px-2 py-1.5">{item.valueColumn}</td>
                          <td className="px-2 py-1.5">{item.isActive ? "활성" : "비활성"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto p-4">
            <p className="mb-3 text-sm font-semibold text-slate-900">매핑 입력/수정</p>
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-slate-600">기관 코드</span>
                  <input
                    value={form.sourceOrg}
                    onChange={(e) => setForm((prev) => ({ ...prev, sourceOrg: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-600">API명</span>
                  <input
                    value={form.apiName}
                    onChange={(e) => setForm((prev) => ({ ...prev, apiName: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  />
                </label>
              </div>

              <label className="space-y-1">
                <span className="text-slate-600">원본 테이블 (필수)</span>
                <input
                  value={form.sourceTable}
                  onChange={(e) => setForm((prev) => ({ ...prev, sourceTable: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-2 py-2"
                />
              </label>

              <label className="space-y-1">
                <span className="text-slate-600">시리즈명 (필수)</span>
                <input
                  value={form.seriesName}
                  onChange={(e) => setForm((prev) => ({ ...prev, seriesName: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-2 py-2"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-slate-600">날짜 컬럼 (필수)</span>
                  <select
                    value={form.dateColumn}
                    onChange={(e) => setForm((prev) => ({ ...prev, dateColumn: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  >
                    <option value="">선택</option>
                    {columns.map((col) => (
                      <option key={`date-${col.name}`} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-600">값 컬럼 (필수)</span>
                  <select
                    value={form.valueColumn}
                    onChange={(e) => setForm((prev) => ({ ...prev, valueColumn: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  >
                    <option value="">선택</option>
                    {columns.map((col) => (
                      <option key={`value-${col.name}`} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {columnsLoading ? <p className="text-slate-500">컬럼 조회 중...</p> : null}
              {columnsError ? <p className="text-rose-600">{columnsError}</p> : null}

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-slate-600">series_key</span>
                  <input
                    value={form.seriesKey}
                    onChange={(e) => setForm((prev) => ({ ...prev, seriesKey: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-600">날짜 포맷</span>
                  <input
                    value={form.dateFormat}
                    onChange={(e) => setForm((prev) => ({ ...prev, dateFormat: e.target.value }))}
                    placeholder="예: YYYYMM / YYYY.MM / YYYY-MM-DD"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-slate-600">단위</span>
                  <input
                    value={form.unitName}
                    onChange={(e) => setForm((prev) => ({ ...prev, unitName: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-600">주기</span>
                  <input
                    value={form.freq}
                    onChange={(e) => setForm((prev) => ({ ...prev, freq: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-2"
                  />
                </label>
              </div>

              <label className="space-y-1">
                <span className="text-slate-600">조건절 (where_clause)</span>
                <textarea
                  value={form.whereClause}
                  onChange={(e) => setForm((prev) => ({ ...prev, whereClause: e.target.value }))}
                  rows={3}
                  className="w-full rounded-lg border border-slate-200 px-2 py-2"
                />
              </label>

              <label className="inline-flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                />
                활성
              </label>
            </div>

            {saveError ? <p className="mt-3 text-xs text-rose-600">{saveError}</p> : null}
            {saveStatus ? <p className="mt-3 text-xs text-emerald-600">{saveStatus}</p> : null}
            {generateError ? <p className="mt-2 text-xs text-rose-600">{generateError}</p> : null}
            {generateStatus ? <p className="mt-2 text-xs text-emerald-600">{generateStatus}</p> : null}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setForm(initialForm)}
                className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                초기화
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!canSave || saveBusy}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {saveBusy ? "저장 중..." : form.mapId ? "수정 저장" : "등록 저장"}
              </button>
              <button
                type="button"
                onClick={() => void handlePreview()}
                disabled={!canUseDataAction || previewBusy}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {previewBusy ? "미리보기 조회 중..." : "미리보기"}
              </button>
              <button
                type="button"
                onClick={() => void handleGenerate("generate")}
                disabled={!canUseDataAction || generateBusy}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generateBusy ? "처리 중..." : "데이터 생성"}
              </button>
              <button
                type="button"
                onClick={() => void handleGenerate("regenerate")}
                disabled={!canUseDataAction || generateBusy}
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generateBusy ? "처리 중..." : "데이터 재생성"}
              </button>
            </div>
            {!canUseDataAction ? (
              <p className="mt-2 text-xs text-slate-500">
                데이터 생성/미리보기는 먼저 저장 후(map_id 생성 후) 실행할 수 있습니다.
              </p>
            ) : null}

            {lastGenerateResult ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <p className="font-semibold text-slate-900">최근 생성 결과</p>
                <p className="mt-1">생성 건수: {lastGenerateResult.affectedCount.toLocaleString()}건</p>
                <p>
                  생성 구간: {lastGenerateResult.startDate ?? "-"} ~ {lastGenerateResult.endDate ?? "-"}
                </p>
                <p>최근 생성 시각: {new Date(lastGenerateResult.generatedAt).toLocaleString()}</p>
              </div>
            ) : null}

            <div className="mt-4">
              <p className="mb-2 text-sm font-semibold text-slate-900">미리보기 샘플 (최대 10건)</p>
              {previewError ? <p className="mb-2 text-xs text-rose-600">{previewError}</p> : null}
              <div className="max-h-[220px] overflow-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5">raw_date</th>
                      <th className="px-2 py-1.5">raw_value</th>
                      <th className="px-2 py-1.5">obs_date</th>
                      <th className="px-2 py-1.5">obs_value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.length === 0 ? (
                      <tr>
                        <td className="px-2 py-2 text-slate-500" colSpan={4}>
                          미리보기 데이터가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      previewRows.map((row, idx) => (
                        <tr key={`preview-${idx}`} className="border-t border-slate-100">
                          <td className="px-2 py-1.5">{row.rawDate ?? "-"}</td>
                          <td className="px-2 py-1.5">{row.rawValue ?? "-"}</td>
                          <td className="px-2 py-1.5">{row.obsDate ?? "-"}</td>
                          <td className="px-2 py-1.5">{row.obsValue ?? "-"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

