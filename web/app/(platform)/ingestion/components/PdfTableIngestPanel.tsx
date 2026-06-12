"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";

type ExtractResult = {
  detectedTitle: string | null;
  unit: string | null;
  columns: string[];
  rows: Array<Array<string | number>>;
  notes: string | null;
};

type TargetColumnType = "text" | "numeric" | "date";

const PREVIEW_LIMIT = 30;

const isNumericLike = (value: string | number): boolean => {
  if (typeof value === "number") return Number.isFinite(value);
  const text = value
    .replace(/,/g, "")
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/[%\s]/g, "")
    .trim();
  if (!text) return false;
  return /^[-+]?\d*\.?\d+$/.test(text);
};

// 헤더/데이터로부터 항목(라벨) 컬럼과 값 컬럼을 추론한다.
const inferMapping = (
  columns: string[],
  rows: Array<Array<string | number>>,
): { labelColIndex: number; valueColIndices: number[] } => {
  const numericFlags = columns.map((_, colIndex) => {
    const sample = rows.slice(0, 10).map((row) => row[colIndex]);
    const numericCount = sample.filter(
      (cell) => cell != null && cell !== "" && isNumericLike(cell),
    ).length;
    return sample.length > 0 && numericCount >= Math.ceil(sample.length / 2);
  });
  const firstLabel = numericFlags.findIndex((flag) => !flag);
  const labelColIndex = firstLabel >= 0 ? firstLabel : 0;
  const numericCols = columns
    .map((_, colIndex) => colIndex)
    .filter((colIndex) => numericFlags[colIndex]);
  const valueColIndices =
    numericCols.length > 0
      ? numericCols
      : columns.map((_, i) => i).filter((i) => i !== labelColIndex);
  return { labelColIndex, valueColIndices };
};

export default function PdfTableIngestPanel({
  dbSettingId,
}: {
  dbSettingId: string;
}) {
  // 1단계: 업로드 + 추출
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [pageHint, setPageHint] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [extractMessage, setExtractMessage] = useState("");
  const [result, setResult] = useState<ExtractResult | null>(null);

  // 대화형 보정
  const [responseId, setResponseId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState("");
  const [refineMessage, setRefineMessage] = useState("");

  // 2단계: 와이드 → 롱 매핑
  const [labelColIndex, setLabelColIndex] = useState(0);
  const [valueColIndices, setValueColIndices] = useState<number[]>([]);
  const [baseDate, setBaseDate] = useState("");

  // 대상 컬럼명
  const [dateColName, setDateColName] = useState("기준일자");
  const [itemColName, setItemColName] = useState("항목");
  const [metricColName, setMetricColName] = useState("구분");
  const [valueColName, setValueColName] = useState("값");

  // 3단계: 대상 테이블
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [targetSchema, setTargetSchema] = useState("public");
  const [targetTable, setTargetTable] = useState("");
  const [createIfMissing, setCreateIfMissing] = useState(true);
  const [truncate, setTruncate] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [commitSuccess, setCommitSuccess] = useState("");

  const withDbBody = useCallback(
    <T extends Record<string, unknown>>(body: T) => {
      const numericId = Number(dbSettingId);
      if (dbSettingId && Number.isFinite(numericId) && numericId > 0) {
        return { ...body, dbSettingId: numericId };
      }
      return body;
    },
    [dbSettingId],
  );

  // 스키마 목록 로드
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/ingestion/db-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withDbBody({ action: "schemas" })),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          schemas?: string[];
        };
        if (!cancelled && response.ok && payload.ok) {
          setSchemas(payload.schemas ?? []);
        }
      } catch {
        // 무시 (자유 입력 가능)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [withDbBody]);

  // 스키마 변경 시 테이블 목록 로드
  useEffect(() => {
    let cancelled = false;
    if (!targetSchema.trim()) {
      setTables([]);
      return;
    }
    (async () => {
      try {
        const response = await fetch("/api/ingestion/db-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            withDbBody({ action: "tables", schema: targetSchema.trim() }),
          ),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          tables?: string[];
        };
        if (!cancelled && response.ok && payload.ok) {
          setTables(payload.tables ?? []);
        }
      } catch {
        // 무시
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetSchema, withDbBody]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setResult(null);
    setExtractError("");
    setExtractMessage("");
    setCommitSuccess("");
    setCommitError("");
  };

  const handleExtract = async () => {
    if (!file) {
      setExtractError("PDF 파일을 선택하세요.");
      return;
    }
    if (!description.trim()) {
      setExtractError("추출할 표의 제목/설명을 입력하세요.");
      return;
    }
    setExtracting(true);
    setExtractError("");
    setExtractMessage("");
    setResult(null);
    setCommitSuccess("");
    setCommitError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("description", description.trim());
      if (pageHint.trim()) form.append("pageHint", pageHint.trim());
      const response = await fetch("/api/ingestion/pdf-extract", {
        method: "POST",
        body: form,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        found?: boolean;
        responseId?: string | null;
        detectedTitle?: string | null;
        unit?: string | null;
        columns?: string[];
        rows?: Array<Array<string | number>>;
        notes?: string | null;
        message?: string;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "표 추출에 실패했습니다.");
      }
      setResponseId(payload.responseId ?? null);
      if (!payload.found) {
        setExtractMessage(payload.message || "설명에 맞는 표를 찾지 못했습니다.");
        return;
      }
      const columns = payload.columns ?? [];
      const rows = payload.rows ?? [];
      setResult({
        detectedTitle: payload.detectedTitle ?? null,
        unit: payload.unit ?? null,
        columns,
        rows,
        notes: payload.notes ?? null,
      });
      const mapping = inferMapping(columns, rows);
      setLabelColIndex(mapping.labelColIndex);
      setValueColIndices(mapping.valueColIndices);
      setHistory([description.trim()]);
      setRefineMessage("");
      setRefineError("");
      setRefineInstruction("");
    } catch (error) {
      setExtractError(
        error instanceof Error ? error.message : "표 추출에 실패했습니다.",
      );
    } finally {
      setExtracting(false);
    }
  };

  const handleRefine = async () => {
    if (!result) return;
    if (!responseId) {
      setRefineError("대화형 수정을 사용할 수 없습니다. 다시 추출해 주세요.");
      return;
    }
    if (!refineInstruction.trim()) {
      setRefineError("수정 요청 내용을 입력하세요.");
      return;
    }
    setRefining(true);
    setRefineError("");
    setRefineMessage("");
    setCommitSuccess("");
    setCommitError("");
    const instruction = refineInstruction.trim();
    try {
      const response = await fetch("/api/ingestion/pdf-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previousResponseId: responseId,
          instruction,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        found?: boolean;
        responseId?: string | null;
        detectedTitle?: string | null;
        unit?: string | null;
        columns?: string[];
        rows?: Array<Array<string | number>>;
        notes?: string | null;
        message?: string;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "표 수정에 실패했습니다.");
      }
      if (payload.responseId) setResponseId(payload.responseId);
      if (!payload.found) {
        setRefineMessage(payload.message || "요청을 반영하지 못했습니다.");
        return;
      }
      const columns = payload.columns ?? [];
      const rows = payload.rows ?? [];
      const prevColCount = result.columns.length;
      setResult({
        detectedTitle: payload.detectedTitle ?? null,
        unit: payload.unit ?? null,
        columns,
        rows,
        notes: payload.notes ?? null,
      });
      // 컬럼 구성이 바뀌면 매핑 재추론, 동일하면 기존 매핑 유지
      if (columns.length !== prevColCount) {
        const mapping = inferMapping(columns, rows);
        setLabelColIndex(mapping.labelColIndex);
        setValueColIndices(mapping.valueColIndices);
      } else {
        setValueColIndices((prev) => prev.filter((idx) => idx < columns.length));
        setLabelColIndex((prev) => (prev < columns.length ? prev : 0));
      }
      setHistory((prev) => [...prev, instruction]);
      setRefineInstruction("");
    } catch (error) {
      setRefineError(
        error instanceof Error ? error.message : "표 수정에 실패했습니다.",
      );
    } finally {
      setRefining(false);
    }
  };

  const includeMetricCol = valueColIndices.length > 1;

  const toggleValueCol = (colIndex: number) => {
    setValueColIndices((prev) =>
      prev.includes(colIndex)
        ? prev.filter((idx) => idx !== colIndex)
        : [...prev, colIndex].sort((a, b) => a - b),
    );
  };

  // 와이드 → 롱 변환 결과 (대상 컬럼 순서: 날짜, 항목, [구분], 값)
  const targetColumns = useMemo(() => {
    const cols: Array<{ name: string; type: TargetColumnType }> = [
      { name: dateColName.trim() || "기준일자", type: "date" },
      { name: itemColName.trim() || "항목", type: "text" },
    ];
    if (includeMetricCol) {
      cols.push({ name: metricColName.trim() || "구분", type: "text" });
    }
    cols.push({ name: valueColName.trim() || "값", type: "numeric" });
    return cols;
  }, [dateColName, itemColName, metricColName, valueColName, includeMetricCol]);

  const meltedRows = useMemo(() => {
    if (!result) return [];
    const out: Array<Array<string | number>> = [];
    result.rows.forEach((row) => {
      const label = row[labelColIndex];
      const labelText = label == null ? "" : String(label);
      valueColIndices.forEach((valueIndex) => {
        const value = row[valueIndex] ?? "";
        const cells: Array<string | number> = [baseDate, labelText];
        if (includeMetricCol) cells.push(result.columns[valueIndex] ?? "");
        cells.push(value);
        out.push(cells);
      });
    });
    return out;
  }, [result, labelColIndex, valueColIndices, baseDate, includeMetricCol]);

  const handleCommit = async () => {
    if (!result) return;
    if (!targetTable.trim()) {
      setCommitError("대상 테이블 이름을 입력하세요.");
      return;
    }
    if (valueColIndices.length === 0) {
      setCommitError("값으로 사용할 컬럼을 1개 이상 선택하세요.");
      return;
    }
    if (meltedRows.length === 0) {
      setCommitError("저장할 데이터가 없습니다.");
      return;
    }
    setCommitting(true);
    setCommitError("");
    setCommitSuccess("");
    try {
      const response = await fetch("/api/ingestion/pdf-load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withDbBody({
            schema: targetSchema.trim() || "public",
            table: targetTable.trim(),
            targetColumns,
            rows: meltedRows,
            createIfMissing,
            truncate,
          }),
        ),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        created?: boolean;
        inserted?: number;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "데이터 저장에 실패했습니다.");
      }
      setCommitSuccess(
        `${payload.inserted ?? 0}건 저장 완료${
          payload.created ? " (테이블 생성/확인됨)" : ""
        }.`,
      );
    } catch (error) {
      setCommitError(
        error instanceof Error ? error.message : "데이터 저장에 실패했습니다.",
      );
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* 1단계: 업로드 + 설명 */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="border-b border-slate-100 pb-3">
          <h4 className="text-base font-semibold leading-6 text-slate-900">
            PDF 표 추출 (AI)
          </h4>
          <p className="mt-1 text-sm text-slate-600">
            PDF를 업로드하고 추출할 표의 제목/설명을 입력하면 AI가 해당 표를 찾아
            구조화합니다.
          </p>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold text-slate-700">
              PDF 파일
            </label>
            <input
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-800"
            />
            {file ? (
              <p className="mt-1 text-xs text-slate-500">
                {file.name} ({Math.round((file.size / 1024 / 1024) * 100) / 100}MB)
              </p>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700">
              참고 페이지/위치 (선택)
            </label>
            <input
              type="text"
              value={pageHint}
              onChange={(e) => setPageHint(e.target.value)}
              placeholder="예) 5페이지 부근, 수출 동향 섹션"
              className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-xs font-semibold text-slate-700">
            추출할 표 제목/설명
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="예) 20대 주요 품목별 수출액(억달러) 및 증감률(%)"
            className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleExtract}
            disabled={extracting}
            className="inline-flex h-9 items-center rounded-full bg-slate-900 px-4 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {extracting ? "추출 중…" : "표 추출"}
          </button>
          {extractError ? (
            <span className="text-xs font-medium text-rose-600">{extractError}</span>
          ) : null}
          {extractMessage ? (
            <span className="text-xs font-medium text-amber-600">
              {extractMessage}
            </span>
          ) : null}
        </div>
      </div>

      {/* 2단계: 추출 미리보기 */}
      {result ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <h4 className="text-base font-semibold text-slate-900">
              추출 결과 미리보기
            </h4>
            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
              {result.detectedTitle ? (
                <span className="rounded-full bg-slate-100 px-2 py-1">
                  제목: {result.detectedTitle}
                </span>
              ) : null}
              {result.unit ? (
                <span className="rounded-full bg-slate-100 px-2 py-1">
                  단위: {result.unit}
                </span>
              ) : null}
              <span className="rounded-full bg-slate-100 px-2 py-1">
                {result.rows.length}행 × {result.columns.length}열
              </span>
            </div>
          </div>
          {result.notes ? (
            <p className="mt-2 text-xs text-amber-600">참고: {result.notes}</p>
          ) : null}
          <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-slate-100">
            <table className="min-w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-600">
                <tr>
                  {result.columns.map((col, idx) => (
                    <th key={idx} className="whitespace-nowrap px-3 py-2 font-semibold">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, PREVIEW_LIMIT).map((row, rIdx) => (
                  <tr key={rIdx} className="border-t border-slate-100">
                    {result.columns.map((_, cIdx) => (
                      <td key={cIdx} className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                        {String(row[cIdx] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.rows.length > PREVIEW_LIMIT ? (
            <p className="mt-1 text-xs text-slate-400">
              상위 {PREVIEW_LIMIT}행만 표시됩니다.
            </p>
          ) : null}

          {/* 대화형 보정 */}
          <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                추가 요청으로 결과 다듬기
              </span>
              {!responseId ? (
                <span className="text-[11px] text-amber-600">
                  이 결과는 대화형 수정을 지원하지 않습니다(다시 추출 필요).
                </span>
              ) : null}
            </div>
            {history.length > 0 ? (
              <ol className="mt-2 space-y-1">
                {history.map((item, idx) => (
                  <li key={idx} className="flex gap-2 text-xs text-slate-600">
                    <span className="text-slate-400">
                      {idx === 0 ? "최초" : `요청 ${idx}`}
                    </span>
                    <span className="flex-1">{item}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={refineInstruction}
                onChange={(e) => setRefineInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !refining) handleRefine();
                }}
                disabled={!responseId || refining}
                placeholder="예) 소계·합계 행은 빼줘 / 증감률 말고 수출액만 / 단위를 백만달러로"
                className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-100"
              />
              <button
                type="button"
                onClick={handleRefine}
                disabled={!responseId || refining}
                className="inline-flex h-9 items-center justify-center rounded-full bg-slate-900 px-4 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {refining ? "반영 중…" : "반영"}
              </button>
            </div>
            {refineError ? (
              <p className="mt-1 text-xs font-medium text-rose-600">{refineError}</p>
            ) : null}
            {refineMessage ? (
              <p className="mt-1 text-xs font-medium text-amber-600">
                {refineMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 3단계: 매핑 + 대상 테이블 */}
      {result ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <h4 className="border-b border-slate-100 pb-3 text-base font-semibold text-slate-900">
            테이블 매핑 &amp; 저장 (날짜 · 항목 · 값)
          </h4>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                항목(라벨) 컬럼
              </label>
              <select
                value={labelColIndex}
                onChange={(e) => setLabelColIndex(Number(e.target.value))}
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {result.columns.map((col, idx) => (
                  <option key={idx} value={idx}>
                    {col || `(열 ${idx + 1})`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                기준일자 (날짜 값)
              </label>
              <input
                type="date"
                value={baseDate}
                onChange={(e) => setBaseDate(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-4">
            <span className="block text-xs font-semibold text-slate-700">
              값으로 사용할 컬럼 (복수 선택 시 &lsquo;구분&rsquo; 컬럼으로 펼침)
            </span>
            <div className="mt-2 flex flex-wrap gap-2">
              {result.columns.map((col, idx) => {
                if (idx === labelColIndex) return null;
                const checked = valueColIndices.includes(idx);
                return (
                  <button
                    type="button"
                    key={idx}
                    onClick={() => toggleValueCol(idx)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition ${
                      checked
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {col || `(열 ${idx + 1})`}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 대상 컬럼명 */}
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                날짜 컬럼명
              </label>
              <input
                type="text"
                value={dateColName}
                onChange={(e) => setDateColName(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                항목 컬럼명
              </label>
              <input
                type="text"
                value={itemColName}
                onChange={(e) => setItemColName(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </div>
            {includeMetricCol ? (
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  구분 컬럼명
                </label>
                <input
                  type="text"
                  value={metricColName}
                  onChange={(e) => setMetricColName(e.target.value)}
                  className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </div>
            ) : null}
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                값 컬럼명
              </label>
              <input
                type="text"
                value={valueColName}
                onChange={(e) => setValueColName(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </div>
          </div>

          {/* 대상 스키마/테이블 */}
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                대상 스키마
              </label>
              <input
                type="text"
                list="pdf-target-schemas"
                value={targetSchema}
                onChange={(e) => setTargetSchema(e.target.value)}
                placeholder="public"
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <datalist id="pdf-target-schemas">
                {schemas.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                대상 테이블 (없으면 새 이름 입력)
              </label>
              <input
                type="text"
                list="pdf-target-tables"
                value={targetTable}
                onChange={(e) => setTargetTable(e.target.value)}
                placeholder="예) export_top20_lrd"
                className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <datalist id="pdf-target-tables">
                {tables.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={createIfMissing}
                onChange={(e) => setCreateIfMissing(e.target.checked)}
              />
              테이블 없으면 생성
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={truncate}
                onChange={(e) => setTruncate(e.target.checked)}
              />
              기존 데이터 삭제 후 적재(truncate)
            </label>
          </div>

          {/* 변환 미리보기 */}
          <div className="mt-4">
            <span className="block text-xs font-semibold text-slate-700">
              저장 미리보기 ({meltedRows.length}행)
            </span>
            <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-slate-100">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-600">
                  <tr>
                    {targetColumns.map((col) => (
                      <th key={col.name} className="whitespace-nowrap px-3 py-2 font-semibold">
                        {col.name}
                        <span className="ml-1 text-[10px] text-slate-400">
                          {col.type}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {meltedRows.slice(0, PREVIEW_LIMIT).map((row, rIdx) => (
                    <tr key={rIdx} className="border-t border-slate-100">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                          {String(cell ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleCommit}
              disabled={committing}
              className="inline-flex h-9 items-center rounded-full bg-emerald-600 px-4 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {committing ? "저장 중…" : "테이블에 저장"}
            </button>
            {commitError ? (
              <span className="text-xs font-medium text-rose-600">{commitError}</span>
            ) : null}
            {commitSuccess ? (
              <span className="text-xs font-medium text-emerald-700">
                {commitSuccess}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
