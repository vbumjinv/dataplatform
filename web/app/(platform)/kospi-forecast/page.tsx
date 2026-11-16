"use client";

import { useCallback, useEffect, useState } from "react";
import { cutoffOf, formatStamp, suggestedPoint, suggestedTargets, type TimeKey as ForecastTimeKey } from "./forecast-dates";

const DB_SETTING_STORAGE_KEY = "ingestion-selected-db-setting-id";

type DbSetting = {
  id: number;
  settingName: string;
};

type TimeKey = ForecastTimeKey;

type PointSchedule = {
  timePoint: TimeKey;
  enabled: boolean;
  time: string;
  llm: boolean;
  dbSettingId: number | null;
  lastRunAt?: string;
  lastStatus?: "success" | "failure" | "running";
  lastError?: string;
};

type RunLog = {
  id: string;
  timePoint: TimeKey;
  trigger: "manual" | "schedule";
  target: string;
  llm: boolean;
  status: "success" | "failure";
  startedAt: string;
  finishedAt: string;
  output: string;
};

const PREDICTION_TIMES = [
  {
    key: "T0" as const,
    label: "코스피 장 마감",
    detail: "직전 거래일 16:00까지 확정된 자료",
    accent: "from-sky-500 to-blue-600",
  },
  {
    key: "T1" as const,
    label: "유럽 장 마감",
    detail: "예측 당일 02:00까지 확정된 자료",
    accent: "from-violet-500 to-indigo-600",
  },
  {
    key: "T2" as const,
    label: "미국 장 마감",
    detail: "예측 당일 08:30까지 확정된 자료",
    accent: "from-amber-500 to-orange-600",
  },
];

const formatRunAt = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
};

const initialDates = () => {
  const snap = suggestedTargets();
  return {
    suggested: snap,
    targets: { T0: snap.T0.target, T1: snap.T1.target, T2: snap.T2.target },
  };
};

export default function KospiForecastPage() {
  const [dateState, setDateState] = useState(initialDates);
  const [dbSettings, setDbSettings] = useState<DbSetting[]>([]);
  const [dbSettingId, setDbSettingId] = useState("");
  const [dbSettingsError, setDbSettingsError] = useState("");
  const [schedules, setSchedules] = useState<PointSchedule[]>([
    { timePoint: "T0", enabled: false, time: "16:00", llm: false, dbSettingId: null },
    { timePoint: "T1", enabled: false, time: "02:00", llm: false, dbSettingId: null },
    { timePoint: "T2", enabled: false, time: "08:30", llm: false, dbSettingId: null },
  ]);
  const [runningKey, setRunningKey] = useState<TimeKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<TimeKey, string>>>({});
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [logError, setLogError] = useState("");
  const [logFilter, setLogFilter] = useState<TimeKey | "ALL">("ALL");
  const [pythonStatus, setPythonStatus] = useState("");
  const [selectedLogId, setSelectedLogId] = useState("");

  const fetchDbSettings = useCallback(async () => {
    setDbSettingsError("");
    try {
      const response = await fetch("/api/db/settings", { cache: "no-store" });
      const payload = (await response.json()) as { ok?: boolean; settings?: DbSetting[]; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "DB 설정 목록을 불러오지 못했습니다.");
      const options = (payload.settings ?? []).filter(
        (item) => Number.isFinite(item.id) && item.id > 0 && typeof item.settingName === "string",
      );
      setDbSettings(options);
      if (options.length === 0) {
        setDbSettingId("");
        setDbSettingsError("DB 설정이 없습니다. 먼저 DB 설정에서 등록하세요.");
        return;
      }
      setDbSettingId((prev) => {
        const saved = window.localStorage.getItem(DB_SETTING_STORAGE_KEY);
        if (saved && options.some((item) => String(item.id) === saved)) return saved;
        if (prev && options.some((item) => String(item.id) === prev)) return prev;
        return String(options[0].id);
      });
    } catch (loadError) {
      setDbSettings([]);
      setDbSettingId("");
      setDbSettingsError(loadError instanceof Error ? loadError.message : "DB 설정 목록을 불러오지 못했습니다.");
    }
  }, []);

  const fetchLogs = useCallback(async (selectLatest = false) => {
    if (!dbSettingId) return;
    const response = await fetch(`/api/kospi-forecast/logs?dbSettingId=${dbSettingId}`, { cache: "no-store" });
    const payload = (await response.json()) as { ok?: boolean; logs?: RunLog[]; error?: string };
    if (!response.ok || !payload.ok) {
      setLogError(payload.error || "수행 로그를 불러오지 못했습니다.");
      return;
    }
    setLogError("");
    const next = payload.logs ?? [];
    setLogs(next);
    setSelectedLogId((prev) =>
      selectLatest || !prev || !next.some((item) => item.id === prev) ? next[0]?.id ?? "" : prev,
    );
  }, [dbSettingId]);

  const fetchPythonStatus = useCallback(async () => {
    const response = await fetch("/api/kospi-forecast/python", { cache: "no-store" });
    const payload = (await response.json()) as {
      executable?: string;
      command?: string;
      venv?: boolean;
      exchangeCalendars?: boolean;
      error?: string;
    };
    if (!response.ok || payload.error) {
      setPythonStatus(payload.error || "예측 파이썬을 확인하지 못했습니다.");
      return;
    }
    const where = payload.venv ? "가상환경" : "시스템 파이썬";
    const calendar = payload.exchangeCalendars ? "exchange_calendars 있음" : "exchange_calendars 없음";
    setPythonStatus(`${where} · ${payload.executable || payload.command || ""} · ${calendar}`);
  }, []);

  const fetchSchedules = useCallback(async () => {
    const response = await fetch("/api/kospi-forecast/schedule", { cache: "no-store" });
    const payload = (await response.json()) as { ok?: boolean; points?: PointSchedule[]; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "스케줄을 불러오지 못했습니다.");
    setSchedules(payload.points ?? []);
  }, []);

  useEffect(() => {
    void fetchDbSettings();
    void fetchPythonStatus();
    void fetchSchedules().catch((error: unknown) => {
      setDbSettingsError(error instanceof Error ? error.message : "스케줄을 불러오지 못했습니다.");
    });
  }, [fetchDbSettings, fetchPythonStatus, fetchSchedules]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!dbSettingId) return;
    window.localStorage.setItem(DB_SETTING_STORAGE_KEY, dbSettingId);
  }, [dbSettingId]);

  const visibleLogs = logs.filter((log) => logFilter === "ALL" || log.timePoint === logFilter);
  const selectedLog = visibleLogs.find((log) => log.id === selectedLogId) ?? visibleLogs[0];

  const scheduleOf = (key: TimeKey) =>
    schedules.find((item) => item.timePoint === key) ?? {
      timePoint: key,
      enabled: false,
      time: key === "T0" ? "16:00" : key === "T1" ? "02:00" : "08:30",
      llm: false,
      dbSettingId: null,
    };

  const saveSchedule = async (key: TimeKey, patch: Partial<PointSchedule>) => {
    const current = scheduleOf(key);
    const next = { ...current, ...patch };
    const response = await fetch("/api/kospi-forecast/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timePoint: key,
        enabled: next.enabled,
        time: next.time,
        llm: next.llm,
        dbSettingId: Number(dbSettingId),
      }),
    });
    const payload = (await response.json()) as { ok?: boolean; points?: PointSchedule[]; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "스케줄을 저장하지 못했습니다.");
    setSchedules(payload.points ?? []);
  };

  const refreshTargets = () => {
    setDateState(initialDates());
    void fetchLogs();
    void fetchPythonStatus();
    void fetchSchedules().catch((error: unknown) => {
      setDbSettingsError(error instanceof Error ? error.message : "스케줄을 불러오지 못했습니다.");
    });
  };

  const runForecast = async (key: TimeKey, llm: boolean) => {
    const date = dateState.targets[key];
    const followClock = date === suggestedPoint(key).target;
    setRunningKey(key);
    setErrors((prev) => ({ ...prev, [key]: "" }));
    try {
      const response = await fetch("/api/kospi-forecast/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: date,
          autoTarget: followClock,
          timePoint: key,
          dbSettingId: Number(dbSettingId),
          llm,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; output?: string; logError?: string | null };
      if (payload.logError) setLogError(payload.logError);
      if (!response.ok || !payload.ok) throw new Error(payload.error || "예측 실행에 실패했습니다.");
      await fetchLogs(true);
    } catch (runError) {
      setErrors((prev) => ({
        ...prev,
        [key]: runError instanceof Error ? runError.message : "예측 실행에 실패했습니다.",
      }));
      await fetchLogs(true);
    } finally {
      setRunningKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-400">KOSPI</p>
            <h2 className="mt-1 text-2xl font-semibold text-slate-900">코스피 예측</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
              세 시점을 각각 실행합니다. 대상일은 시점마다 현재 시각과 비교해 정하고, 그 시각이 지나면 다음 거래일로 넘어갑니다.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-xs font-semibold text-slate-600">DB 연결</span>
            <select
              value={dbSettingId}
              onChange={(event) => setDbSettingId(event.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none"
              disabled={dbSettings.length === 0}
            >
              {dbSettings.length === 0 ? <option value="">설정 없음</option> : null}
              {dbSettings.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.settingName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {dbSettingsError ? <p className="mt-3 text-xs text-rose-600">{dbSettingsError}</p> : null}
        {pythonStatus ? <p className="mt-3 text-xs text-slate-500">예측 실행: {pythonStatus}</p> : null}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">화면을 연 뒤 시각이 지나면 새로고침으로 세 대상일을 현재 시각에 맞춥니다.</p>
          <button
            type="button"
            onClick={refreshTargets}
            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            새로고침
          </button>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {PREDICTION_TIMES.map((item) => {
          const date = dateState.targets[item.key];
          const suggestion = dateState.suggested[item.key];
          const at = date === suggestion.target ? suggestion.at : cutoffOf(item.key, date);
          const enabled = Boolean(at) && Date.now() >= new Date(at).getTime();
          const schedule = scheduleOf(item.key);
          const running = runningKey === item.key;
          const blocked = runningKey !== null && !running;
          const error = errors[item.key];
          const lastLabel =
            schedule.lastStatus === "success"
              ? "마지막 자동 실행 성공"
              : schedule.lastStatus === "failure"
                ? "마지막 자동 실행 실패"
                : schedule.lastStatus === "running"
                  ? "자동 실행 중"
                  : "";
          return (
            <article key={item.key} className="flex flex-col rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className={`h-1.5 rounded-full bg-gradient-to-r ${item.accent}`} />
              <div className="mt-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">{item.key}</span>
                    <h3 className="text-base font-semibold text-slate-900">{item.label}</h3>
                  </div>
                  <p className="mt-2 text-sm text-slate-500">{item.detail}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                    enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {enabled ? "실행 가능" : "시각 전"}
                </span>
              </div>
              <label className="mt-4 block space-y-1 text-xs font-semibold text-slate-600">
                대상일
                <input
                  type="date"
                  value={date}
                  onChange={(event) =>
                    setDateState((prev) => ({
                      ...prev,
                      targets: { ...prev.targets, [item.key]: event.target.value },
                    }))
                  }
                  className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800"
                />
              </label>
              <p className="mt-2 text-xs text-slate-400">기준 시각 {formatStamp(at) || "날짜를 확인하세요"}</p>

              <button
                type="button"
                onClick={() => void runForecast(item.key, schedule.llm)}
                disabled={running || blocked || !enabled || !dbSettingId}
                className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-2xl bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? "예측 실행 중…" : `${item.key} 실행`}
              </button>

              <div className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-3">
                <label className="flex items-center justify-between gap-3 text-sm text-slate-700">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={schedule.llm}
                      onChange={(event) => {
                        const llm = event.target.checked;
                        setSchedules((prev) => prev.map((row) => (row.timePoint === item.key ? { ...row, llm } : row)));
                        void saveSchedule(item.key, { llm, enabled: schedule.enabled, time: schedule.time }).catch(
                          (saveError: unknown) => {
                            setErrors((prev) => ({
                              ...prev,
                              [item.key]: saveError instanceof Error ? saveError.message : "LLM 설정을 저장하지 못했습니다.",
                            }));
                          },
                        );
                      }}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    LLM 해설
                  </span>
                  <span className="text-xs font-normal text-slate-400">유료 · 이 시점만</span>
                </label>
                <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-3">
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={schedule.enabled}
                      onChange={(event) => {
                        void saveSchedule(item.key, { enabled: event.target.checked }).catch((saveError: unknown) => {
                          setErrors((prev) => ({
                            ...prev,
                            [item.key]: saveError instanceof Error ? saveError.message : "스케줄을 저장하지 못했습니다.",
                          }));
                        });
                      }}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    매일 자동 실행
                  </label>
                  <input
                    type="time"
                    value={schedule.time}
                    onChange={(event) => {
                      const time = event.target.value;
                      setSchedules((prev) =>
                        prev.map((row) => (row.timePoint === item.key ? { ...row, time } : row)),
                      );
                    }}
                    onBlur={(event) => {
                      void saveSchedule(item.key, { time: event.target.value, enabled: schedule.enabled }).catch(
                        (saveError: unknown) => {
                          setErrors((prev) => ({
                            ...prev,
                            [item.key]: saveError instanceof Error ? saveError.message : "스케줄을 저장하지 못했습니다.",
                          }));
                        },
                      );
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                  />
                </div>
                {lastLabel ? (
                  <p className={`mt-2 text-xs ${schedule.lastStatus === "failure" ? "text-rose-600" : "text-slate-500"}`}>
                    {lastLabel}
                    {formatRunAt(schedule.lastRunAt) ? ` · ${formatRunAt(schedule.lastRunAt)}` : ""}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-slate-400">켜 두면 이 시각에 최근 대상일을 예측합니다. DB 연결과 LLM 선택도 함께 저장됩니다.</p>
                )}
                {schedule.lastStatus === "failure" && schedule.lastError ? (
                  <p className="mt-1 line-clamp-3 text-xs text-rose-600">{schedule.lastError}</p>
                ) : null}
              </div>

              {error ? <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-xs text-rose-600">{error}</p> : null}
            </article>
          );
        })}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">수행 로그</h3>
            <p className="mt-1 text-sm text-slate-500">수동 실행과 매일 자동 실행이 선택한 DB에 시간순으로 남습니다.</p>
          </div>
          <div className="flex items-center gap-2">
            {(["ALL", "T0", "T1", "T2"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setLogFilter(key)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  logFilter === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {key === "ALL" ? "전체" : key}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void fetchLogs()}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              새로고침
            </button>
          </div>
        </div>
        {logError ? <p className="mt-4 text-sm text-rose-600">{logError}</p> : null}
        {visibleLogs.length === 0 ? (
          <p className="mt-6 text-sm text-slate-400">아직 수행 로그가 없습니다.</p>
        ) : (
          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="max-h-[28rem] space-y-2 overflow-auto pr-1">
              {visibleLogs.map((log) => (
                <button
                  key={log.id}
                  type="button"
                  onClick={() => setSelectedLogId(log.id)}
                  className={`block w-full rounded-2xl border px-3 py-3 text-left ${
                    log.id === selectedLog?.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {log.timePoint} · {log.trigger === "schedule" ? "자동" : "수동"}
                    </span>
                    <span className={`text-xs font-semibold ${log.status === "success" ? "text-emerald-700" : "text-rose-600"}`}>
                      {log.status === "success" ? "성공" : "실패"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatRunAt(log.startedAt)}
                    {log.target ? ` · 대상일 ${log.target}` : ""}
                    {log.llm ? " · LLM" : ""}
                  </p>
                </button>
              ))}
            </div>
            <pre className="max-h-[28rem] overflow-auto rounded-2xl bg-slate-950 p-4 text-xs leading-5 text-slate-100">
              {selectedLog?.output || "로그를 선택하세요."}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
