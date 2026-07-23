// Python 가공(Transform) 서비스 호출 클라이언트.
// python-forecast-api(/transform) 에 시계열과 사용자 코드를 보내 변환 결과를 받는다.
// (forecast 호출부와 동일한 fetch+timeout 패턴)

export type SeriesPoint = { ds: string; y: number };

const PY_TRANSFORM_API_URL =
  process.env.PY_TRANSFORM_API_URL ?? "http://127.0.0.1:8001/transform";
const PY_TRANSFORM_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.PY_TRANSFORM_TIMEOUT_MS ?? 60000) || 60000,
);

const isAbortLikeError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted|timeout/i.test(error.message);
};

const parseJsonSafe = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

// 사용자 Python 코드를 실행해 변환된 시계열을 반환한다.
export const runPythonTransform = async (
  code: string,
  data: SeriesPoint[],
  data2?: SeriesPoint[] | null,
): Promise<SeriesPoint[]> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PY_TRANSFORM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(PY_TRANSFORM_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, data, data2: data2 && data2.length > 0 ? data2 : undefined }),
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new Error(
        `Python 가공 API 응답 시간 초과(${Math.round(PY_TRANSFORM_TIMEOUT_MS / 1000)}초). python-forecast-api(8001)가 기동 중인지 확인하세요.`,
      );
    }
    throw new Error(
      `Python 가공 API 호출 실패: ${error instanceof Error ? error.message : String(error)}. python-forecast-api(8001)가 기동 중인지 확인하세요.`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const rawBody = await response.text();
  const parsed = parseJsonSafe(rawBody) as
    | { result?: Array<{ ds?: unknown; y?: unknown }>; detail?: unknown }
    | null;
  if (!response.ok) {
    const detail =
      typeof parsed?.detail === "string"
        ? parsed.detail
        : parsed?.detail
          ? JSON.stringify(parsed.detail)
          : rawBody;
    throw new Error(detail || "Python 가공 실행에 실패했습니다.");
  }
  if (!parsed || !Array.isArray(parsed.result)) {
    throw new Error("Python 가공 API 응답 형식이 올바르지 않습니다.");
  }
  return parsed.result
    .map((row) => ({ ds: String(row.ds ?? ""), y: Number(row.y) }))
    .filter((row) => row.ds.length > 0 && Number.isFinite(row.y));
};
