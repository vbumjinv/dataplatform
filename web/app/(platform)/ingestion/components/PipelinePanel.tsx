"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RunStatusModal, { type RunState } from "./RunStatusModal";

type PipelineListItem = {
  pipeline_id: number;
  name: string;
  schedule_enabled: boolean;
  schedule_type: "interval" | "cron";
  schedule_interval_minutes: number | null;
  schedule_cron_expr: string | null;
  collection_label: string | null;
  map_count: number;
  mappings: string[];
  transform_count: number;
  transforms: string[];
  last_status: string | null;
};

type Draft = {
  pipelineId: number | null;
  name: string;
  description: string;
  groupId: number | null;
  mapIds: number[];
  transformIds: number[];
  scheduleEnabled: boolean;
  scheduleType: "interval" | "cron";
  scheduleIntervalMinutes: number;
  scheduleCronExpr: string;
};

type RunLog = {
  run_log_id: number;
  trigger_type: string;
  status: string;
  started_at: string;
  step_results: Array<{ type: string; status: string; affectedCount?: number; message?: string }> | null;
  error_message: string | null;
};

type CollectOption = {
  groupId: number;
  label: string;
  provider: string;
  targetTable: string;
  sourceTable: string;
};
type MapOption = { mapId: number; label: string; sourceTable: string };
type TransformOption = {
  transformId: number;
  label: string;
  sourceMapId: number;
  outputMapId: number | null;
  outputName: string;
};

const emptyDraft = (): Draft => ({
  pipelineId: null,
  name: "",
  description: "",
  groupId: null,
  mapIds: [],
  transformIds: [],
  scheduleEnabled: false,
  scheduleType: "interval",
  scheduleIntervalMinutes: 60,
  scheduleCronExpr: "0 9 * * *",
});

const scheduleLabel = (p: PipelineListItem) => {
  if (!p.schedule_enabled) return "미사용";
  if (p.schedule_type === "cron") return `CRON ${p.schedule_cron_expr ?? ""}`;
  return `${p.schedule_interval_minutes ?? 0}분 간격`;
};

export default function PipelinePanel({ dbSettingId }: { dbSettingId: string }) {
  const [pipelines, setPipelines] = useState<PipelineListItem[]>([]);
  const [listError, setListError] = useState("");
  const [listMsg, setListMsg] = useState("");
  const [runningId, setRunningId] = useState<number | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [runProgressText, setRunProgressText] = useState("");
  const runAbortRef = useRef<AbortController | null>(null);
  const runPipelineIdRef = useRef<number | null>(null);
  const [collectOptions, setCollectOptions] = useState<CollectOption[]>([]);
  const [mapOptions, setMapOptions] = useState<MapOption[]>([]);
  const [transformOptions, setTransformOptions] = useState<TransformOption[]>([]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [collectProvider, setCollectProvider] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveError, setSaveError] = useState("");
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState("");
  const [runNotice, setRunNotice] = useState<{
    open: boolean;
    state: RunState;
    title: string;
    message: string;
  }>({
    open: false,
    state: "loading",
    title: "",
    message: "",
  });

  const withDb = useCallback(
    (path: string) => {
      if (!dbSettingId) return path;
      const sep = path.includes("?") ? "&" : "?";
      return `${path}${sep}dbSettingId=${encodeURIComponent(dbSettingId)}`;
    },
    [dbSettingId],
  );

  const fetchPipelines = useCallback(async () => {
    try {
      const res = await fetch(withDb("/api/pipeline"));
      const payload = (await res.json()) as { ok?: boolean; items?: PipelineListItem[]; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "파이프라인 목록을 불러오지 못했습니다.");
      setPipelines(payload.items ?? []);
      setListError("");
    } catch (error) {
      setListError(error instanceof Error ? error.message : "목록 오류");
    }
  }, [withDb]);

  const fetchOptions = useCallback(async () => {
    try {
      const [cfgRes, mapRes, txRes] = await Promise.all([
        fetch(withDb("/api/ingestion/api-config")),
        fetch(withDb("/api/visualization/map-mst")),
        fetch(withDb("/api/data-transform")),
      ]);
      const cfg = (await cfgRes.json()) as {
        ok?: boolean;
        sources?: Array<{ name: string; provider?: string; is_template?: boolean; groups?: Array<{ id: number | string; name: string | null; is_template?: boolean; target_table?: string | null }> }>;
      };
      const collect: CollectOption[] = [];
      if (cfg.ok) {
        for (const s of cfg.sources ?? []) {
          if (s.is_template) continue;
          for (const g of s.groups ?? []) {
            if (g.is_template || !g.target_table) continue;
            collect.push({
              groupId: Number(g.id),
              label: `${s.name} · ${g.name || "기본"}`,
              provider: s.provider ?? "",
              targetTable: g.target_table,
              sourceTable: g.target_table.replace(/_lrd$/i, ""),
            });
          }
        }
      }
      setCollectOptions(collect.filter((c) => Number.isFinite(c.groupId)));

      const map = (await mapRes.json()) as {
        ok?: boolean;
        items?: Array<{ mapId: number | string; seriesName: string; sourceTable: string }>;
      };
      setMapOptions(
        map.ok
          ? (map.items ?? []).map((m) => ({
              mapId: Number(m.mapId),
              label: m.seriesName,
              sourceTable: m.sourceTable ?? "",
            }))
          : [],
      );

      const tx = (await txRes.json()) as {
        ok?: boolean;
        items?: Array<{
          transform_id: number | string;
          name: string;
          source_map_id: number | string | null;
          output_map_id: number | string | null;
          output_name: string | null;
        }>;
      };
      setTransformOptions(
        tx.ok
          ? (tx.items ?? [])
              .filter((t) => t.source_map_id != null)
              .map((t) => ({
                transformId: Number(t.transform_id),
                label: t.name,
                sourceMapId: Number(t.source_map_id),
                outputMapId: t.output_map_id == null ? null : Number(t.output_map_id),
                outputName: t.output_name ?? t.name,
              }))
          : [],
      );
    } catch {
      // ignore
    }
  }, [withDb]);

  useEffect(() => {
    void fetchPipelines();
    void fetchOptions();
  }, [fetchPipelines, fetchOptions]);

  // 실행 중 현재 단계(수집/매핑·시리즈) 폴링
  useEffect(() => {
    if (!runNotice.open || runNotice.state !== "loading") return;
    const id = runPipelineIdRef.current;
    if (id == null) return;
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(withDb(`/api/pipeline/${id}/progress`));
        const payload = (await res.json()) as {
          ok?: boolean;
          progress?: {
            phase: "collect" | "map" | "transform";
            label: string;
            index?: number;
            total?: number;
          } | null;
        };
        if (!active || !payload?.ok || !payload.progress) return;
        const p = payload.progress;
        setRunProgressText(
          p.phase === "collect"
            ? "① 수집(적재) 진행 중…"
            : p.phase === "map"
              ? `② 매핑 생성 중 · ${p.label}${p.total ? ` (${p.index}/${p.total})` : ""}`
              : `③ 데이터 가공 중 · ${p.label}${p.total ? ` (${p.index}/${p.total})` : ""}`,
        );
      } catch {
        // ignore
      }
    };
    void poll();
    const timer = setInterval(poll, 800);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [runNotice.open, runNotice.state, withDb]);

  const fetchRuns = useCallback(async (pipelineId: number) => {
    try {
      const res = await fetch(withDb(`/api/pipeline/${pipelineId}/runs`));
      const payload = (await res.json()) as { ok?: boolean; runs?: RunLog[] };
      if (res.ok && payload.ok) setRuns(payload.runs ?? []);
    } catch {
      // ignore
    }
  }, [withDb]);

  const loadDraft = useCallback(
    async (pipelineId: number) => {
      setSaveMsg("");
      setSaveError("");
      setRunMsg("");
      setRuns([]);
      try {
        const res = await fetch(withDb(`/api/pipeline/${pipelineId}`));
        const payload = (await res.json()) as {
          ok?: boolean;
          pipeline?: {
            pipeline_id: number;
            name: string;
            description: string | null;
            group_id: number | null;
            schedule_enabled: boolean;
            schedule_type: "interval" | "cron";
            schedule_interval_minutes: number | null;
            schedule_cron_expr: string | null;
          };
          mapIds?: number[];
          transformIds?: number[];
          error?: string;
        };
        if (!res.ok || !payload.ok || !payload.pipeline) {
          throw new Error(payload.error || "파이프라인을 불러오지 못했습니다.");
        }
        const p = payload.pipeline;
        setDraft({
          pipelineId: p.pipeline_id,
          name: p.name,
          description: p.description ?? "",
          groupId: p.group_id == null ? null : Number(p.group_id),
          mapIds: (payload.mapIds ?? []).map((id) => Number(id)),
          transformIds: (payload.transformIds ?? []).map((id) => Number(id)),
          scheduleEnabled: p.schedule_enabled,
          scheduleType: p.schedule_type,
          scheduleIntervalMinutes: p.schedule_interval_minutes ?? 60,
          scheduleCronExpr: p.schedule_cron_expr ?? "0 9 * * *",
        });
        void fetchRuns(p.pipeline_id);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "불러오기 오류");
      }
    },
    [fetchRuns, withDb],
  );

  const startCreate = () => {
    setSaveMsg("");
    setSaveError("");
    setRunMsg("");
    setRuns([]);
    setCollectProvider("all");
    setDraft(emptyDraft());
  };

  const startEdit = async (pipelineId: number) => {
    setCollectProvider("all");
    await loadDraft(pipelineId);
  };

  const closeModal = () => {
    setDraft(null);
    void fetchPipelines();
  };

  const runPipelineRequest = async (pipelineId: number, name: string) => {
    const controller = new AbortController();
    runAbortRef.current = controller;
    runPipelineIdRef.current = pipelineId;
    setCancelBusy(false);
    setRunProgressText("준비 중…");
    setRunNotice({ open: true, state: "loading", title: "실행 중", message: name });
    try {
      const res = await fetch(withDb(`/api/pipeline/${pipelineId}/run`), {
        method: "POST",
        signal: controller.signal,
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(payload.error || "실행에 실패했습니다.");
      setRunNotice({
        open: true,
        state: payload.ok ? "success" : "error",
        title: payload.ok ? "실행 완료" : "일부 실패",
        message: payload.ok
          ? "파이프라인 실행이 완료되었습니다."
          : "일부 단계가 실패했습니다. 실행 이력에서 확인하세요.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setRunNotice({ open: true, state: "cancelled", title: "실행 중단", message: "실행을 중단했습니다." });
      } else {
        setRunNotice({
          open: true,
          state: "error",
          title: "실행 실패",
          message: error instanceof Error ? error.message : "실행 오류",
        });
      }
    } finally {
      runAbortRef.current = null;
      runPipelineIdRef.current = null;
      setCancelBusy(false);
    }
  };

  const cancelRun = async () => {
    if (cancelBusy) return;
    setCancelBusy(true);
    const id = runPipelineIdRef.current;
    try {
      runAbortRef.current?.abort();
    } catch {
      // ignore
    }
    if (id != null) {
      try {
        await fetch(withDb(`/api/pipeline/${id}/cancel`), { method: "POST" });
      } catch {
        // ignore
      }
    }
  };

  const handleRunById = async (pipelineId: number, name: string) => {
    setRunningId(pipelineId);
    setListMsg("");
    await runPipelineRequest(pipelineId, name);
    await fetchPipelines();
    setRunningId(null);
  };


  const handleDeleteById = async (pipelineId: number, name: string) => {
    if (!window.confirm(`'${name}' 파이프라인을 삭제할까요?`)) return;
    try {
      const res = await fetch(withDb(`/api/pipeline/${pipelineId}`), { method: "DELETE" });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "삭제에 실패했습니다.");
      setListMsg("삭제되었습니다.");
      await fetchPipelines();
    } catch (error) {
      setListMsg(error instanceof Error ? error.message : "삭제 오류");
    }
  };

  // ===== 편집 모드 구성 로직 =====
  const selectedCollection = useMemo(
    () => (draft?.groupId ? collectOptions.find((o) => o.groupId === draft.groupId) ?? null : null),
    [draft?.groupId, collectOptions],
  );

  const providerTabs = useMemo(() => {
    const set = new Set<string>();
    for (const o of collectOptions) if (o.provider) set.add(o.provider);
    return ["all", ...Array.from(set).sort()];
  }, [collectOptions]);

  const filteredCollects = useMemo(
    () =>
      collectProvider === "all"
        ? collectOptions
        : collectOptions.filter((o) => o.provider === collectProvider),
    [collectProvider, collectOptions],
  );

  const availableMaps = useMemo(() => {
    if (!selectedCollection) return [];
    const key = selectedCollection.sourceTable.trim().toLowerCase();
    return mapOptions.filter((m) => (m.sourceTable ?? "").trim().toLowerCase() === key);
  }, [selectedCollection, mapOptions]);

  // 의존성이 충족되는 가공만 "위상 정렬(상위 가공 먼저)" 순서로 정리.
  // 가공의 입력(sourceMapId)은 선택한 매핑이거나, 이미 선택된 다른 가공의 출력이어야 한다.
  const resolveValidTransforms = useCallback(
    (mapIds: number[], transformIds: number[]): number[] => {
      const produced = new Set<number>(mapIds);
      const wanted = new Set(transformIds);
      const ordered: number[] = [];
      const done = new Set<number>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of transformOptions) {
          if (wanted.has(t.transformId) && !done.has(t.transformId) && produced.has(t.sourceMapId)) {
            done.add(t.transformId);
            ordered.push(t.transformId);
            if (t.outputMapId != null) produced.add(t.outputMapId);
            changed = true;
          }
        }
      }
      return ordered;
    },
    [transformOptions],
  );

  // 후보 노출: 선택한 매핑에서 (모든 가공의 출력을 따라) "도달 가능한" 가공을 전부 보여준다.
  // 부모(상위) 가공이 아직 선택되지 않은 하위 가공은 비활성(enabled=false)으로 표시하고,
  // 부모 → 자식 순서로 들여쓰기(depth) 한 트리 순서로 정렬한다.
  // enabled 기준: 입력(sourceMapId)이 (선택한 매핑) 또는 (이미 선택된 가공의 출력) 인 경우만 선택 가능.
  const availableTransforms = useMemo(() => {
    const mapSet = new Set<number>(draft?.mapIds ?? []);
    const wanted = new Set(draft?.transformIds ?? []);

    // (1) 후보 universe: 매핑에서 모든 가공의 출력을 따라 도달 가능한 가공 전부
    const reachable = new Set<number>(mapSet);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of transformOptions) {
        if (t.outputMapId != null && reachable.has(t.sourceMapId) && !reachable.has(t.outputMapId)) {
          reachable.add(t.outputMapId);
          changed = true;
        }
      }
    }

    // (2) 활성화(produced): 매핑 + "이미 선택된" 가공의 출력만 따라 확장
    const produced = new Set<number>(mapSet);
    changed = true;
    while (changed) {
      changed = false;
      for (const t of transformOptions) {
        if (
          wanted.has(t.transformId) &&
          t.outputMapId != null &&
          produced.has(t.sourceMapId) &&
          !produced.has(t.outputMapId)
        ) {
          produced.add(t.outputMapId);
          changed = true;
        }
      }
    }

    // (3) 트리 순서로 펼치기: 입력(sourceMapId) 별로 자식을 묶어 부모 바로 아래에 배치
    const candidates = transformOptions.filter((t) => reachable.has(t.sourceMapId));
    const childrenBySource = new Map<number, TransformOption[]>();
    for (const c of candidates) {
      const arr = childrenBySource.get(c.sourceMapId) ?? [];
      arr.push(c);
      childrenBySource.set(c.sourceMapId, arr);
    }
    const result: Array<{ t: TransformOption; depth: number; enabled: boolean }> = [];
    const visited = new Set<number>();
    const walk = (sourceMapId: number, depth: number) => {
      const kids = (childrenBySource.get(sourceMapId) ?? [])
        .slice()
        .sort((a, b) => a.transformId - b.transformId);
      for (const k of kids) {
        if (visited.has(k.transformId)) continue;
        visited.add(k.transformId);
        result.push({ t: k, depth, enabled: produced.has(k.sourceMapId) });
        if (k.outputMapId != null) walk(k.outputMapId, depth + 1);
      }
    };
    for (const mid of [...mapSet].sort((a, b) => a - b)) walk(mid, 0);
    return result;
  }, [transformOptions, draft?.mapIds, draft?.transformIds]);

  const changeCollection = (groupId: number | null) => {
    setDraft((d) => {
      if (!d) return d;
      const coll = groupId ? collectOptions.find((o) => o.groupId === groupId) : null;
      const key = coll?.sourceTable.trim().toLowerCase() ?? "";
      const allowed = new Set(
        mapOptions.filter((m) => (m.sourceTable ?? "").trim().toLowerCase() === key).map((m) => m.mapId),
      );
      const mapIds = d.mapIds.filter((id) => allowed.has(id));
      return { ...d, groupId, mapIds, transformIds: resolveValidTransforms(mapIds, d.transformIds) };
    });
  };

  const toggleMap = (mapId: number) =>
    setDraft((d) => {
      if (!d) return d;
      const nextMapIds = d.mapIds.includes(mapId)
        ? d.mapIds.filter((x) => x !== mapId)
        : [...d.mapIds, mapId];
      // 매핑 해제 시 그 매핑(및 그에 의존하는 가공 체인)도 함께 정리
      return { ...d, mapIds: nextMapIds, transformIds: resolveValidTransforms(nextMapIds, d.transformIds) };
    });

  const toggleTransform = (transformId: number) =>
    setDraft((d) => {
      if (!d) return d;
      const next = d.transformIds.includes(transformId)
        ? d.transformIds.filter((x) => x !== transformId)
        : [...d.transformIds, transformId];
      // 해제 시 그 출력을 입력으로 쓰던 하위 가공도 함께 정리하고, 위상 정렬 순서로 저장
      return { ...d, transformIds: resolveValidTransforms(d.mapIds, next) };
    });

  const allMapsSelected =
    !!selectedCollection &&
    availableMaps.length > 0 &&
    availableMaps.every((m) => draft?.mapIds.includes(m.mapId));

  const toggleAllMaps = () =>
    setDraft((d) => {
      if (!d) return d;
      const ids = availableMaps.map((m) => m.mapId);
      const all = ids.length > 0 && ids.every((id) => d.mapIds.includes(id));
      return all
        ? { ...d, mapIds: d.mapIds.filter((id) => !ids.includes(id)) }
        : { ...d, mapIds: Array.from(new Set([...d.mapIds, ...ids])) };
    });

  const buildBody = (d: Draft) => ({
    name: d.name,
    description: d.description,
    groupId: d.groupId,
    mapIds: d.mapIds,
    transformIds: d.transformIds,
    schedule: {
      enabled: d.scheduleEnabled,
      type: d.scheduleType,
      intervalMinutes: d.scheduleIntervalMinutes,
      cronExpr: d.scheduleCronExpr,
    },
  });

  const handleSave = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setSaveError("파이프라인 이름을 입력하세요.");
    if (!draft.groupId) return setSaveError("수집을 선택하세요.");
    setSaving(true);
    setSaveError("");
    setSaveMsg("");
    try {
      const isNew = draft.pipelineId == null;
      const res = await fetch(
        withDb(isNew ? "/api/pipeline" : `/api/pipeline/${draft.pipelineId}`),
        {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(draft)),
        },
      );
      const payload = (await res.json()) as { ok?: boolean; pipelineId?: number; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "저장에 실패했습니다.");
      setSaveMsg("저장되었습니다.");
      const id = payload.pipelineId ?? draft.pipelineId;
      if (id) await loadDraft(id);
      void fetchPipelines();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "저장 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (!draft?.pipelineId) return setRunMsg("먼저 저장한 뒤 실행하세요.");
    setRunning(true);
    setRunMsg("");
    await runPipelineRequest(draft.pipelineId, draft.name);
    await fetchRuns(draft.pipelineId);
    setRunning(false);
  };

  return (
    <>
      {/* 목록: 수집/매핑 설정과 동일한 카드+테이블 */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h4 className="text-base font-semibold leading-6 text-slate-900">파이프라인 관리</h4>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex h-8 items-center rounded-full bg-slate-900 px-3 text-xs font-semibold text-white transition hover:bg-slate-800"
            >
              파이프라인 생성
            </button>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold leading-6 text-slate-900">파이프라인 목록</h3>
          <span className="inline-flex h-7 items-center rounded-full border border-slate-200 px-3 text-xs font-semibold text-slate-500">
            {pipelines.length}건
          </span>
        </div>
        {listError ? <p className="mt-2 text-xs text-rose-600">{listError}</p> : null}
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full table-fixed text-center text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="w-[13%] px-3 py-2 text-left">이름</th>
                <th className="w-[18%] px-3 py-2">수집</th>
                <th className="w-[20%] px-3 py-2">매핑</th>
                <th className="w-[15%] px-3 py-2">가공</th>
                <th className="w-[11%] px-3 py-2">스케줄</th>
                <th className="w-[23%] px-3 py-2">작업</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.length === 0 ? (
                <tr>
                  <td className="px-2 py-4 text-slate-500" colSpan={6}>
                    등록된 파이프라인이 없습니다. &ldquo;파이프라인 생성&rdquo;으로 만드세요.
                  </td>
                </tr>
              ) : (
                pipelines.map((p) => (
                  <tr key={p.pipeline_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-left font-medium text-slate-800">{p.name}</td>
                    <td className="px-3 py-2 text-slate-600">{p.collection_label ?? "미지정"}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {p.mappings.length === 0 ? (
                        <span className="text-slate-400">없음</span>
                      ) : (
                        <span className="inline-flex w-full flex-wrap items-center justify-center gap-1">
                          {p.mappings.map((m, i) => (
                            <span key={i} className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">{m}</span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {!p.transforms || p.transforms.length === 0 ? (
                        <span className="text-slate-400">없음</span>
                      ) : (
                        <span className="inline-flex w-full flex-wrap items-center justify-center gap-1">
                          {p.transforms.map((t, i) => (
                            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">
                              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-violet-500 text-[10px] font-bold text-white">
                                {i + 1}
                              </span>
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{scheduleLabel(p)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-nowrap items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleRunById(p.pipeline_id, p.name)}
                          disabled={runningId === p.pipeline_id}
                          className="shrink-0 whitespace-nowrap rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {runningId === p.pipeline_id ? "실행 중…" : "즉시 실행"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void startEdit(p.pipeline_id)}
                          className="shrink-0 whitespace-nowrap rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteById(p.pipeline_id, p.name)}
                          className="shrink-0 whitespace-nowrap rounded-full border border-rose-200 px-3 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50"
                        >
                          삭제
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

      {/* 생성/수정 모달 */}
      {draft ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 p-4 sm:items-center sm:p-6">
          <div className="flex w-full max-w-4xl flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:max-h-[90vh]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                {draft.pipelineId == null ? "파이프라인 생성" : "파이프라인 수정"}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={running || draft.pipelineId == null}
                  className="inline-flex h-8 items-center rounded-full border border-slate-300 px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {running ? "실행 중…" : "지금 실행"}
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex h-8 items-center rounded-full bg-emerald-600 px-3 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "저장 중…" : "저장"}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="inline-flex h-8 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                >
                  닫기
                </button>
              </div>
            </div>

            <div className="mt-3 space-y-4 overflow-auto">
              {/* 이름/설명 */}
              <div>
                <label className="block text-xs font-semibold text-slate-700">파이프라인 이름</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="예) 한국 주식시장 일일"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
                <input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="설명 (선택)"
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-slate-400 focus:outline-none"
                />
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  {saveError ? <span className="text-rose-600">{saveError}</span> : null}
                  {saveMsg ? <span className="text-emerald-700">{saveMsg}</span> : null}
                  {runMsg ? <span className="text-slate-600">{runMsg}</span> : null}
                </div>
              </div>

      {/* 구성: 수집(좌) → 매핑(우) */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h4 className="text-sm font-semibold text-slate-900">구성</h4>
          <p className="text-xs text-slate-500">수집을 고르면 오른쪽에서 매핑을 선택해 묶습니다.</p>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 좌: 수집 */}
          <div className="rounded-2xl border border-slate-100 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">수집</span>
              {selectedCollection ? (
                <span className="max-w-[60%] truncate text-[11px] text-amber-600">{selectedCollection.label}</span>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {providerTabs.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setCollectProvider(p)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    collectProvider === p ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {p === "all" ? "전체" : p.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="mt-2 max-h-72 space-y-1.5 overflow-auto pr-1">
              {filteredCollects.map((o) => {
                const selected = draft.groupId === o.groupId;
                return (
                  <button
                    type="button"
                    key={o.groupId}
                    onClick={() => changeCollection(o.groupId)}
                    className={`flex w-full flex-col rounded-xl border px-3 py-2 text-left transition ${
                      selected
                        ? "border-amber-300 bg-amber-50 ring-1 ring-amber-300"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {o.provider ? (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                          {o.provider}
                        </span>
                      ) : null}
                      <span className="text-sm font-medium text-slate-900">{o.label}</span>
                    </span>
                    <span className="mt-0.5 font-mono text-[11px] text-slate-400">{o.targetTable}</span>
                  </button>
                );
              })}
              {filteredCollects.length === 0 ? (
                <p className="px-1 py-2 text-xs text-slate-400">수집이 없습니다.</p>
              ) : null}
            </div>
          </div>

          {/* 우: 매핑 */}
          <div className="rounded-2xl border border-slate-100 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                매핑
                {selectedCollection && availableMaps.length > 0
                  ? ` (${availableMaps.filter((m) => draft.mapIds.includes(m.mapId)).length}/${availableMaps.length})`
                  : ""}
              </span>
              {selectedCollection && availableMaps.length > 0 ? (
                <button
                  type="button"
                  onClick={toggleAllMaps}
                  className="text-[11px] font-semibold text-sky-600 hover:underline"
                >
                  {allMapsSelected ? "전체 해제" : "전체 선택"}
                </button>
              ) : null}
            </div>
            <div className="mt-2 max-h-72 space-y-1.5 overflow-auto pr-1">
              {!selectedCollection ? (
                <p className="px-1 py-8 text-center text-xs text-slate-400">← 왼쪽에서 수집을 선택하세요.</p>
              ) : availableMaps.length === 0 ? (
                <p className="px-1 py-8 text-center text-xs text-amber-600">
                  이 수집에 연결된 매핑이 없습니다.
                  <br />
                  매핑 설정에서 먼저 등록하세요.
                </p>
              ) : (
                availableMaps.map((m) => {
                  const checked = draft.mapIds.includes(m.mapId);
                  return (
                    <button
                      type="button"
                      key={m.mapId}
                      onClick={() => toggleMap(m.mapId)}
                      className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition ${
                        checked ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
                          checked ? "border-sky-500 bg-sky-500 text-white" : "border-slate-300 text-transparent"
                        }`}
                      >
                        ✓
                      </span>
                      <span className="text-sm text-slate-800">{m.label}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 데이터 가공 (선택) — 선택한 매핑을 입력으로 쓰는 가공만 노출 */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h4 className="text-sm font-semibold text-slate-900">
            데이터 가공
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              선택
            </span>
          </h4>
          <p className="text-xs text-slate-500">매핑 이후 실행할 가공을 선택합니다. 들여쓰기된 가공은 상위 가공을 먼저 선택해야 활성화됩니다. (번호 = 실행 순서)</p>
        </div>
        <div className="mt-3 space-y-1.5">
          {availableTransforms.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-slate-400">
              선택한 매핑을 입력으로 쓰는 가공이 없습니다. (데이터 가공 탭에서 먼저 등록하세요)
            </p>
          ) : (
            availableTransforms.map(({ t, depth, enabled }) => {
              const order = draft.transformIds.indexOf(t.transformId);
              const checked = order >= 0;
              const disabled = !checked && !enabled;
              return (
                <button
                  type="button"
                  key={t.transformId}
                  onClick={() => {
                    if (!disabled) toggleTransform(t.transformId);
                  }}
                  disabled={disabled}
                  title={disabled ? "상위 가공을 먼저 선택하세요." : undefined}
                  style={{ marginLeft: depth * 22, width: `calc(100% - ${depth * 22}px)` }}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition ${
                    checked
                      ? "border-violet-300 bg-violet-50"
                      : disabled
                        ? "cursor-not-allowed border-slate-100 bg-slate-50 opacity-60"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  {depth > 0 ? <span className="text-slate-300">└</span> : null}
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-bold ${
                      checked ? "border-violet-500 bg-violet-500 text-white" : "border-slate-300 text-transparent"
                    }`}
                  >
                    {checked ? order + 1 : "✓"}
                  </span>
                  <span className={`text-sm ${disabled ? "text-slate-400" : "text-slate-800"}`}>{t.label}</span>
                  <span className="ml-auto text-[11px] text-slate-400">→ {t.outputName}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 스케줄 (수집 설정의 스케줄과 동일한 형태) */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <h4 className="border-b border-slate-100 pb-3 text-sm font-semibold text-slate-900">스케줄</h4>
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={draft.scheduleEnabled}
              onChange={(e) => setDraft({ ...draft, scheduleEnabled: e.target.checked })}
            />
            스케줄 활성화
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
              실행 방식
              <select
                value={draft.scheduleType}
                onChange={(e) => setDraft({ ...draft, scheduleType: e.target.value === "cron" ? "cron" : "interval" })}
                className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
              >
                <option value="interval">간격(분)</option>
                <option value="cron">CRON</option>
              </select>
            </label>
            {draft.scheduleType === "interval" ? (
              <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
                실행 주기(분)
                <input
                  type="number"
                  min={1}
                  value={draft.scheduleIntervalMinutes}
                  onChange={(e) =>
                    setDraft({ ...draft, scheduleIntervalMinutes: Math.max(1, Number(e.target.value) || 1) })
                  }
                  className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                />
              </label>
            ) : (
              <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
                CRON 표현식
                <input
                  value={draft.scheduleCronExpr}
                  onChange={(e) => setDraft({ ...draft, scheduleCronExpr: e.target.value })}
                  placeholder="예: 0 8 * * *"
                  className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                />
              </label>
            )}
          </div>
          <p className="text-[11px] text-slate-400">앱(서버) 가동 중에만 동작합니다.</p>
        </div>
      </div>

      {/* 실행 이력 */}
      {runs.length > 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <h4 className="border-b border-slate-100 pb-3 text-sm font-semibold text-slate-900">실행 이력</h4>
          <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-slate-100">
            <table className="min-w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-semibold">시작</th>
                  <th className="px-3 py-2 font-semibold">유형</th>
                  <th className="px-3 py-2 font-semibold">상태</th>
                  <th className="px-3 py-2 font-semibold">결과</th>
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
        </div>
      ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <RunStatusModal
        open={runNotice.open}
        state={runNotice.state}
        title={runNotice.title}
        message={runNotice.state === "loading" ? runProgressText || runNotice.message : runNotice.message}
        subMessage={runNotice.state === "loading" && runProgressText ? runNotice.message : undefined}
        onConfirm={() => setRunNotice((prev) => ({ ...prev, open: false }))}
        loadingAction={{
          label: cancelBusy ? "중단 중…" : "닫기(중단)",
          onClick: cancelRun,
          disabled: cancelBusy,
        }}
      />
    </>
  );
}
