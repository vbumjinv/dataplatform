"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import RunStatusModal, { type RunState } from "./RunStatusModal";
import SqlEditor from "./SqlEditor";

type TransformType =
  | "sql"
  | "resample"
  | "rate"
  | "combine"
  | "interpolate"
  | "movavg"
  | "python";
type ResampleUnit = "day" | "week" | "month" | "quarter" | "year";
type ResampleAgg = "avg" | "sum" | "max" | "min" | "last" | "first";
type RateType = "pop" | "yoy";
type CombineOp = "sub" | "add" | "mul" | "div";

type TransformConfig = {
  sql?: string;
  targetUnit?: ResampleUnit;
  agg?: ResampleAgg;
  rateType?: RateType;
  secondMapId?: number;
  op?: CombineOp;
  divToPercent?: boolean;
  window?: number;
  code?: string;
};

type TransformListItem = {
  transform_id: number;
  name: string;
  transform_type: TransformType;
  config: TransformConfig | null;
  source_series_name: string | null;
  output_name: string | null;
  output_freq: string | null;
  output_count: number;
  last_status: string | null;
};

type SourceOption = {
  mapId: number;
  label: string;
  freq: string;
  unit: string | null;
  isDerived: boolean;
};

type RunLog = {
  run_log_id: number;
  trigger_type: string;
  status: string;
  started_at: string;
  elapsed_ms: number | null;
  affected_count: number | null;
  error_message: string | null;
};

type Draft = {
  transformId: number | null;
  outputMapId: number | null;
  name: string;
  sourceMapId: number | null;
  transformType: TransformType;
  sql: string;
  targetUnit: ResampleUnit;
  agg: ResampleAgg;
  rateType: RateType;
  secondMapId: number | null;
  op: CombineOp;
  divToPercent: boolean;
  window: number;
  code: string;
  outputName: string;
  outputUnit: string;
  outputFreq: string;
};

type PreviewRow = { obsDate: string; obsValue: number | null };

const SQL_PLACEHOLDER = `select obs_date,
  (obs_value - lag(obs_value) over (order by obs_date))
    / nullif(lag(obs_value) over (order by obs_date), 0) * 100 as obs_value
from src`;

// 입력 시리즈를 고르면 편집창에 채워줄 src 정의 포함 템플릿.
// (WITH 로 시작하므로 시스템이 별도로 src 를 주입하지 않고 이 쿼리를 그대로 실행한다)
const sqlTemplateFor = (mapId: number) => `with src as (
  select obs_date, obs_value::numeric as obs_value
  from dp.viz_map_data
  where map_id = ${mapId}
)
select obs_date, obs_value
from src
order by obs_date`;

// Python 가공 기본 템플릿 (HP 필터로 추세 추출)
const PY_PLACEHOLDER = `# df: 입력 시리즈 (컬럼: ds=날짜, y=값), 날짜 오름차순
# 결과를 result 에 담으세요. df 를 그대로 두고 y 만 바꾸면 날짜축이 유지됩니다.
# 사용 가능: pandas(pd), numpy(np), statsmodels 등

from statsmodels.tsa.filters.hp_filter import hpfilter

# lamb(평활도): 월 14400 · 분기 1600 · 연 100
cycle, trend = hpfilter(df["y"], lamb=14400)
result = df.assign(y=trend)`

const UNIT_OPTIONS: Array<{ value: ResampleUnit; label: string }> = [
  { value: "week", label: "주" },
  { value: "month", label: "월" },
  { value: "quarter", label: "분기" },
  { value: "year", label: "년" },
];
// 업샘플(선형보간)용 — 일 포함
const INTERP_UNIT_OPTIONS: Array<{ value: ResampleUnit; label: string }> = [
  { value: "day", label: "일" },
  { value: "week", label: "주" },
  { value: "month", label: "월" },
  { value: "quarter", label: "분기" },
];
const AGG_OPTIONS: Array<{ value: ResampleAgg; label: string }> = [
  { value: "last", label: "마지막날" },
  { value: "first", label: "첫날" },
  { value: "avg", label: "평균" },
  { value: "sum", label: "합계" },
  { value: "max", label: "최대" },
  { value: "min", label: "최소" },
];
const OP_OPTIONS: Array<{ value: CombineOp; label: string }> = [
  { value: "sub", label: "빼기 (A − B)" },
  { value: "add", label: "더하기 (A + B)" },
  { value: "mul", label: "곱하기 (A × B)" },
  { value: "div", label: "나누기 (A ÷ B)" },
];
const TYPE_TABS: Array<{ value: TransformType; label: string }> = [
  { value: "rate", label: "증감률" },
  { value: "resample", label: "리샘플(집계)" },
  { value: "interpolate", label: "선형보간(업샘플)" },
  { value: "movavg", label: "이동평균" },
  { value: "combine", label: "두 시리즈 연산" },
  { value: "sql", label: "SQL 직접" },
  { value: "python", label: "Python" },
];

const emptyDraft = (): Draft => ({
  transformId: null,
  outputMapId: null,
  name: "",
  sourceMapId: null,
  transformType: "rate",
  sql: SQL_PLACEHOLDER,
  targetUnit: "month",
  agg: "avg",
  rateType: "pop",
  secondMapId: null,
  op: "sub",
  divToPercent: false,
  window: 60,
  code: PY_PLACEHOLDER,
  outputName: "",
  outputUnit: "",
  outputFreq: "",
});

const typeLabel = (item: TransformListItem) => {
  const c = item.config ?? {};
  if (item.transform_type === "sql") return "SQL";
  if (item.transform_type === "python") return "Python";
  if (item.transform_type === "resample") {
    const unit = UNIT_OPTIONS.find((u) => u.value === (c.targetUnit ?? "month"))?.label ?? "월";
    const agg = AGG_OPTIONS.find((a) => a.value === (c.agg ?? "avg"))?.label ?? "평균";
    return `리샘플 · ${unit}/${agg}`;
  }
  if (item.transform_type === "interpolate") {
    const unit = INTERP_UNIT_OPTIONS.find((u) => u.value === (c.targetUnit ?? "day"))?.label ?? "일";
    return `선형보간 · ${unit}`;
  }
  if (item.transform_type === "movavg") {
    const w = Number(c.window);
    return `이동평균 · ${Number.isFinite(w) && w > 0 ? w : "?"}구간`;
  }
  if (item.transform_type === "combine") {
    const op = OP_OPTIONS.find((o) => o.value === (c.op ?? "sub"))?.label ?? "빼기 (A − B)";
    return `연산 · ${op}`;
  }
  return `증감률 · ${c.rateType === "yoy" ? "전년동기대비" : "전기대비"}`;
};

const statusBadge = (status: string | null) => {
  if (status === "success") return <span className="text-emerald-700">성공</span>;
  if (status === "error") return <span className="text-rose-600">실패</span>;
  if (status === "running") return <span className="text-slate-500">실행 중</span>;
  return <span className="text-slate-400">-</span>;
};

export default function DataTransformPanel({ dbSettingId }: { dbSettingId: string }) {
  const [items, setItems] = useState<TransformListItem[]>([]);
  const [listError, setListError] = useState("");
  const [listMsg, setListMsg] = useState("");
  const [runningId, setRunningId] = useState<number | null>(null);
  const [sourceOptions, setSourceOptions] = useState<SourceOption[]>([]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState("");
  const [runs, setRuns] = useState<RunLog[]>([]);

  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  const [runNotice, setRunNotice] = useState<{
    open: boolean;
    state: RunState;
    title: string;
    message: string;
  }>({ open: false, state: "loading", title: "", message: "" });

  const withDb = useCallback(
    (path: string) => {
      if (!dbSettingId) return path;
      const sep = path.includes("?") ? "&" : "?";
      return `${path}${sep}dbSettingId=${encodeURIComponent(dbSettingId)}`;
    },
    [dbSettingId],
  );

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(withDb("/api/data-transform"));
      const payload = (await res.json()) as { ok?: boolean; items?: TransformListItem[]; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "가공 목록을 불러오지 못했습니다.");
      setItems(payload.items ?? []);
      setListError("");
    } catch (error) {
      setListError(error instanceof Error ? error.message : "목록 오류");
    }
  }, [withDb]);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch(withDb("/api/visualization/map-mst"));
      const payload = (await res.json()) as {
        ok?: boolean;
        items?: Array<{ mapId: number | string; seriesName: string; sourceOrg?: string; freq?: string | null; unitName?: string | null }>;
      };
      if (!payload.ok) return setSourceOptions([]);
      // 매핑(원본) + 파생(가공 결과) 모두 입력 후보로 노출 → 가공 결과 재가공(체이닝) 지원
      setSourceOptions(
        (payload.items ?? []).map((m) => {
          const isDerived = (m.sourceOrg ?? "").toLowerCase() === "derived";
          return {
            mapId: Number(m.mapId),
            label: isDerived ? `[가공] ${m.seriesName}` : m.seriesName,
            freq: (m.freq ?? "").toUpperCase(),
            unit: m.unitName ?? null,
            isDerived,
          };
        }),
      );
    } catch {
      setSourceOptions([]);
    }
  }, [withDb]);

  useEffect(() => {
    void fetchList();
    void fetchSources();
  }, [fetchList, fetchSources]);

  const fetchRuns = useCallback(
    async (transformId: number) => {
      try {
        const res = await fetch(withDb(`/api/data-transform/${transformId}/runs`));
        const payload = (await res.json()) as { ok?: boolean; runs?: RunLog[] };
        if (res.ok && payload.ok) setRuns(payload.runs ?? []);
      } catch {
        // ignore
      }
    },
    [withDb],
  );

  const startCreate = () => {
    setSaveError("");
    setSaveMsg("");
    setRunMsg("");
    setRuns([]);
    setPreview([]);
    setPreviewError("");
    setDraft(emptyDraft());
  };

  const startEdit = async (transformId: number) => {
    setSaveError("");
    setSaveMsg("");
    setRunMsg("");
    setRuns([]);
    setPreview([]);
    setPreviewError("");
    try {
      const res = await fetch(withDb(`/api/data-transform/${transformId}`));
      const payload = (await res.json()) as {
        ok?: boolean;
        transform?: {
          transform_id: number;
          output_map_id: number | null;
          name: string;
          transform_type: TransformType;
          source_map_id: number | null;
          config: TransformConfig | null;
          output_name: string | null;
          output_unit: string | null;
          output_freq: string | null;
        };
        error?: string;
      };
      if (!res.ok || !payload.ok || !payload.transform) {
        throw new Error(payload.error || "가공 정의를 불러오지 못했습니다.");
      }
      const t = payload.transform;
      const c = t.config ?? {};
      setDraft({
        transformId: t.transform_id,
        outputMapId: t.output_map_id == null ? null : Number(t.output_map_id),
        name: t.name,
        sourceMapId: t.source_map_id == null ? null : Number(t.source_map_id),
        transformType: t.transform_type,
        sql: c.sql ?? SQL_PLACEHOLDER,
        targetUnit: c.targetUnit ?? "month",
        agg: c.agg ?? "avg",
        rateType: c.rateType ?? "pop",
        secondMapId: c.secondMapId == null ? null : Number(c.secondMapId),
        op: c.op ?? "sub",
        divToPercent: Boolean(c.divToPercent),
        window: Number(c.window) > 0 ? Number(c.window) : 60,
        code: c.code ?? PY_PLACEHOLDER,
        outputName: t.output_name ?? "",
        outputUnit: t.output_unit ?? "",
        outputFreq: t.output_freq ?? "",
      });
      void fetchRuns(t.transform_id);
    } catch (error) {
      setListMsg(error instanceof Error ? error.message : "불러오기 오류");
    }
  };

  const closeModal = () => {
    setDraft(null);
    void fetchList();
    void fetchSources();
  };

  const selectedSource = useMemo(
    () => sourceOptions.find((s) => s.mapId === draft?.sourceMapId) ?? null,
    [sourceOptions, draft?.sourceMapId],
  );

  // 입력 후보: 수정 중인 가공 자신의 출력 시리즈는 제외 (자기참조 차단)
  const selectableSources = useMemo(
    () => sourceOptions.filter((s) => s.mapId !== draft?.outputMapId),
    [sourceOptions, draft?.outputMapId],
  );

  const buildConfig = (d: Draft): TransformConfig => {
    if (d.transformType === "sql") return { sql: d.sql };
    if (d.transformType === "resample") return { targetUnit: d.targetUnit, agg: d.agg };
    if (d.transformType === "interpolate") return { targetUnit: d.targetUnit };
    if (d.transformType === "movavg") return { window: d.window };
    if (d.transformType === "combine") {
      return {
        secondMapId: d.secondMapId ?? undefined,
        op: d.op,
        divToPercent: d.op === "div" ? Boolean(d.divToPercent) : false,
      };
    }
    if (d.transformType === "python") {
      return { code: d.code, secondMapId: d.secondMapId ?? undefined };
    }
    return { rateType: d.rateType };
  };

  const buildBody = (d: Draft) => ({
    name: d.name,
    sourceMapId: d.sourceMapId,
    transformType: d.transformType,
    config: buildConfig(d),
    outputName: d.outputName.trim() || d.name.trim(),
    outputUnit: d.outputUnit.trim() || null,
    outputFreq:
      d.transformType === "sql" || d.transformType === "python"
        ? d.outputFreq.trim() || null
        : null,
  });

  const runPreview = async () => {
    if (!draft) return;
    if (!draft.sourceMapId) return setPreviewError("입력 시리즈를 선택하세요.");
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const res = await fetch(withDb("/api/data-transform/preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceMapId: draft.sourceMapId,
          transformType: draft.transformType,
          config: buildConfig(draft),
        }),
      });
      const payload = (await res.json()) as { ok?: boolean; rows?: PreviewRow[]; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "미리보기에 실패했습니다.");
      setPreview(payload.rows ?? []);
    } catch (error) {
      setPreview([]);
      setPreviewError(error instanceof Error ? error.message : "미리보기 오류");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setSaveError("이름을 입력하세요.");
    if (!draft.sourceMapId) return setSaveError("입력 시리즈를 선택하세요.");
    setSaving(true);
    setSaveError("");
    setSaveMsg("");
    try {
      const isNew = draft.transformId == null;
      const res = await fetch(
        withDb(isNew ? "/api/data-transform" : `/api/data-transform/${draft.transformId}`),
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody(draft)),
        },
      );
      const payload = (await res.json()) as { ok?: boolean; transformId?: number; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "저장에 실패했습니다.");
      setSaveMsg("저장되었습니다.");
      const id = payload.transformId ?? draft.transformId;
      if (id && draft.transformId == null) {
        setDraft((d) => (d ? { ...d, transformId: id } : d));
      }
      void fetchList();
      void fetchSources();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "저장 오류");
    } finally {
      setSaving(false);
    }
  };

  const runTransformRequest = async (transformId: number, name: string) => {
    setRunNotice({ open: true, state: "loading", title: "실행 중", message: name });
    try {
      const res = await fetch(withDb(`/api/data-transform/${transformId}/run`), { method: "POST" });
      const payload = (await res.json()) as { ok?: boolean; affectedCount?: number; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "실행에 실패했습니다.");
      setRunNotice({
        open: true,
        state: "success",
        title: "가공 완료",
        message: `${payload.affectedCount ?? 0}건이 생성되었습니다.`,
      });
    } catch (error) {
      setRunNotice({
        open: true,
        state: "error",
        title: "실행 실패",
        message: error instanceof Error ? error.message : "실행 오류",
      });
    }
  };

  const handleRunById = async (transformId: number, name: string) => {
    setRunningId(transformId);
    setListMsg("");
    await runTransformRequest(transformId, name);
    await fetchList();
    await fetchSources();
    setRunningId(null);
  };

  const handleRunInModal = async () => {
    if (!draft?.transformId) return setRunMsg("먼저 저장한 뒤 실행하세요.");
    setRunning(true);
    setRunMsg("");
    await runTransformRequest(draft.transformId, draft.name);
    await fetchRuns(draft.transformId);
    await fetchSources();
    setRunning(false);
  };

  const handleDeleteById = async (transformId: number, name: string) => {
    if (!window.confirm(`'${name}' 가공을 삭제할까요? 생성된 파생 시리즈도 함께 삭제됩니다.`)) return;
    try {
      const res = await fetch(withDb(`/api/data-transform/${transformId}`), { method: "DELETE" });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || "삭제에 실패했습니다.");
      setListMsg("삭제되었습니다.");
      await fetchList();
      await fetchSources();
    } catch (error) {
      setListMsg(error instanceof Error ? error.message : "삭제 오류");
    }
  };

  const updateDraft = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  // 유형 전환 시 목표 주기 기본값 보정 (보간=일, 집계는 일 선택 불가→월)
  const changeType = (type: TransformType) =>
    setDraft((d) => {
      if (!d) return d;
      if (type === "sql") {
        // SQL 직접 전환 시, 입력 시리즈가 있고 편집창이 비어있/기본값이면 src 정의 템플릿을 채운다.
        const sql =
          d.sourceMapId && (!d.sql.trim() || d.sql === SQL_PLACEHOLDER)
            ? sqlTemplateFor(d.sourceMapId)
            : d.sql;
        return { ...d, transformType: type, sql };
      }
      if (type === "python") {
        // Python 전환 시 편집창이 비어있으면 HP 필터 템플릿을 채운다.
        const code = d.code.trim() ? d.code : PY_PLACEHOLDER;
        return { ...d, transformType: type, code };
      }
      if (type === "interpolate") return { ...d, transformType: type, targetUnit: "day" };
      if (type === "resample" && d.targetUnit === "day") {
        return { ...d, transformType: type, targetUnit: "month" };
      }
      return { ...d, transformType: type };
    });

  // 입력 시리즈 선택/변경: SQL 직접이면 편집창의 src 정의(map_id)를 함께 맞춰준다.
  const changeSource = (id: number | null) =>
    setDraft((d) => {
      if (!d) return d;
      if (d.transformType !== "sql") return { ...d, sourceMapId: id };
      let sql = d.sql;
      if (id) {
        if (!sql.trim() || sql === SQL_PLACEHOLDER) {
          sql = sqlTemplateFor(id); // 비었거나 기본값이면 전체 템플릿
        } else if (/^with\s+src\s+as/i.test(sql.trim())) {
          sql = sql.replace(/map_id\s*=\s*\d+/i, `map_id = ${id}`); // 선두 src 의 map_id 만 동기화
        }
      }
      return { ...d, sourceMapId: id, sql };
    });

  return (
    <>
      {/* 목록: 수집/매핑/파이프라인과 동일한 카드+테이블 */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <h4 className="text-base font-semibold leading-6 text-slate-900">데이터 가공 관리</h4>
          <button
            type="button"
            onClick={startCreate}
            className="inline-flex h-8 items-center rounded-full bg-slate-900 px-3 text-xs font-semibold text-white transition hover:bg-slate-800"
          >
            가공 생성
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold leading-6 text-slate-900">가공 목록</h3>
          <span className="inline-flex h-7 items-center rounded-full border border-slate-200 px-3 text-xs font-semibold text-slate-500">
            {items.length}건
          </span>
        </div>
        {listError ? <p className="mt-2 text-xs text-rose-600">{listError}</p> : null}
        {listMsg ? <p className="mt-2 text-xs text-slate-500">{listMsg}</p> : null}
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full table-fixed text-center text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="w-[16%] px-3 py-2 text-left">이름</th>
                <th className="w-[20%] px-3 py-2">입력 시리즈</th>
                <th className="w-[16%] px-3 py-2">유형</th>
                <th className="w-[22%] px-3 py-2">출력 시리즈</th>
                <th className="w-[8%] px-3 py-2">최근</th>
                <th className="w-[18%] px-3 py-2">작업</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td className="px-2 py-4 text-slate-500" colSpan={6}>
                    등록된 가공이 없습니다. &ldquo;가공 생성&rdquo;으로 만드세요.
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr key={it.transform_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-left font-medium text-slate-800">{it.name}</td>
                    <td className="px-3 py-2 text-slate-600">{it.source_series_name ?? "미지정"}</td>
                    <td className="px-3 py-2 text-slate-600">{typeLabel(it)}</td>
                    <td className="px-3 py-2 text-slate-600">
                      <span className="rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">
                        {it.output_name ?? "-"}
                      </span>
                      <span className="ml-1 text-[11px] text-slate-400">
                        {it.output_freq ?? ""} · {it.output_count}건
                      </span>
                    </td>
                    <td className="px-3 py-2">{statusBadge(it.last_status)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleRunById(it.transform_id, it.name)}
                          disabled={runningId === it.transform_id}
                          className="rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {runningId === it.transform_id ? "실행 중…" : "즉시 실행"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void startEdit(it.transform_id)}
                          className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteById(it.transform_id, it.name)}
                          className="rounded-full border border-rose-200 px-3 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50"
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
                {draft.transformId == null ? "데이터 가공 생성" : "데이터 가공 수정"}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRunInModal}
                  disabled={running || draft.transformId == null}
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
              {/* 이름 + 입력 시리즈 */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">가공 이름</label>
                  <input
                    value={draft.name}
                    onChange={(e) => updateDraft({ name: e.target.value })}
                    placeholder="예) 소비자물가 상승률"
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">입력 시리즈</label>
                  <select
                    value={draft.sourceMapId ?? ""}
                    onChange={(e) => changeSource(e.target.value ? Number(e.target.value) : null)}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                  >
                    <option value="">시리즈 선택…</option>
                    {selectableSources.map((s) => (
                      <option key={s.mapId} value={s.mapId}>
                        {s.label}
                        {s.freq ? ` (${s.freq})` : ""}
                      </option>
                    ))}
                  </select>
                  {selectedSource?.isDerived ? (
                    <p className="mt-1 text-[11px] text-amber-600">
                      ⚠ 이 입력은 가공 결과입니다. 상위 가공을 먼저 실행(또는 같은 파이프라인에 순서대로 포함)해야 최신 값이 반영됩니다.
                    </p>
                  ) : null}
                </div>
              </div>

              {/* 변환 유형 탭 */}
              <div className="rounded-3xl border border-slate-200 bg-white p-5">
                <div className="flex flex-wrap gap-1.5 border-b border-slate-100 pb-3">
                  {TYPE_TABS.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => changeType(t.value)}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                        draft.transformType === t.value
                          ? "bg-slate-900 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="mt-3">
                  {draft.transformType === "rate" ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="min-w-[12rem] flex-1 space-y-1 text-xs text-slate-600">
                        증감률 유형
                        <select
                          value={draft.rateType}
                          onChange={(e) =>
                            updateDraft({ rateType: e.target.value === "yoy" ? "yoy" : "pop" })
                          }
                          className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                        >
                          <option value="pop">전기대비 (직전 관측치 대비 %)</option>
                          <option value="yoy">전년동기대비 (1년 전 대비 %)</option>
                        </select>
                      </label>
                      <p className="flex-1 text-[11px] text-slate-400">
                        입력 시리즈의 각 시점 값을 기준 시점과 비교해 변화율(%)을 계산합니다.
                      </p>
                    </div>
                  ) : null}

                  {draft.transformType === "resample" ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
                        목표 주기
                        <select
                          value={draft.targetUnit}
                          onChange={(e) => updateDraft({ targetUnit: e.target.value as ResampleUnit })}
                          className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                        >
                          {UNIT_OPTIONS.map((u) => (
                            <option key={u.value} value={u.value}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
                        집계 방식
                        <select
                          value={draft.agg}
                          onChange={(e) => updateDraft({ agg: e.target.value as ResampleAgg })}
                          className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                        >
                          {AGG_OPTIONS.map((a) => (
                            <option key={a.value} value={a.value}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : null}

                  {draft.transformType === "interpolate" ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
                        목표 주기
                        <select
                          value={draft.targetUnit}
                          onChange={(e) => updateDraft({ targetUnit: e.target.value as ResampleUnit })}
                          className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                        >
                          {INTERP_UNIT_OPTIONS.map((u) => (
                            <option key={u.value} value={u.value}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="flex-1 text-[11px] text-amber-600">
                        ⚠ 원본보다 촘촘한 주기로 <b>없는 값을 추정</b>합니다. 두 관측치 사이를 직선으로 이어
                        채우므로(선형보간) 실제값이 아닌 추정치입니다. (예: 월 → 일)
                      </p>
                    </div>
                  ) : null}

                  {draft.transformType === "movavg" ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
                        이동평균 구간 (관측치 개수)
                        <input
                          type="number"
                          min={2}
                          max={1000}
                          step={1}
                          value={draft.window}
                          onChange={(e) =>
                            updateDraft({ window: Math.trunc(Number(e.target.value)) || 0 })
                          }
                          className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                        />
                      </label>
                      <p className="flex-1 text-[11px] text-slate-400">
                        주기(일·월·년)와 무관하게 <b>최근 N개 관측치</b>의 평균을 냅니다.
                        월 데이터면 60 = 60개월, 일 데이터면 60 = 60일. 윈도우가 다 차기 전(앞쪽 N−1개)은
                        결과에서 제외됩니다. 출력 주기는 입력과 동일합니다.
                      </p>
                    </div>
                  ) : null}

                  {draft.transformType === "combine" ? (
                    <div className="space-y-3">
                      <p className="text-[11px] text-slate-500">
                        입력 시리즈(A)와 두 번째 시리즈(B)를 <b>obs_date(날짜)가 일치하는 행만</b> 묶어 연산합니다.
                        (위의 &ldquo;입력 시리즈&rdquo;가 A 입니다)
                      </p>
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="min-w-[14rem] flex-1 space-y-1 text-xs text-slate-600">
                          두 번째 시리즈 (B)
                          <select
                            value={draft.secondMapId ?? ""}
                            onChange={(e) =>
                              updateDraft({ secondMapId: e.target.value ? Number(e.target.value) : null })
                            }
                            className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                          >
                            <option value="">시리즈 선택…</option>
                            {selectableSources
                              .filter((s) => s.mapId !== draft.sourceMapId)
                              .map((s) => (
                                <option key={s.mapId} value={s.mapId}>
                                  {s.label}
                                  {s.freq ? ` (${s.freq})` : ""}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="min-w-[10rem] flex-1 space-y-1 text-xs text-slate-600">
                          연산
                          <select
                            value={draft.op}
                            onChange={(e) => {
                              const nextOp = e.target.value as CombineOp;
                              updateDraft({
                                op: nextOp,
                                divToPercent: nextOp === "div" ? draft.divToPercent : false,
                              });
                            }}
                            className="block w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
                          >
                            {OP_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {draft.op === "div" ? (
                        <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={Boolean(draft.divToPercent)}
                            onChange={(e) => updateDraft({ divToPercent: e.target.checked })}
                          />
                          나누기 결과를 %로 변환 (x100)
                        </label>
                      ) : null}
                      <p className="text-[11px] text-slate-400">
                        예) A=수출, B=수입 → 빼기 = 무역수지. 양쪽 모두 값이 있는 날짜만 결과로 남습니다.
                      </p>
                    </div>
                  ) : null}

                  {draft.transformType === "sql" ? (
                    <div className="space-y-2">
                      <p className="text-[11px] text-slate-500">
                        입력 시리즈를 고르면 <code className="rounded bg-slate-100 px-1">with src as (…)</code> 정의가
                        편집창에 자동으로 채워집니다. 이 전체 쿼리를 직접 수정할 수 있으며, 최종적으로{" "}
                        <code className="rounded bg-slate-100 px-1">obs_date</code>,{" "}
                        <code className="rounded bg-slate-100 px-1">obs_value</code> 두 컬럼을 산출하면 됩니다.{" "}
                        <code className="rounded bg-slate-100 px-1">--</code> 로 시작하면 그 줄은 주석(초록색)으로 처리됩니다.
                      </p>
                      <SqlEditor
                        value={draft.sql}
                        onChange={(next) => updateDraft({ sql: next })}
                        rows={12}
                      />
                      <label className="block text-xs text-slate-600">
                        출력 주기(freq)
                        <input
                          value={draft.outputFreq}
                          onChange={(e) => updateDraft({ outputFreq: e.target.value })}
                          placeholder="예) M / Q / Y (비우면 입력 시리즈와 동일)"
                          className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm focus:border-slate-400 focus:outline-none"
                        />
                      </label>
                    </div>
                  ) : null}

                  {draft.transformType === "python" ? (
                    <div className="space-y-2">
                      <p className="text-[11px] text-slate-500">
                        입력 시리즈가 <code className="rounded bg-slate-100 px-1">df</code>(컬럼{" "}
                        <code className="rounded bg-slate-100 px-1">ds</code>=날짜,{" "}
                        <code className="rounded bg-slate-100 px-1">y</code>=값, 날짜 오름차순)로 주어집니다.
                        아래에서 <b>보조 시리즈</b>를 지정하면{" "}
                        <code className="rounded bg-slate-100 px-1">df2</code>(같은 형식)로도 제공됩니다.
                        변환 결과를 <code className="rounded bg-slate-100 px-1">result</code> 변수에 담으면 됩니다.
                        <code className="rounded bg-slate-100 px-1">pandas</code>,{" "}
                        <code className="rounded bg-slate-100 px-1">numpy</code>,{" "}
                        <code className="rounded bg-slate-100 px-1">statsmodels</code> 를 사용할 수 있습니다.
                      </p>
                      <label className="block text-xs text-slate-600">
                        보조 시리즈 (df2, 선택)
                        <select
                          value={draft.secondMapId ?? ""}
                          onChange={(e) =>
                            updateDraft({ secondMapId: e.target.value ? Number(e.target.value) : null })
                          }
                          className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm focus:border-slate-400 focus:outline-none"
                        >
                          <option value="">사용 안 함</option>
                          {selectableSources
                            .filter((s) => s.mapId !== draft.sourceMapId)
                            .map((s) => (
                              <option key={s.mapId} value={s.mapId}>
                                {s.label}
                                {s.freq ? ` (${s.freq})` : ""}
                              </option>
                            ))}
                        </select>
                      </label>
                      <textarea
                        value={draft.code}
                        onChange={(e) => updateDraft({ code: e.target.value })}
                        spellCheck={false}
                        rows={14}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-[12px] focus:border-slate-400 focus:outline-none"
                      />
                      <label className="block text-xs text-slate-600">
                        출력 주기(freq)
                        <input
                          value={draft.outputFreq}
                          onChange={(e) => updateDraft({ outputFreq: e.target.value })}
                          placeholder="예) M / Q / Y (비우면 입력 시리즈와 동일)"
                          className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm focus:border-slate-400 focus:outline-none"
                        />
                      </label>
                      <p className="text-[11px] text-amber-600">
                        ⚠ 작성한 코드는 서버의 Python 서비스에서 그대로 실행됩니다. (운영자 전용)
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* 출력 + 미리보기 */}
              <div className="rounded-3xl border border-slate-200 bg-white p-5">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <h4 className="text-sm font-semibold text-slate-900">출력 시리즈</h4>
                  <button
                    type="button"
                    onClick={runPreview}
                    disabled={previewLoading || !draft.sourceMapId}
                    className="inline-flex h-8 items-center rounded-full border border-sky-200 bg-sky-50 px-3 text-xs font-semibold text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {previewLoading ? "계산 중…" : "미리보기"}
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="block text-xs text-slate-600">
                    출력 시리즈명
                    <input
                      value={draft.outputName}
                      onChange={(e) => updateDraft({ outputName: e.target.value })}
                      placeholder={draft.name || "비우면 가공 이름과 동일"}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm focus:border-slate-400 focus:outline-none"
                    />
                  </label>
                  <label className="block text-xs text-slate-600">
                    단위
                    <input
                      value={draft.outputUnit}
                      onChange={(e) => updateDraft({ outputUnit: e.target.value })}
                      placeholder={
                        draft.transformType === "rate"
                          ? "예) %"
                          : selectedSource?.unit ?? "예) 지수"
                      }
                      className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm focus:border-slate-400 focus:outline-none"
                    />
                  </label>
                </div>

                {previewError ? <p className="mt-2 text-xs text-rose-600">{previewError}</p> : null}
                {preview.length > 0 ? (
                  <div className="mt-3 max-h-56 overflow-auto rounded-xl border border-slate-100">
                    <table className="min-w-full text-left text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-3 py-2 font-semibold">날짜</th>
                          <th className="px-3 py-2 font-semibold text-right">값</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, i) => (
                          <tr key={`${row.obsDate}-${i}`} className="border-t border-slate-100">
                            <td className="px-3 py-1.5 text-slate-600">{row.obsDate}</td>
                            <td className="px-3 py-1.5 text-right font-mono text-slate-800">
                              {row.obsValue == null
                                ? "-"
                                : row.obsValue.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs">
                {saveError ? <span className="text-rose-600">{saveError}</span> : null}
                {saveMsg ? <span className="text-emerald-700">{saveMsg}</span> : null}
                {runMsg ? <span className="text-slate-600">{runMsg}</span> : null}
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
                        {runs.map((r) => (
                          <tr key={r.run_log_id} className="border-t border-slate-100">
                            <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                              {new Date(r.started_at).toLocaleString("ko-KR")}
                            </td>
                            <td className="px-3 py-1.5 text-slate-600">
                              {r.trigger_type === "schedule" ? "자동" : "수동"}
                            </td>
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
                              {r.affected_count != null ? `${r.affected_count}건` : ""}
                              {r.error_message ? (
                                <span className="ml-1 text-rose-600">({r.error_message})</span>
                              ) : null}
                            </td>
                          </tr>
                        ))}
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
        message={runNotice.message}
        onConfirm={() => setRunNotice((prev) => ({ ...prev, open: false }))}
      />
    </>
  );
}
