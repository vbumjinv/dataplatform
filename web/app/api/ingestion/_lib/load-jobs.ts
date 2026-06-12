type IngestionLoadJob = {
  id: string;
  startedAt: number;
  abortController: AbortController;
  dbBackendPid: number | null;
};

type GlobalWithLoadJobs = typeof globalThis & {
  __INGESTION_LOAD_JOBS__?: Map<string, IngestionLoadJob>;
};

const globalWithJobs = globalThis as GlobalWithLoadJobs;

const jobStore =
  globalWithJobs.__INGESTION_LOAD_JOBS__ ??
  new Map<string, IngestionLoadJob>();

if (!globalWithJobs.__INGESTION_LOAD_JOBS__) {
  globalWithJobs.__INGESTION_LOAD_JOBS__ = jobStore;
}

const createTaskId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const registerLoadJob = (taskId?: string) => {
  const id = (taskId ?? "").trim() || createTaskId();
  const job: IngestionLoadJob = {
    id,
    startedAt: Date.now(),
    abortController: new AbortController(),
    dbBackendPid: null,
  };
  jobStore.set(id, job);
  return job;
};

export const setLoadJobBackendPid = (taskId: string, pid: number) => {
  const job = jobStore.get(taskId);
  if (!job) return false;
  job.dbBackendPid = Number.isFinite(pid) ? pid : null;
  return true;
};

export const getLoadJob = (taskId: string) => {
  const id = (taskId ?? "").trim();
  if (!id) return null;
  return jobStore.get(id) ?? null;
};

export const removeLoadJob = (taskId: string) => {
  const id = (taskId ?? "").trim();
  if (!id) return false;
  return jobStore.delete(id);
};

