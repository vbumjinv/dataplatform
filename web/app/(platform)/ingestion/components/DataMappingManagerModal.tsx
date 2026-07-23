"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import RunStatusModal from "./RunStatusModal";
import SqlEditor from "./SqlEditor";

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
  duplicateDatePolicy: "none" | "sum";
  fillForward: boolean;
  isActive: boolean;
  dataCount: number;
  dataStartDate: string | null;
  dataEndDate: string | null;
  lastGeneratedAt: string | null;
  scheduleEnabled: boolean;
  scheduleType: "interval" | "cron";
  scheduleIntervalMinutes: number | null;
  scheduleCronExpr: string | null;
};

type ColumnItem = {
  name: string;
  dataType: string;
};

type DetailMode = "create" | "edit";
type NoticeTone = "success" | "error";

type Props = {
  open: boolean;
  dbSettingId?: string;
  onClose?: () => void;
  inline?: boolean;
  createRequestKey?: number;
  bulkGenerateRequestKey?: number;
  // 특정 수집 원천 테이블로 스코프(수집 설정의 "데이터 매핑" 버튼에서 사용).
  // 지정 시 목록·대상선택을 해당 원천으로 한정하고 생성폼 원천을 고정한다.
  scopeSourceTable?: string;
  scopeSourceOrg?: string;
  scopeApiName?: string;
};

const mappingsCache = new Map<string, MappingRow[]>();
const toCacheKey = (dbSettingId?: string) => (dbSettingId?.trim() ? `db:${dbSettingId.trim()}` : "db:default");

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
  duplicateDatePolicy: "none" as "none" | "sum",
  fillForward: true,
  isActive: true,
};

export default function DataMappingManagerModal({
  open,
  dbSettingId,
  onClose,
  inline = false,
  createRequestKey,
  bulkGenerateRequestKey,
  scopeSourceTable,
  scopeSourceOrg,
  scopeApiName,
}: Props) {
  const scopeKey = scopeSourceTable?.trim().toLowerCase() ?? "";
  const cacheKey = toCacheKey(dbSettingId);
  const [targets, setTargets] = useState<MappingTargetItem[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsError, setTargetsError] = useState("");
  const [targetQuery, setTargetQuery] = useState("");

  const [columns, setColumns] = useState<ColumnItem[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError, setColumnsError] = useState("");

  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsError, setMappingsError] = useState("");
  const [mappingsLoaded, setMappingsLoaded] = useState(false);
  const [mappingQuery, setMappingQuery] = useState("");

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailMode, setDetailMode] = useState<DetailMode>("edit");
  const [selectedTargetKey, setSelectedTargetKey] = useState("");

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
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [generateStatus, setGenerateStatus] = useState("");
  const [lastGenerateResult, setLastGenerateResult] = useState<{
    mapId: number;
    affectedCount: number;
    startDate: string | null;
    endDate: string | null;
    generatedAt: string;
  } | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    open: boolean;
    title: string;
    message: string;
    tone: NoticeTone;
  }>({
    open: false,
    title: "",
    message: "",
    tone: "success",
  });
  const [generateNotice, setGenerateNotice] = useState<{
    open: boolean;
    type: "loading" | "success" | "error" | "cancelled";
    title: string;
    message: string;
  }>({
    open: false,
    type: "loading",
    title: "",
    message: "",
  });
  const [generateCancelBusy, setGenerateCancelBusy] = useState(false);
  const generateAbortRef = useRef<AbortController | null>(null);
  const generatingMapIdRef = useRef<number | null>(null);
  const bulkCancelRef = useRef(false);

  const cancelGenerate = async () => {
    if (generateCancelBusy) return;
    setGenerateCancelBusy(true);
    bulkCancelRef.current = true;
    try {
      generateAbortRef.current?.abort();
    } catch {
      // ignore
    }
    const mapId = generatingMapIdRef.current;
    if (mapId != null) {
      try {
        await fetch(withDbSettingQuery(`/api/visualization/map-mst/${mapId}/cancel`), { method: "POST" });
      } catch {
        // ignore
      }
    }
  };
  const [mapScheduleTarget, setMapScheduleTarget] = useState<{
    mapId: number;
    name: string;
  } | null>(null);
  const [mapScheduleForm, setMapScheduleForm] = useState({
    enabled: false,
    type: "interval" as "interval" | "cron",
    intervalMinutes: 60,
    cronExpr: "",
  });
  const lastCreateRequestKeyRef = useRef<number | undefined>(createRequestKey);
  const lastBulkGenerateRequestKeyRef = useRef<number | undefined>(bulkGenerateRequestKey);

  const withDbSettingQuery = (path: string) => {
    if (!dbSettingId) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}dbSettingId=${encodeURIComponent(dbSettingId)}`;
  };

  const getTargetRowKey = (item: Pick<MappingTargetItem, "sourceOrg" | "apiName" | "sourceTable">) =>
    `${item.sourceOrg}:${item.apiName}:${item.sourceTable}`;

  const filteredTargets = useMemo(() => {
    let list = targets;
    if (scopeKey) list = list.filter((item) => item.sourceTable.trim().toLowerCase() === scopeKey);
    const q = targetQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((item) =>
      [item.sourceOrg, item.apiName, item.targetTable, item.sourceTable].join(" ").toLowerCase().includes(q),
    );
  }, [targetQuery, targets, scopeKey]);

  const filteredMappings = useMemo(() => {
    let list = mappings;
    if (scopeKey) list = list.filter((item) => item.sourceTable.trim().toLowerCase() === scopeKey);
    const q = mappingQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((item) =>
      [item.seriesName, item.sourceOrg, item.apiName, item.sourceTable].join(" ").toLowerCase().includes(q),
    );
  }, [mappingQuery, mappings, scopeKey]);

  const resetFeedback = () => {
    setSaveError("");
    setSaveStatus("");
    setPreviewRows([]);
    setPreviewError("");
    setGenerateError("");
    setGenerateStatus("");
  };

  const openActionNotice = (title: string, message: string, tone: NoticeTone) => {
    setActionNotice({
      open: true,
      title,
      message,
      tone,
    });
  };

  const resetForm = () => {
    setForm(initialForm);
    setSelectedTargetKey("");
    setLastGenerateResult(null);
    resetFeedback();
  };

  const fetchMappings = async () => {
    setMappingsLoading(true);
    setMappingsError("");
    try {
      const response = await fetch(withDbSettingQuery("/api/visualization/map-mst"));
      const payload = (await response.json()) as { ok?: boolean; items?: MappingRow[]; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "매핑 목록을 불러오지 못했습니다.");
      }
      // 데이터 가공의 출력(파생) 시리즈는 매핑 목록에서 숨긴다.
      const items = (payload.items ?? []).filter(
        (item) => (item.sourceOrg ?? "").toLowerCase() !== "derived",
      );
      setMappings(items);
      setMappingsLoaded(true);
      mappingsCache.set(cacheKey, items);
      return items;
    } catch (error) {
      setMappingsError(error instanceof Error ? error.message : "매핑 목록을 불러오지 못했습니다.");
    } finally {
      setMappingsLoading(false);
    }
    return [] as MappingRow[];
  };

  const fetchTargets = async () => {
    setTargetsLoading(true);
    setTargetsError("");
    try {
      const response = await fetch(withDbSettingQuery("/api/visualization/map-targets"));
      const payload = (await response.json()) as { ok?: boolean; items?: MappingTargetItem[]; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "매핑 대상을 불러오지 못했습니다.");
      }
      setTargets(payload.items ?? []);
    } catch (error) {
      setTargetsError(error instanceof Error ? error.message : "매핑 대상을 불러오지 못했습니다.");
    } finally {
      setTargetsLoading(false);
    }
  };

  const fetchColumns = async (sourceTable: string) => {
    setColumns([]);
    setColumnsError("");
    if (!sourceTable.trim()) return;
    setColumnsLoading(true);
    try {
      const response = await fetch(
        withDbSettingQuery(`/api/visualization/map-columns?table=${encodeURIComponent(sourceTable.trim())}`),
      );
      const payload = (await response.json()) as { ok?: boolean; columns?: ColumnItem[]; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "컬럼 목록을 불러오지 못했습니다.");
      }
      setColumns(payload.columns ?? []);
    } catch (error) {
      setColumnsError(error instanceof Error ? error.message : "컬럼 목록을 불러오지 못했습니다.");
    } finally {
      setColumnsLoading(false);
    }
  };

  useEffect(() => {
    if (inline) {
      if (mappingsLoading) return;
      if (mappingsError) return;
      if (!mappingsLoaded) {
        void fetchMappings();
      }
      return;
    }
    if (!open) return;
    setMappingQuery("");
    setTargetQuery("");
    setDetailOpen(false);
    resetForm();
    void fetchMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, mappingsError, mappingsLoaded, mappingsLoading, open]);

  useEffect(() => {
    const cached = mappingsCache.get(cacheKey);
    if (cached) {
      setMappings(cached);
      setMappingsLoaded(true);
      setMappingsError("");
      return;
    }
    setMappingsLoaded(false);
    setMappings([]);
  }, [cacheKey]);

  useEffect(() => {
    if (!open || !detailOpen) return;
    void fetchColumns(form.sourceTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.sourceTable, open, detailOpen]);

  const openCreateDetail = async () => {
    setDetailMode("create");
    setDetailOpen(true);
    setTargetQuery("");
    resetForm();
    await fetchTargets();
  };

  useEffect(() => {
    if (!open && !inline) return;
    if (createRequestKey == null) return;
    if (createRequestKey === lastCreateRequestKeyRef.current) return;
    lastCreateRequestKeyRef.current = createRequestKey;
    void openCreateDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequestKey, open, inline]);

  useEffect(() => {
    if (!open && !inline) return;
    if (bulkGenerateRequestKey == null) return;
    if (bulkGenerateRequestKey === lastBulkGenerateRequestKeyRef.current) return;
    lastBulkGenerateRequestKeyRef.current = bulkGenerateRequestKey;
    void runBulkGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkGenerateRequestKey, open, inline]);

  // 스코프 지정 + 생성 모드일 때, 사용자가 대상 고르는 단계를 생략하고 자동 선택/프리필.
  useEffect(() => {
    if (!scopeKey) return;
    if (!detailOpen || detailMode !== "create") return;
    if (selectedTargetKey) return;
    if (targetsLoading) return;
    const match = targets.find((t) => t.sourceTable.trim().toLowerCase() === scopeKey);
    if (match) {
      selectTarget(match);
    } else {
      // map-targets 목록에 없으면(아직 미적재 등) 스코프 값으로 직접 프리필.
      selectTarget({
        sourceOrg: scopeSourceOrg ?? "",
        apiName: scopeApiName ?? "",
        sourceTable: scopeSourceTable ?? "",
        targetTable: scopeSourceTable ?? "",
        hasMapping: false,
        isActive: false,
        mapId: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, detailOpen, detailMode, selectedTargetKey, targets, targetsLoading]);

  const openEditDetail = (item: MappingRow) => {
    setDetailMode("edit");
    setDetailOpen(true);
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
      duplicateDatePolicy: item.duplicateDatePolicy ?? "none",
      fillForward: item.fillForward ?? true,
      isActive: item.isActive,
    });
    setSelectedTargetKey(getTargetRowKey(item));
    resetFeedback();
    setLastGenerateResult(
      item.lastGeneratedAt
        ? {
            mapId: item.mapId,
            affectedCount: item.dataCount,
            startDate: item.dataStartDate,
            endDate: item.dataEndDate,
            generatedAt: item.lastGeneratedAt,
          }
        : null,
    );
  };

  const selectTarget = (item: MappingTargetItem) => {
    setSelectedTargetKey(getTargetRowKey(item));
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
      duplicateDatePolicy: "none",
      fillForward: true,
      isActive: true,
    }));
    resetFeedback();
    setLastGenerateResult(null);
  };

  const canSave =
    form.sourceTable.trim().length > 0 &&
    form.seriesName.trim().length > 0 &&
    form.dateColumn.trim().length > 0 &&
    form.valueColumn.trim().length > 0;

  const canUseDataAction = form.mapId != null;

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
        duplicateDatePolicy: form.duplicateDatePolicy,
        fillForward: form.fillForward,
        isActive: form.isActive,
      };

      const endpoint =
        form.mapId == null ? "/api/visualization/map-mst" : `/api/visualization/map-mst/${form.mapId}`;
      const method = form.mapId == null ? "POST" : "PATCH";

      const response = await fetch(withDbSettingQuery(endpoint), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; mapId?: number };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "저장에 실패했습니다.");
      }

      const savedMapId = Number.isFinite(payload.mapId) ? Number(payload.mapId) : form.mapId;
      if (savedMapId) {
        setForm((prev) => ({ ...prev, mapId: savedMapId }));
      }

      if (detailMode === "create") {
        setDetailMode("edit");
      }

      const successMessage = "저장되었습니다.";
      setSaveStatus(successMessage);
      openActionNotice("수정 저장", successMessage, "success");
      await fetchMappings();
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장에 실패했습니다.";
      setSaveError(message);
      openActionNotice("수정 저장", message, "error");
    } finally {
      setSaveBusy(false);
    }
  };

  const handlePreview = async () => {
    if (!canUseDataAction) return;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const response = await fetch(withDbSettingQuery(`/api/visualization/map-mst/${form.mapId}/preview?limit=10`));
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
      const rows = payload.rows ?? [];
      setPreviewRows(rows);
      if (!rows.length) setPreviewError("미리보기 결과가 없습니다.");
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "미리보기에 실패했습니다.");
      setPreviewRows([]);
    } finally {
      setPreviewBusy(false);
    }
  };

  const runGenerate = async (mapId: number, mode: "generate" | "regenerate") => {
    const isIncrementalMode = mode === "generate";
    if (isIncrementalMode) {
      setGenerateNotice({
        open: true,
        type: "loading",
        title: "신규 데이터 반영",
        message: "처리중입니다. 잠시만 기다려주세요.",
      });
    }
    setGenerateBusy(true);
    setGenerateError("");
    setGenerateStatus("");
    const controller = new AbortController();
    generateAbortRef.current = controller;
    generatingMapIdRef.current = mapId;
    setGenerateCancelBusy(false);
    try {
      const response = await fetch(withDbSettingQuery(`/api/visualization/map-mst/${mapId}/generate`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
        signal: controller.signal,
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
      const successMessage =
        mode === "regenerate" ? "전체 데이터를 다시 만들었습니다." : "신규 데이터를 반영했습니다.";
      setGenerateStatus(successMessage);
      if (isIncrementalMode) {
        setGenerateNotice({
          open: true,
          type: "success",
          title: "신규 데이터 반영 완료",
          message: successMessage,
        });
      } else {
        openActionNotice("전체 데이터 생성", successMessage, "success");
      }
      setLastGenerateResult({
        mapId,
        affectedCount: Number(payload.affectedCount ?? 0),
        startDate: payload.startDate ?? null,
        endDate: payload.endDate ?? null,
        generatedAt,
      });
      await fetchMappings();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (isIncrementalMode) {
          setGenerateNotice({
            open: true,
            type: "cancelled",
            title: "신규 데이터 반영 중단",
            message: "중단했습니다.",
          });
        }
      } else {
        const message = error instanceof Error ? error.message : "데이터 생성에 실패했습니다.";
        setGenerateError(message);
        if (isIncrementalMode) {
          setGenerateNotice({
            open: true,
            type: "error",
            title: "신규 데이터 반영 실패",
            message,
          });
        } else {
          openActionNotice("전체 데이터 생성", message, "error");
        }
      }
    } finally {
      generateAbortRef.current = null;
      generatingMapIdRef.current = null;
      setGenerateCancelBusy(false);
      setGenerateBusy(false);
    }
  };

  const runBulkGenerate = async () => {
    if (generateBusy) return;

    const targetMappings =
      mappingsLoaded && mappings.length > 0 ? mappings : await fetchMappings();

    if (!targetMappings.length) {
      setGenerateNotice({
        open: true,
        type: "error",
        title: "전체 데이터 반영 실패",
        message: "반영할 매핑이 없습니다.",
      });
      return;
    }

    setGenerateBusy(true);
    setGenerateError("");
    setGenerateStatus("");
    bulkCancelRef.current = false;
    setGenerateCancelBusy(false);
    setGenerateNotice({
      open: true,
      type: "loading",
      title: "전체 데이터 반영",
      message: `전체 ${targetMappings.length}개 시리즈에 대해 신규 데이터를 반영 중입니다.`,
    });

    let successCount = 0;
    let failedCount = 0;
    let cancelled = false;
    for (let index = 0; index < targetMappings.length; index += 1) {
      if (bulkCancelRef.current) {
        cancelled = true;
        break;
      }
      const item = targetMappings[index];
      setGenerateNotice({
        open: true,
        type: "loading",
        title: "전체 데이터 반영",
        message: `[${index + 1}/${targetMappings.length}] ${item.seriesName} 처리 중...`,
      });
      const controller = new AbortController();
      generateAbortRef.current = controller;
      generatingMapIdRef.current = item.mapId;
      try {
        const response = await fetch(withDbSettingQuery(`/api/visualization/map-mst/${item.mapId}/generate`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "generate" }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "데이터 생성에 실패했습니다.");
        }
        successCount += 1;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          cancelled = true;
          break;
        }
        failedCount += 1;
      }
      setGenerateNotice({
        open: true,
        type: "loading",
        title: "전체 데이터 반영",
        message: `진행 ${index + 1}/${targetMappings.length} · 성공 ${successCount} · 실패 ${failedCount}`,
      });
    }

    generateAbortRef.current = null;
    generatingMapIdRef.current = null;
    setGenerateCancelBusy(false);
    await fetchMappings();
    setGenerateBusy(false);
    if (cancelled) {
      setGenerateNotice({
        open: true,
        type: "cancelled",
        title: "전체 데이터 반영 중단",
        message: `중단했습니다. (성공 ${successCount} · 실패 ${failedCount})`,
      });
      return;
    }
    if (failedCount === 0) {
      setGenerateNotice({
        open: true,
        type: "success",
        title: "전체 데이터 반영 완료",
        message: `${successCount}개 시리즈 신규 데이터 반영을 완료했습니다.`,
      });
      return;
    }
    setGenerateNotice({
      open: true,
      type: "error",
      title: "전체 데이터 반영 일부 실패",
      message: `성공 ${successCount}개, 실패 ${failedCount}개가 발생했습니다.`,
    });
  };

  const handleGenerate = async (mode: "generate" | "regenerate") => {
    if (!canUseDataAction || !form.mapId) return;
    await runGenerate(form.mapId, mode);
  };

  const handleGenerateFromList = async (mapId: number) => {
    if (!mapId || generateBusy) return;
    await runGenerate(mapId, "generate");
  };

  const openMapScheduleEdit = (item: MappingRow) => {
    setMapScheduleTarget({
      mapId: item.mapId,
      name: item.seriesName,
    });
    setMapScheduleForm({
      enabled: Boolean(item.scheduleEnabled),
      type: item.scheduleType === "cron" ? "cron" : "interval",
      intervalMinutes: Number.isFinite(item.scheduleIntervalMinutes)
        ? Number(item.scheduleIntervalMinutes)
        : 60,
      cronExpr: item.scheduleCronExpr ?? "",
    });
  };

  const handleSaveMapSchedule = async () => {
    if (!mapScheduleTarget) return;
    setScheduleBusy(true);
    try {
      const response = await fetch(
        withDbSettingQuery(`/api/visualization/map-mst/${mapScheduleTarget.mapId}/schedule`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: mapScheduleForm.enabled,
            type: mapScheduleForm.type,
            intervalMinutes:
              mapScheduleForm.type === "interval"
                ? Math.max(1, Number(mapScheduleForm.intervalMinutes) || 1)
                : null,
            cronExpr:
              mapScheduleForm.type === "cron"
                ? mapScheduleForm.cronExpr.trim()
                : null,
          }),
        },
      );
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "스케줄 저장에 실패했습니다.");
      }
      setMapScheduleTarget(null);
      await fetchMappings();
      openActionNotice("스케줄", "스케줄이 저장되었습니다.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "스케줄 저장에 실패했습니다.";
      openActionNotice("스케줄", message, "error");
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleDelete = async (mapId: number, seriesName?: string) => {
    if (!mapId) return;
    const ok = window.confirm(
      `${seriesName ? `[${seriesName}] ` : ""}이 매핑을 삭제할까요? 삭제 후 복구할 수 없습니다.`,
    );
    if (!ok) return;

    setDeleteBusy(true);
    try {
      const response = await fetch(withDbSettingQuery(`/api/visualization/map-mst/${mapId}`), {
        method: "DELETE",
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "매핑 삭제에 실패했습니다.");
      }
      openActionNotice("삭제", "매핑이 삭제되었습니다.", "success");
      await fetchMappings();
      setDetailOpen(false);
      resetForm();
    } catch (error) {
      const message = error instanceof Error ? error.message : "매핑 삭제에 실패했습니다.";
      openActionNotice("삭제", message, "error");
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!open && !inline) return null;
  const generateNoticeProgressMatch = /^\[(\d+\/\d+)\]\s*(.*)$/.exec(generateNotice.message);
  const generateNoticeMainMessage = generateNoticeProgressMatch?.[2] || generateNotice.message;
  const generateNoticeProgressText = generateNoticeProgressMatch?.[1] ?? "";

  return (
    <div
      className={
        inline
          ? "w-full"
          : "fixed inset-0 z-[75] flex items-center justify-center bg-slate-900/45 p-4"
      }
    >
      <div
        className={
          inline
            ? "flex max-h-[92vh] w-full flex-col overflow-hidden"
            : "flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
        }
      >
        {!inline ? (
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">데이터 매핑 관리</h3>
              <p className="mt-0.5 text-xs text-slate-500">매핑 리스트에서 상세보기를 눌러 수정하거나 신규 매핑을 등록합니다.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              닫기
            </button>
          </div>
        ) : null}

        <div className={`min-h-0 flex-1 overflow-y-auto ${inline ? "pt-4" : "px-4 py-4"}`}>
          <div className={inline ? "" : "rounded-3xl border border-slate-200 bg-white p-5"}>
            <div className={`mb-4 flex items-center justify-between gap-2 ${inline ? "" : "border-b border-slate-100 pb-3"}`}>
              <p className="text-base font-semibold leading-6 text-slate-900">데이터 매핑 목록</p>
              <button
                type="button"
                onClick={() => void fetchMappings()}
                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
              >
                새로고침
              </button>
            </div>

            <input
              value={mappingQuery}
              onChange={(event) => setMappingQuery(event.target.value)}
              placeholder="시리즈명 / 기관 / API / 테이블 검색"
              className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
            {mappingsError ? <p className="mb-2 text-xs text-rose-600">{mappingsError}</p> : null}
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="min-w-full text-center text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">시리즈명</th>
                    <th className="px-3 py-2">원본 테이블</th>
                    <th className="px-3 py-2">데이터 건수</th>
                    <th className="px-3 py-2">상태</th>
                    {!scopeKey ? <th className="px-3 py-2">스케줄</th> : null}
                    <th className="px-3 py-2 text-center">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingsLoading && filteredMappings.length === 0 ? (
                    <tr>
                      <td className="px-2 py-3 text-slate-500" colSpan={scopeKey ? 5 : 6}>불러오는 중...</td>
                    </tr>
                  ) : filteredMappings.length === 0 ? (
                    <tr>
                      <td className="px-2 py-3 text-slate-500" colSpan={scopeKey ? 5 : 6}>표시할 매핑이 없습니다.</td>
                    </tr>
                  ) : (
                    filteredMappings.map((item) => (
                      <tr key={item.mapId} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium text-slate-800">{item.seriesName}</td>
                        <td className="px-3 py-2">{item.sourceTable}</td>
                        <td className="px-3 py-2">{item.dataCount.toLocaleString()}건</td>
                        <td className="px-3 py-2 text-slate-500">{item.isActive ? "활성" : "비활성"}</td>
                        {!scopeKey ? (
                          <td className="px-3 py-2 text-slate-500">
                            {item.scheduleEnabled
                              ? item.scheduleType === "cron"
                                ? `CRON: ${item.scheduleCronExpr ?? ""}`
                                : `${item.scheduleIntervalMinutes ?? 0}분 간격`
                              : "미사용"}
                          </td>
                        ) : null}
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditDetail(item)}
                              className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              상세보기
                            </button>
                            {!scopeKey ? (
                              <button
                                type="button"
                                onClick={() => openMapScheduleEdit(item)}
                                className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100"
                              >
                                스케줄
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void handleGenerateFromList(item.mapId)}
                              disabled={generateBusy}
                              className="rounded-full border border-emerald-300 px-3 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              신규 데이터 반영
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDelete(item.mapId, item.seriesName)}
                              disabled={deleteBusy}
                              className="rounded-full border border-rose-300 px-3 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {deleteBusy ? "삭제 중..." : "삭제"}
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
        </div>
      </div>

      {detailOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-900/45 p-4">
          <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4">
              <div>
                <h4 className="text-sm font-semibold text-slate-900">
                  {detailMode === "create" ? "신규 매핑 등록" : "매핑 상세"}
                </h4>
                <p className="mt-0.5 text-xs text-slate-500">
                  {detailMode === "create"
                    ? "매핑 대상을 먼저 선택한 뒤 매핑 정보를 저장하세요."
                    : "시리즈 상세정보를 확인하고 수정할 수 있습니다."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailOpen(false)}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              {detailMode === "create" && !scopeKey ? (
                <div className="mb-4 rounded-xl border border-slate-200 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-900">1) 매핑 대상 선택</p>
                    <button
                      type="button"
                      onClick={() => void fetchTargets()}
                      className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      새로고침
                    </button>
                  </div>
                  <input
                    value={targetQuery}
                    onChange={(event) => setTargetQuery(event.target.value)}
                    placeholder="기관 / API명 / 테이블 검색"
                    className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs"
                  />
                  {targetsError ? <p className="mb-2 text-xs text-rose-600">{targetsError}</p> : null}
                  <div className="max-h-[22vh] overflow-auto rounded-xl border border-slate-200">
                    <table className="min-w-full text-center text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-2 py-1.5">기관</th>
                          <th className="px-2 py-1.5">API명</th>
                          <th className="px-3 py-2">원본 테이블</th>
                        </tr>
                      </thead>
                      <tbody>
                        {targetsLoading ? (
                          <tr>
                            <td className="px-2 py-3 text-slate-500" colSpan={3}>불러오는 중...</td>
                          </tr>
                        ) : filteredTargets.length === 0 ? (
                          <tr>
                            <td className="px-2 py-3 text-slate-500" colSpan={3}>대상이 없습니다.</td>
                          </tr>
                        ) : (
                          filteredTargets.map((item, idx) => (
                            <tr
                              key={`${item.sourceOrg}:${item.apiName}:${item.sourceTable}:${idx}`}
                              className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                                selectedTargetKey === getTargetRowKey(item) ? "bg-slate-100" : ""
                              }`}
                              onClick={() => selectTarget(item)}
                            >
                              <td className="px-2 py-1.5">{item.sourceOrg}</td>
                              <td className="px-2 py-1.5">{item.apiName}</td>
                              <td className="px-3 py-2">{item.sourceTable}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {detailMode === "create" && !selectedTargetKey ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                  매핑 대상을 먼저 선택해 주세요.
                </div>
              ) : (
                <>
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
                      <span className="text-slate-600">
                        원본 테이블 *{scopeKey ? " (고정)" : ""}
                      </span>
                      <input
                        value={form.sourceTable}
                        onChange={(e) =>
                          !scopeKey && setForm((prev) => ({ ...prev, sourceTable: e.target.value }))
                        }
                        disabled={!!scopeKey}
                        className="w-full rounded-lg border border-slate-200 px-2 py-2 disabled:bg-slate-100 disabled:text-slate-500"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="text-slate-600">시리즈명 *</span>
                      <input
                        value={form.seriesName}
                        onChange={(e) => setForm((prev) => ({ ...prev, seriesName: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 px-2 py-2"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-slate-600">날짜 컬럼 *</span>
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
                        <span className="text-slate-600">값 컬럼 *</span>
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
                        <span className="text-slate-600">날짜 포맷</span>
                        <input
                          value={form.dateFormat}
                          onChange={(e) => setForm((prev) => ({ ...prev, dateFormat: e.target.value }))}
                          placeholder="예: YYYYMM / YYYY-MM-DD"
                          className="w-full rounded-lg border border-slate-200 px-2 py-2"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-slate-600">시리즈 키</span>
                        <input
                          value={form.seriesKey}
                          onChange={(e) => setForm((prev) => ({ ...prev, seriesKey: e.target.value }))}
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
                      <span className="text-slate-600">조건 처리 방식</span>
                      <select
                        value={form.duplicateDatePolicy}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            duplicateDatePolicy: e.target.value === "sum" ? "sum" : "none",
                          }))
                        }
                        className="w-full rounded-lg border border-slate-200 px-2 py-2"
                      >
                        <option value="none">단순 조건 (1개)</option>
                        <option value="sum">복합 조건 집계 (여러 건 합산)</option>
                      </select>
                    </label>

                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={form.fillForward}
                        onChange={(e) => setForm((prev) => ({ ...prev, fillForward: e.target.checked }))}
                        className="mt-0.5"
                      />
                      <span className="text-slate-600">
                        빈 날짜 채우기 (직전 값)
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          일별(주기 D) 데이터에서 주말·공휴일 등 빠진 날짜를 직전 영업일 값으로 채웁니다.
                        </span>
                      </span>
                    </label>

                    <label className="space-y-1">
                      <span className="text-slate-600">
                        필터 조건 (SQL WHERE)
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          <code className="rounded bg-slate-100 px-1">--</code> 로 시작하면 그 줄은 주석(초록색)으로 처리됩니다.
                        </span>
                      </span>
                      <SqlEditor
                        value={form.whereClause}
                        onChange={(next) => setForm((prev) => ({ ...prev, whereClause: next }))}
                        rows={6}
                        placeholder="예: series_key = '802Y001'"
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

                  {!canUseDataAction ? (
                    <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      저장 후 미리보기/데이터 생성을 실행할 수 있습니다.
                    </p>
                  ) : null}

                  <div className="mt-4 flex flex-wrap gap-2">
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
                      {previewBusy ? "조회 중..." : "미리보기"}
                    </button>
                    {detailMode !== "create" ? (
                      <button
                        type="button"
                        onClick={() => void handleGenerate("generate")}
                        disabled={!canUseDataAction || generateBusy}
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        신규 데이터 반영
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleGenerate("regenerate")}
                      disabled={!canUseDataAction || generateBusy}
                      className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {generateBusy ? "처리 중..." : "전체 데이터 생성"}
                    </button>
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-200 p-4">
                    <p className="mb-2 text-sm font-semibold text-slate-900">변환 미리보기 (최대 10건)</p>
                    {previewError ? <p className="mb-2 text-xs text-rose-600">{previewError}</p> : null}
                    <div className="max-h-[220px] overflow-auto rounded-xl border border-slate-200">
                      <table className="min-w-full text-center text-xs">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            <th className="px-2 py-1.5">원본 날짜</th>
                            <th className="px-2 py-1.5">원본 값</th>
                            <th className="px-2 py-1.5">변환 날짜</th>
                            <th className="px-2 py-1.5">변환 값</th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.length === 0 ? (
                            <tr>
                              <td className="px-2 py-2 text-slate-500" colSpan={4}>미리보기 데이터가 없습니다.</td>
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

                    {lastGenerateResult ? (
                      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                        <p className="font-semibold text-slate-900">최근 생성 결과</p>
                        <p className="mt-1">map_id: {lastGenerateResult.mapId}</p>
                        <p className="mt-1">생성 건수: {lastGenerateResult.affectedCount.toLocaleString()}건</p>
                        <p>
                          생성 구간: {lastGenerateResult.startDate ?? "-"} ~ {lastGenerateResult.endDate ?? "-"}
                        </p>
                        <p>최근 생성 시각: {new Date(lastGenerateResult.generatedAt).toLocaleString()}</p>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {actionNotice.open ? (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/45 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <p
              className={`text-sm font-semibold ${
                actionNotice.tone === "error" ? "text-rose-700" : "text-emerald-700"
              }`}
            >
              {actionNotice.title}
            </p>
            <p className="mt-2 text-sm text-slate-700">{actionNotice.message}</p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() =>
                  setActionNotice((prev) => ({
                    ...prev,
                    open: false,
                  }))
                }
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <RunStatusModal
        open={generateNotice.open}
        state={generateNotice.type}
        title={generateNotice.title}
        message={generateNoticeMainMessage}
        subMessage={generateNoticeProgressText || undefined}
        onConfirm={() => setGenerateNotice((prev) => ({ ...prev, open: false }))}
        loadingAction={{
          label: generateCancelBusy ? "중단 중…" : "닫기(중단)",
          onClick: cancelGenerate,
          disabled: generateCancelBusy,
        }}
      />
      {mapScheduleTarget ? (
        <div className="fixed inset-0 z-[97] flex items-center justify-center bg-slate-900/45 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">시리즈 스케줄 설정</p>
                <p className="mt-1 text-xs text-slate-500">{mapScheduleTarget.name}</p>
              </div>
              <button
                type="button"
                onClick={() => setMapScheduleTarget(null)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={mapScheduleForm.enabled}
                  onChange={(event) =>
                    setMapScheduleForm((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                />
                스케줄 활성화
              </label>
              <label className="space-y-1 text-xs text-slate-600">
                실행 방식
                <select
                  value={mapScheduleForm.type}
                  onChange={(event) =>
                    setMapScheduleForm((prev) => ({
                      ...prev,
                      type: event.target.value as "interval" | "cron",
                    }))
                  }
                  className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                >
                  <option value="interval">간격(분)</option>
                  <option value="cron">CRON</option>
                </select>
              </label>
              {mapScheduleForm.type === "interval" ? (
                <label className="space-y-1 text-xs text-slate-600">
                  실행 주기(분)
                  <input
                    type="number"
                    min={1}
                    value={mapScheduleForm.intervalMinutes}
                    onChange={(event) =>
                      setMapScheduleForm((prev) => ({
                        ...prev,
                        intervalMinutes: Math.max(1, Number(event.target.value) || 1),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
              ) : (
                <label className="space-y-1 text-xs text-slate-600">
                  CRON 표현식
                  <input
                    value={mapScheduleForm.cronExpr}
                    onChange={(event) =>
                      setMapScheduleForm((prev) => ({
                        ...prev,
                        cronExpr: event.target.value,
                      }))
                    }
                    placeholder="예: 0 8 * * *"
                    className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                  />
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMapScheduleTarget(null)}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleSaveMapSchedule()}
                disabled={scheduleBusy}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {scheduleBusy ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


