"use client";

import { useEffect, useMemo, useState } from "react";

type SeriesMeta = {
  seriesId: string;
  seriesNameKo: string | null;
  unitName: string | null;
  freqCd: string | null;
  domainLarge: string | null;
  domainSmall: string | null;
  isRepresentative: boolean;
};

type TimeSeriesPoint = {
  ds: string;
  y: number;
};

type ForecastPoint = {
  ds: string;
  yhat: number;
  actual?: number | null;
  yhatLower: number | null;
  yhatUpper: number | null;
};

type RunResult = {
  mode: "ai-forecast-agent";
  question: string;
  interpreted: {
    question: string;
    seriesKeyword: string;
    seriesTokens: string[];
    horizonMonths: number;
    preferredModel: string | null;
  };
  selectedSeries: SeriesMeta & {
    score: number;
    tokenHits: number;
  };
  candidateSeries: Array<
    SeriesMeta & {
      score: number;
      tokenHits: number;
    }
  >;
  autoSelectedModel: string;
  modelSelectionReason: string;
  model: string;
  metrics: { mae: number | null; rmse: number | null; mape: number | null };
  compositeScore: {
    value: number | null;
    grade: "S" | "A" | "B" | "C" | "D" | null;
    sampleCount: number;
    directionAccuracy: number | null;
    note: string | null;
  } | null;
  seriesId: string;
  horizonMonths: number;
  trainCount: number;
  testCount: number;
  trainStart: string | null;
  trainEnd: string | null;
  testStart: string | null;
  testEnd: string | null;
  fallbackReason: string | null;
  history: TimeSeriesPoint[];
  forecast: ForecastPoint[];
  totalElapsedMs: number;
  runNotice?: string | null;
};

type InterpretResult = {
  phase: "interpret";
  assistantMessage: string;
  interpreted: {
    question: string;
    seriesKeyword: string;
    seriesTokens: string[];
    horizonMonths: number;
    preferredModel: string | null;
  };
  defaults: {
    selectedSeriesId: string;
    horizonMonths: number;
    analysisMode: "holdout" | "future";
    modelType: string;
  };
  selectedSeries: SeriesMeta & { score: number; tokenHits: number };
  candidateSeries: Array<SeriesMeta & { score: number; tokenHits: number }>;
  modelSelectionReason: string;
  selectableModels: string[];
  selectableModes: Array<"holdout" | "future">;
  selectableChatProviders?: Array<"rule" | "ollama" | "openai">;
  chatProvider?: "rule" | "ollama" | "openai";
  chatModel?: string | null;
  clarification?: {
    needsSeriesConfirmation: boolean;
    needsModelConfirmation: boolean;
    needsModeConfirmation: boolean;
    needsHorizonConfirmation: boolean;
  };
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatSession = {
  sessionId: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
};

const CHAT_MODEL_OPTIONS: Record<"rule" | "ollama" | "openai", string[]> = {
  rule: [],
  ollama: ["default", "qwen3:8b", "qwen3:4b", "gemma3:4b", "llama3.2:latest", "custom"],
  openai: ["default", "gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "custom"],
};

const formatNum = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value)
    : "-";

const formatMs = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(2)}초` : "-";

export default function AiForecastTest3Page() {
  const [chatInput, setChatInput] = useState("경기심리지수 12개월치 예측해줘");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [interpretation, setInterpretation] = useState<InterpretResult | null>(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState("");
  const [selectedModelType, setSelectedModelType] = useState("");
  const [selectedMode, setSelectedMode] = useState<"holdout" | "future">("holdout");
  const [selectedHorizon, setSelectedHorizon] = useState(12);
  const [chatProvider, setChatProvider] = useState<"rule" | "ollama" | "openai">("rule");
  const [chatModelPreset, setChatModelPreset] = useState("default");
  const [chatModelCustom, setChatModelCustom] = useState("");
  const [userId, setUserId] = useState("demo-user");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);

  const topForecastRows = useMemo(() => result?.forecast.slice(0, 12) ?? [], [result]);

  const latestQuestion = useMemo(() => {
    const users = messages
      .filter((item) => item.role === "user")
      .map((item) => item.content);
    return users[users.length - 1] ?? "";
  }, [messages]);

  const effectiveChatModel = useMemo(() => {
    if (chatProvider === "rule") return undefined;
    if (chatModelPreset === "default") return undefined;
    if (chatModelPreset === "custom") {
      const trimmed = chatModelCustom.trim();
      return trimmed.length ? trimmed : undefined;
    }
    return chatModelPreset;
  }, [chatModelCustom, chatModelPreset, chatProvider]);

  const loadSessions = async (nextUserId: string) => {
    if (!nextUserId.trim()) return;
    try {
      const response = await fetch(
        `/api/ai-forecast-agent/session?userId=${encodeURIComponent(nextUserId)}`
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        sessions?: ChatSession[];
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "세션 조회 실패");
      setSessions(payload.sessions ?? []);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "세션 조회 실패");
    }
  };

  const openSession = async (targetSessionId: string, nextUserId: string) => {
    if (!targetSessionId || !nextUserId.trim()) return;
    setSessionLoading(true);
    try {
      const response = await fetch(
        `/api/ai-forecast-agent/session?userId=${encodeURIComponent(nextUserId)}&sessionId=${encodeURIComponent(targetSessionId)}&withMessages=true`
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        session?: ChatSession;
        messages?: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "세션 불러오기 실패");
      setSessionId(payload.session?.sessionId ?? targetSessionId);
      setMessages(
        (payload.messages ?? [])
          .filter((item) => item.role === "user" || item.role === "assistant")
          .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }))
      );
      setResult(null);
      setInterpretation(null);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "세션 불러오기 실패");
    } finally {
      setSessionLoading(false);
    }
  };

  const createSession = async (nextUserId: string) => {
    if (!nextUserId.trim()) return;
    setSessionLoading(true);
    try {
      const response = await fetch("/api/ai-forecast-agent/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: nextUserId }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        session?: ChatSession;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "세션 생성 실패");
      const sid = payload.session?.sessionId ?? "";
      setSessionId(sid);
      setMessages([]);
      setResult(null);
      setInterpretation(null);
      await loadSessions(nextUserId);
      return sid;
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "세션 생성 실패");
      return "";
    } finally {
      setSessionLoading(false);
    }
  };

  useEffect(() => {
    void (async () => {
      await loadSessions(userId);
      if (!sessionId) {
        const created = await createSession(userId);
        if (created) setSessionId(created);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const interpretQuestion = async (inputText: string) => {
    if (!inputText.trim()) {
      setRunError("질문을 입력해주세요.");
      return;
    }
    if (!sessionId) {
      const created = await createSession(userId);
      if (!created) return;
    }
    const userText = inputText.trim();
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: userText }];
    const assistantIdx = nextMessages.length;
    nextMessages.push({ role: "assistant", content: "" });
    setMessages(nextMessages);
    setRunning(true);
    setRunError("");
    setResult(null);
    try {
      const response = await fetch("/api/ai-forecast-agent/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          sessionId,
          message: userText,
          chatProvider,
          chatModel: effectiveChatModel ?? undefined,
        }),
      });
      if (!response.ok || !response.body) {
        const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error || "스트리밍 대화 호출에 실패했습니다.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const cloned = [...prev];
          if (!cloned[assistantIdx] || cloned[assistantIdx].role !== "assistant") {
            return prev;
          }
          cloned[assistantIdx] = { role: "assistant", content: assistantText };
          return cloned;
        });
      }
      const finalMessages = [
        ...nextMessages.slice(0, assistantIdx),
        { role: "assistant" as const, content: assistantText },
      ];
      try {
        const interpretResponse = await fetch("/api/ai-forecast-agent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "interpret",
            question: userText,
            conversation: finalMessages,
            chatProvider,
            chatModel: effectiveChatModel,
            selectedSeriesId: selectedSeriesId || undefined,
            modelType: selectedModelType || undefined,
            analysisMode: selectedMode,
            horizonMonths: selectedHorizon,
          }),
        });
        const interpretPayload = (await interpretResponse.json()) as
          | ({ ok?: boolean; error?: string } & InterpretResult)
          | { ok?: boolean; error?: string };
        if (interpretResponse.ok && interpretPayload.ok) {
          const interpreted = interpretPayload as InterpretResult;
          setInterpretation(interpreted);
          setSelectedSeriesId(interpreted.defaults.selectedSeriesId);
          setSelectedModelType(interpreted.defaults.modelType);
          setSelectedMode(interpreted.defaults.analysisMode);
          setSelectedHorizon(interpreted.defaults.horizonMonths);
        }
      } catch {
        // 스트리밍 성공 시 확인 단계 동기화 실패는 무시
      }
      await loadSessions(userId);
      setChatInput("");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "질문 처리에 실패했습니다.");
      setMessages((prev) => prev.slice(0, Math.max(0, prev.length - 1)));
    } finally {
      setRunning(false);
    }
  };

  const runAgent = async () => {
    if (!interpretation) {
      setRunError("먼저 질문 해석을 실행해주세요.");
      return;
    }
    setRunning(true);
    setRunError("");
    setResult(null);
    try {
      const response = await fetch("/api/ai-forecast-agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run",
          question: latestQuestion || chatInput,
          conversation: messages,
          selectedSeriesId,
          chatProvider,
          chatModel: effectiveChatModel,
          modelType: selectedModelType,
          analysisMode: selectedMode,
          horizonMonths: selectedHorizon,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string } & RunResult;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "AI 분석 테스트3 실행에 실패했습니다.");
      }
      setResult(payload);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "AI 분석 테스트3 실행에 실패했습니다.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">AI 분석 테스트 3</h2>
        <p className="mt-2 text-sm text-slate-600">
          자연어로 계속 대화하면서 조건을 정하고, 마지막에만 확정 실행하는 화면입니다.
        </p>
      </header>

      <div className="rounded-3xl border border-slate-200 bg-white p-6">
        <h3 className="text-base font-semibold text-slate-900">대화</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr_auto_auto]">
          <label className="text-sm text-slate-700">
            user_id
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-slate-700">
            세션
            <select
              value={sessionId}
              onChange={(e) => void openSession(e.target.value, userId)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
            >
              <option value="">세션 선택</option>
              {sessions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {session.sessionId.slice(0, 8)}... ({new Date(session.lastMessageAt).toLocaleString("ko-KR")})
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void loadSessions(userId)}
            disabled={sessionLoading}
            className="self-end rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"
          >
            세션 목록 새로고침
          </button>
          <button
            onClick={() => void createSession(userId)}
            disabled={sessionLoading}
            className="self-end rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"
          >
            새 세션
          </button>
        </div>
        <div className="mt-3 max-h-64 space-y-2 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
          {messages.length === 0 ? (
            <p className="text-sm text-slate-500">
              예: 경기심리지수 12개월 예측해줘. 이후 모델/모드/기간을 대화로 조정할 수 있습니다.
            </p>
          ) : (
            messages.map((item, idx) => (
              <div
                key={`${item.role}-${idx}`}
                className={`rounded-lg px-3 py-2 text-sm ${
                  item.role === "user" ? "bg-white text-slate-900" : "bg-blue-50 text-blue-900"
                }`}
              >
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide">
                  {item.role === "user" ? "user" : "assistant"}
                </p>
                <p>{item.content}</p>
              </div>
            ))
          )}
        </div>
        <textarea
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          rows={3}
          placeholder="추가 질문/수정사항 입력"
          className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label className="text-sm text-slate-700">
            대화모델 제공자
            <select
              value={chatProvider}
              onChange={(e) => {
                const next = e.target.value as "rule" | "ollama" | "openai";
                setChatProvider(next);
                setChatModelPreset("default");
                setChatModelCustom("");
              }}
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
            >
              <option value="rule">rule(빠름)</option>
              <option value="ollama">ollama</option>
              <option value="openai">openai(gpt)</option>
            </select>
          </label>
          <label className="text-sm text-slate-700">
            대화모델
            <select
              value={chatModelPreset}
              onChange={(e) => setChatModelPreset(e.target.value)}
              disabled={chatProvider === "rule"}
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
            >
              {CHAT_MODEL_OPTIONS[chatProvider].map((item) => (
                <option key={item} value={item}>
                  {item === "default"
                    ? "기본값(환경변수)"
                    : item === "custom"
                      ? "직접입력"
                      : item}
                </option>
              ))}
            </select>
            <input
              value={chatModelCustom}
              onChange={(e) => setChatModelCustom(e.target.value)}
              placeholder={chatProvider === "openai" ? "예: gpt-4o-mini" : "예: qwen3:8b"}
              disabled={chatProvider === "rule" || chatModelPreset !== "custom"}
              className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => void interpretQuestion(chatInput)}
            disabled={running}
            className="rounded-full bg-slate-900 px-5 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {running ? "대화 처리 중..." : "대화 전송"}
          </button>
        </div>
        {runError ? <p className="mt-3 text-sm text-rose-600">{runError}</p> : null}
      </div>

      {interpretation ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6">
          <h3 className="text-base font-semibold text-slate-900">해석/확인 단계</h3>
          <p className="mt-2 text-sm text-slate-700">{interpretation.assistantMessage}</p>
          {interpretation.clarification ? (
            <p className="mt-1 text-xs text-slate-500">
              확인 필요:
              {interpretation.clarification.needsSeriesConfirmation ? " 시계열" : ""}
              {interpretation.clarification.needsModelConfirmation ? " 모델" : ""}
              {interpretation.clarification.needsHorizonConfirmation ? " 기간" : ""}
              {interpretation.clarification.needsModeConfirmation ? " 모드" : ""}
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <label className="text-sm text-slate-700">
              시계열 선택
              <select
                value={selectedSeriesId}
                onChange={(e) => setSelectedSeriesId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
              >
                {interpretation.candidateSeries.map((item) => (
                  <option key={item.seriesId} value={item.seriesId}>
                    {item.seriesNameKo ?? item.seriesId} ({item.seriesId})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-700">
              모델 선택
              <select
                value={selectedModelType}
                onChange={(e) => setSelectedModelType(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
              >
                {interpretation.selectableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-700">
              예측개월
              <input
                type="number"
                min={1}
                max={24}
                value={selectedHorizon}
                onChange={(e) =>
                  setSelectedHorizon(Math.max(1, Math.min(24, Number(e.target.value) || 12)))
                }
                className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
              />
            </label>
            <label className="text-sm text-slate-700">
              모드
              <select
                value={selectedMode}
                onChange={(e) => setSelectedMode(e.target.value as "holdout" | "future")}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"
              >
                {interpretation.selectableModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === "holdout" ? "holdout(평가)" : "future(미래예측 baseline)"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            자동 모델 근거: {interpretation.modelSelectionReason}
          </p>
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => void runAgent()}
              disabled={running}
              className="rounded-full bg-blue-700 px-5 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {running ? "실행 중..." : "최종 확정 후 실행"}
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="space-y-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="text-base font-semibold text-slate-900">자동 해석 결과</h3>
            <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 lg:grid-cols-2">
              <p>
                <span className="font-semibold">질문:</span> {result.question}
              </p>
              <p>
                <span className="font-semibold">키워드:</span> {result.interpreted.seriesKeyword}
              </p>
              <p>
                <span className="font-semibold">예측개월:</span> {result.interpreted.horizonMonths}
              </p>
              <p>
                <span className="font-semibold">질문 내 모델 지정:</span>{" "}
                {result.interpreted.preferredModel ?? "-"}
              </p>
              <p>
                <span className="font-semibold">자동 선택 시계열:</span>{" "}
                {result.selectedSeries.seriesNameKo ?? "-"} ({result.selectedSeries.seriesId})
              </p>
              <p>
                <span className="font-semibold">자동 선택 모델:</span> {result.autoSelectedModel}
              </p>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              모델 선택 근거: {result.modelSelectionReason}
            </p>
            {result.runNotice ? <p className="mt-1 text-xs text-amber-700">{result.runNotice}</p> : null}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="text-base font-semibold text-slate-900">평가 요약</h3>
            <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 lg:grid-cols-2">
              <p>
                MAE: {formatNum(result.metrics.mae)} / RMSE: {formatNum(result.metrics.rmse)} /
                MAPE: {formatNum(result.metrics.mape)}
              </p>
              <p>
                종합점수: {formatNum(result.compositeScore?.value)}{" "}
                {result.compositeScore?.grade ? `(${result.compositeScore.grade})` : ""}
              </p>
              <p>
                방향정확도: {formatNum(result.compositeScore?.directionAccuracy)}% / 표본:{" "}
                {formatNum(result.compositeScore?.sampleCount)}
              </p>
              <p>수행시간: {formatMs(result.totalElapsedMs)}</p>
              <p>
                train: {result.trainCount}건 ({result.trainStart ?? "-"} ~ {result.trainEnd ?? "-"})
              </p>
              <p>
                test: {result.testCount}건 ({result.testStart ?? "-"} ~ {result.testEnd ?? "-"})
              </p>
            </div>
            {result.fallbackReason ? (
              <p className="mt-2 text-xs text-amber-700">fallback: {result.fallbackReason}</p>
            ) : null}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">
              후보 시계열 (자동 검색 Top)
            </h3>
            <div className="max-h-56 overflow-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2 py-2">series_id</th>
                    <th className="px-2 py-2">시리즈명</th>
                    <th className="px-2 py-2">score</th>
                    <th className="px-2 py-2">tokenHits</th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidateSeries.map((item) => (
                    <tr key={item.seriesId} className="border-t border-slate-100">
                      <td className="px-2 py-2">{item.seriesId}</td>
                      <td className="px-2 py-2">{item.seriesNameKo ?? "-"}</td>
                      <td className="px-2 py-2">{formatNum(item.score)}</td>
                      <td className="px-2 py-2">{formatNum(item.tokenHits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="mb-3 text-base font-semibold text-slate-900">예측 결과 (최대 12행)</h3>
            <div className="max-h-72 overflow-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2 py-2">날짜</th>
                    <th className="px-2 py-2">실제값(holdout)</th>
                    <th className="px-2 py-2">예측값</th>
                    <th className="px-2 py-2">오차</th>
                    <th className="px-2 py-2">하한</th>
                    <th className="px-2 py-2">상한</th>
                  </tr>
                </thead>
                <tbody>
                  {topForecastRows.map((item) => (
                    <tr key={item.ds} className="border-t border-slate-100">
                      <td className="px-2 py-2">{item.ds}</td>
                      <td className="px-2 py-2">{formatNum(item.actual)}</td>
                      <td className="px-2 py-2">{formatNum(item.yhat)}</td>
                      <td className="px-2 py-2">
                        {item.actual == null ? "-" : formatNum(item.yhat - item.actual)}
                      </td>
                      <td className="px-2 py-2">{formatNum(item.yhatLower)}</td>
                      <td className="px-2 py-2">{formatNum(item.yhatUpper)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
