// 실행 중인 작업의 DB 백엔드 PID 와 AbortController 를 추적해
// 실제 취소(pg_cancel_backend + abort)를 지원하는 인메모리 레지스트리.
// (_shared 폴더는 '_' 접두라 라우트로 노출되지 않음)
export type RunProgress = {
  phase: "collect" | "map" | "transform";
  label: string;
  index?: number;
  total?: number;
};
export type RunHandle = { pids: Set<number>; abort: AbortController; progress: RunProgress | null };

// 라우트 간(실행/취소/진행) 공유를 보장하기 위해 globalThis 싱글톤 사용.
// (Next/Turbopack 에서 모듈 단위 상태가 라우트별로 분리될 수 있음 — 스케줄러들과 동일한 패턴)
const getRegistry = (): Map<string, RunHandle> => {
  const g = globalThis as typeof globalThis & {
    __runCancelRegistry?: Map<string, RunHandle>;
  };
  if (!g.__runCancelRegistry) g.__runCancelRegistry = new Map<string, RunHandle>();
  return g.__runCancelRegistry;
};

export const beginRun = (key: string): RunHandle => {
  const handle: RunHandle = { pids: new Set<number>(), abort: new AbortController(), progress: null };
  getRegistry().set(key, handle);
  return handle;
};

export const setRunProgress = (key: string, progress: RunProgress) => {
  const handle = getRegistry().get(key);
  if (handle) handle.progress = progress;
};

export const getRunProgress = (key: string): RunProgress | null =>
  getRegistry().get(key)?.progress ?? null;

export const addRunPid = (key: string, pid: unknown) => {
  const handle = getRegistry().get(key);
  const n = typeof pid === "string" ? Number(pid) : (pid as number);
  if (handle && Number.isFinite(n) && n > 0) handle.pids.add(Math.trunc(n));
};

export const getRun = (key: string): RunHandle | undefined => getRegistry().get(key);

export const endRun = (key: string) => {
  getRegistry().delete(key);
};
