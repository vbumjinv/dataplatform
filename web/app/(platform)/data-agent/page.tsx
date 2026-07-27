"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };
type Pending = {
  token: string;
  type: string;
  summary: string;
  args: Record<string, unknown>;
};

const EXAMPLES = [
  "등록된 수집 소스 목록 보여줘",
  "통계청에서 소비자물가지수는 어떤 코드야?",
  "매핑 목록 알려줘",
];

export default function DataAgentPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [provider, setProvider] = useState<"openai" | "ollama">("openai");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading, pending]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setError(null);
    setInput("");
    setPending(null);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setLoading(true);
    try {
      const res = await fetch("/api/data-agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId || undefined,
          message: trimmed,
          chatProvider: provider,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "요청에 실패했습니다.");
        setLoading(false);
        return;
      }
      if (data.sessionId) setSessionId(data.sessionId);
      if (data.mode === "proposal" && data.pendingAction) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.pendingAction.summary },
        ]);
        setPending(data.pendingAction as Pending);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: data.text ?? "" }]);
      }
    } catch {
      setError("서버 통신 중 오류가 발생했습니다.");
    }
    setLoading(false);
  };

  const decide = async (decision: "confirm" | "cancel") => {
    if (!pending || loading) return;
    const token = pending.token;
    setPending(null);
    setLoading(true);
    try {
      const res = await fetch("/api/data-agent/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, token, decision }),
      });
      const data = await res.json();
      const text =
        decision === "cancel"
          ? "요청을 취소했습니다."
          : data.message ?? (data.ok ? "실행을 완료했습니다." : data.error ?? "실행에 실패했습니다.");
      setMessages((prev) => [...prev, { role: "assistant", content: text }]);
    } catch {
      setError("서버 통신 중 오류가 발생했습니다.");
    }
    setLoading(false);
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">AI 데이터 에이전트</h2>
          <p className="text-xs text-slate-500">
            자연어로 데이터 수집·매핑을 조회하고, 실행은 확인 후 진행합니다. (v1: 수집 + 매핑)
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          엔진
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as "openai" | "ollama")}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="openai">OpenAI (실행 가능)</option>
            <option value="ollama">Ollama (조회 전용)</option>
          </select>
        </label>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4"
      >
        {messages.length === 0 ? (
          <div className="space-y-3 text-sm text-slate-500">
            <p>무엇을 도와드릴까요? 예시를 눌러 시작할 수 있어요.</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  m.role === "user"
                    ? "max-w-[80%] whitespace-pre-wrap rounded-2xl bg-slate-900 px-3 py-2 text-sm text-white"
                    : "max-w-[80%] whitespace-pre-wrap rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-800"
                }
              >
                {m.content}
              </div>
            </div>
          ))
        )}

        {pending ? (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-800">실행 확인 필요</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-amber-900">{pending.summary}</p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => decide("confirm")}
                disabled={loading}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
              >
                확인 실행
              </button>
              <button
                onClick={() => decide("cancel")}
                disabled={loading}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white disabled:opacity-60"
              >
                취소
              </button>
            </div>
          </div>
        ) : null}

        {loading ? <p className="text-xs text-slate-400">처리 중…</p> : null}
      </div>

      {error ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="예: 통계청 소비자물가지수 수집 설정 보여줘"
          className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          보내기
        </button>
      </form>
    </div>
  );
}
