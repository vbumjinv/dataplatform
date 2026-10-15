"use client";

import { useEffect, useRef, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };
type PendingAction = {
  token: string;
  type: string;
  summary: string;
  workerId?: string;
};
type NextAction = {
  id: string;
  label: string;
  prompt: string;
  kind: "read" | "configure" | "execute";
};
type Plan = {
  intent: string;
  summary: string;
  steps: Array<{ id: string; workerId: string; goal: string; status: string }>;
};
type CollectionWorkflow = {
  workflowId: string;
  stage: string;
  status: string;
  revision: number;
  state: {
    sourceName?: string;
    apiName?: string;
    startDate?: string;
    endDate?: string;
    target?: { schema: string; table: string };
    lastError?: string;
  };
};

const SESSION_KEY = "ai-orchestrator-session-id";
const INGESTION_DB_SETTING_STORAGE_KEY = "ingestion-selected-db-setting-id";
const collectionStages = [
  ["select_api", "API 선택"],
  ["collect_required_input", "필수값 입력"],
  ["preview_draft", "등록 전 샘플"],
  ["register_api", "API 등록"],
  ["configure_table", "테이블 설정"],
  ["create_or_bind_table", "테이블 연결"],
  ["run_ingestion", "적재"],
  ["completed", "완료"],
] as const;

const examples = [
  "등록된 수집 소스 목록 보여줘",
  "한국은행 기준금리 수집 준비해줘",
  "최근 적재 테이블을 매핑으로 만들어줘",
  "매핑된 시계열을 전년동월대비 증감률로 가공해줘",
];

const loadingLabel = (elapsedSeconds: number) => {
  if (elapsedSeconds >= 20) {
    return "도구 호출 또는 AI 응답이 길어지고 있습니다. 아직 처리 중입니다.";
  }
  if (elapsedSeconds >= 8) {
    return "등록 정보와 도구 응답을 확인하는 중입니다.";
  }
  return "AI가 응답을 준비하고 있습니다.";
};

const getStoredSessionId = () => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
};

export default function AiAssistantPage() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [collectionWorkflow, setCollectionWorkflow] =
    useState<CollectionWorkflow | null>(null);
  const [nextActions, setNextActions] = useState<NextAction[]>([]);
  const [dbSettingId, setDbSettingId] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredSessionRef = useRef("");

  useEffect(() => {
    setSessionId(getStoredSessionId());
    try {
      setDbSettingId(
        window.localStorage.getItem(INGESTION_DB_SETTING_STORAGE_KEY) ?? "",
      );
    } catch {
      setDbSettingId("");
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending, loading, loadingSeconds]);

  useEffect(() => {
    if (!loading) {
      setLoadingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (!sessionId || restoredSessionRef.current === sessionId) return;
    restoredSessionRef.current = sessionId;
    const controller = new AbortController();
    void fetch(
      `/api/ai-orchestrator/session?sessionId=${encodeURIComponent(sessionId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error);
        setMessages(
          (data.messages ?? [])
            .filter(
              (message: { role?: string }) =>
                message.role === "user" || message.role === "assistant",
            )
            .map((message: { role: "user" | "assistant"; content?: string }) => ({
              role: message.role,
              content: String(message.content ?? ""),
            })),
        );
        setPending((data.pendingAction as PendingAction | null) ?? null);
        setNextActions((data.nextActions as NextAction[] | null) ?? []);
        setCollectionWorkflow(
          (data.collectionWorkflow as CollectionWorkflow | null) ?? null,
        );
      })
      .catch((restoreError) => {
        if (restoreError instanceof DOMException && restoreError.name === "AbortError") {
          return;
        }
        setError(
          restoreError instanceof Error
            ? restoreError.message
            : "세션 복원에 실패했습니다.",
        );
      });
    return () => controller.abort();
  }, [sessionId]);

  const rememberSession = (nextSessionId: string) => {
    setSessionId(nextSessionId);
    try {
      window.localStorage.setItem(SESSION_KEY, nextSessionId);
    } catch {
      // ignore
    }
  };

  const reset = () => {
    setSessionId("");
    setMessages([]);
    setPending(null);
    setPlan(null);
    setCollectionWorkflow(null);
    setNextActions([]);
    restoredSessionRef.current = "";
    setError(null);
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setInput("");
    setError(null);
    setPending(null);
    setNextActions([]);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setLoading(true);
    try {
      const response = await fetch("/api/ai-orchestrator/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId || undefined,
          message: trimmed,
          dbSettingId: dbSettingId || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setError(data.error ?? "요청 처리에 실패했습니다.");
        return;
      }
      if (data.sessionId) rememberSession(data.sessionId);
      if (data.plan) setPlan(data.plan as Plan);
      setNextActions((data.nextActions as NextAction[] | null) ?? []);
      if (data.collectionWorkflow) {
        setCollectionWorkflow(data.collectionWorkflow as CollectionWorkflow);
      }

      if (data.mode === "proposal" && data.pendingAction) {
        const nextPending = data.pendingAction as PendingAction;
        setPending(nextPending);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: nextPending.summary },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.text ?? "응답을 생성하지 못했습니다." },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "요청 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const decide = async (decision: "confirm" | "cancel") => {
    if (!pending || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/ai-orchestrator/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          token: pending.token,
          decision,
          dbSettingId: dbSettingId || undefined,
        }),
      });
      const data = await response.json();
      setPending(null);
      setNextActions((data.nextActions as NextAction[] | null) ?? []);
      if (data.collectionWorkflow) {
        setCollectionWorkflow(data.collectionWorkflow as CollectionWorkflow);
      }
      if (!response.ok || !data.ok) {
        setError(data.error ?? "확인 처리에 실패했습니다.");
        return;
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.message ?? data.confirmResponse?.message ?? "처리 완료" },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "확인 처리 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const activeStageIndex = collectionWorkflow
    ? collectionStages.findIndex(([stage]) => stage === collectionWorkflow.stage)
    : -1;

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col bg-slate-50 p-6 text-slate-900">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4">
        <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-600">
                AI Orchestrator
              </p>
              <h1 className="mt-2 text-2xl font-bold">AI 통합 어시스턴트</h1>
              <p className="mt-2 text-sm text-slate-600">
                1차 범위: 데이터 수집 + 전처리(매핑·가공). 예측·시각화 AI 연동은 아직 제외합니다.
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              disabled={loading}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60"
            >
              새 대화
            </button>
          </div>
          {plan ? (
            <div className="mt-4 rounded-xl bg-slate-100 p-3 text-sm text-slate-700">
              <div className="font-semibold">Plan: {plan.intent}</div>
              <div>{plan.summary}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {plan.steps.map((step) => (
                  <span key={step.id} className="rounded-full bg-white px-2.5 py-1 text-xs">
                    {step.workerId} · {step.status}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </header>

        <section className="grid gap-4 lg:grid-cols-[1fr_280px]">
          <div className="flex min-h-[540px] flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                  수집 또는 전처리 요청을 입력해 주세요. 실행이 필요한 작업은 승인 카드가 먼저 표시됩니다.
                </div>
              ) : null}
              {messages.map((msg, index) => (
                <div
                  key={`${msg.role}-${index}`}
                  className={`rounded-2xl px-4 py-3 text-sm ${
                    msg.role === "user"
                      ? "ml-auto max-w-[80%] bg-slate-900 text-white"
                      : "mr-auto max-w-[85%] bg-slate-100 text-slate-800"
                  }`}
                >
                  <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                </div>
              ))}
              {loading ? (
                <div className="mr-auto max-w-[85%] rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-800">
                  <div className="flex items-center gap-3">
                    <span className="relative flex h-4 w-4">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex h-4 w-4 rounded-full bg-amber-500" />
                    </span>
                    <div>
                      <p className="font-medium">{loadingLabel(loadingSeconds)}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {loadingSeconds > 0 ? `${loadingSeconds}초 경과` : "요청 전송 중"}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {pending ? (
              <div className="border-t border-amber-200 bg-amber-50 p-4">
                <div className="text-sm font-semibold text-amber-900">
                  확인 필요 · {pending.workerId ?? "worker"}
                </div>
                <p className="mt-1 text-sm text-amber-900">{pending.summary}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => decide("confirm")}
                    disabled={loading}
                    className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
                  >
                    확인 실행
                  </button>
                  <button
                    type="button"
                    onClick={() => decide("cancel")}
                    disabled={loading}
                    className="rounded-lg border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : null}

            {nextActions.length > 0 && !pending ? (
              <div className="border-t border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-800">
                  다음 단계 선택
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {nextActions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => void send(action.prompt)}
                      disabled={loading}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-60"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <form
              className="flex gap-2 border-t border-slate-200 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={loading}
                placeholder="예: 한국은행 기준금리 수집해서 매핑까지 준비해줘"
                className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-amber-500"
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                전송
              </button>
            </form>
          </div>

          <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            {collectionWorkflow ? (
              <div className="mb-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">수집 진행 상태</h2>
                  <span className="text-xs text-slate-500">
                    rev.{collectionWorkflow.revision}
                  </span>
                </div>
                <div className="mt-3 space-y-1.5">
                  {collectionStages.map(([stage, label], index) => {
                    const completed =
                      collectionWorkflow.status === "completed" ||
                      (activeStageIndex >= 0 && index < activeStageIndex);
                    const active = index === activeStageIndex;
                    return (
                      <div
                        key={stage}
                        className={`rounded-lg px-2.5 py-2 text-xs ${
                          active
                            ? "bg-amber-100 font-semibold text-amber-900"
                            : completed
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-50 text-slate-400"
                        }`}
                      >
                        {completed ? "완료 · " : active ? "진행 · " : ""}
                        {label}
                      </div>
                    );
                  })}
                </div>
                {collectionWorkflow.state.apiName ||
                collectionWorkflow.state.sourceName ? (
                  <p className="mt-3 text-xs text-slate-600">
                    {collectionWorkflow.state.sourceName}
                    {collectionWorkflow.state.apiName
                      ? ` · ${collectionWorkflow.state.apiName}`
                      : ""}
                  </p>
                ) : null}
                {collectionWorkflow.state.lastError ? (
                  <div className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">
                    {collectionWorkflow.state.lastError}
                  </div>
                ) : null}
              </div>
            ) : null}
            <h2 className="text-sm font-semibold">예시</h2>
            <div className="mt-3 space-y-2">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => void send(example)}
                  disabled={loading}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
              세션: {sessionId || "새 대화"}
              <br />
              DB 설정: {dbSettingId || "기본값"}
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
