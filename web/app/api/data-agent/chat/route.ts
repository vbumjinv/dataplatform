import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { canUseDb } from "@/app/api/ai-forecast/_lib/db";
import {
  ensureSession,
  getMessages,
  insertMessage,
  withChatDb,
} from "@/app/api/ai-forecast-agent/_lib/chat-db";
import {
  DATA_READINESS_WORKER_ID,
  WORKER_CONTRACT_VERSION,
} from "@/app/api/ai-orchestrator/_lib/worker-contract";
import { requireAdminSession } from "../_lib/auth";
import {
  OLLAMA_MODEL,
  OPENAI_MODEL,
  ollamaChat,
  type OpenAiMessage,
} from "../_lib/llm";
import { SYSTEM_PROMPT } from "../_lib/system-prompt";
import { dataReadinessAnswer } from "../_lib/worker";
import { runDataAgentSessionWorker } from "../_lib/session-worker";

export const runtime = "nodejs";

type ChatBody = {
  sessionId?: string;
  message?: string;
  chatProvider?: string;
  chatModel?: string;
  dbSettingId?: number | string;
};

const toId = (value: unknown): number | null => {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: ChatBody | null = null;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const message = (body?.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ ok: false, error: "메시지를 입력하세요." }, { status: 400 });
  }
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }

  const userId = String(auth.session.userId);
  const sessionId = (body?.sessionId ?? "").trim() || randomUUID();
  const provider = body?.chatProvider === "ollama" ? "ollama" : "openai";
  const dbSettingId = toId(body?.dbSettingId);

  try {
    return await withChatDb(async (client) => {
      await ensureSession(client, { sessionId, userId, title: message.slice(0, 40) });
      await insertMessage(client, {
        sessionId,
        role: "user",
        content: message,
        metadata: { app: "data-agent" },
      });

      const history = await getMessages(client, sessionId, 30);
      const priorMsgs: OpenAiMessage[] = history
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      if (provider === "ollama") {
        const convo = priorMsgs.map((m) => `${m.role}: ${m.content}`).join("\n");
        const prompt = `${SYSTEM_PROMPT}\n\n[주의] 당신(Ollama)은 조회/설명만 가능합니다. 등록·수집·매핑 실행 같은 작업은 상단에서 OpenAI 엔진으로 전환해야 합니다.\n\n[대화]\n${convo}`;
        let text = "";
        try {
          text = await ollamaChat(OLLAMA_MODEL || "qwen3:8b", prompt);
        } catch (error) {
          text = `Ollama 호출에 실패했습니다: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        if (!text) text = "응답을 생성하지 못했습니다.";
        await insertMessage(client, {
          sessionId,
          role: "assistant",
          content: text,
          metadata: {
            app: "data-agent",
            workerId: DATA_READINESS_WORKER_ID,
            contractVersion: WORKER_CONTRACT_VERSION,
          },
        });
        const workerResponse = dataReadinessAnswer(text);
        return NextResponse.json({
          ok: true,
          sessionId,
          mode: "answer",
          text,
          workerId: DATA_READINESS_WORKER_ID,
          contractVersion: WORKER_CONTRACT_VERSION,
          workerResponse,
        });
      }

      const model =
        (body?.chatModel && String(body.chatModel).trim()) || OPENAI_MODEL || "gpt-4o-mini";
      const messages: OpenAiMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...priorMsgs,
      ];

      const workerResponse = await runDataAgentSessionWorker({
        model,
        messages,
        ctx: { request, dbSettingId },
        newToken: () => randomUUID(),
      });

      if (workerResponse.mode === "proposal") {
        const { pendingAction } = workerResponse;
        await insertMessage(client, {
          sessionId,
          role: "assistant",
          content: pendingAction.summary,
          metadata: {
            app: "data-agent",
            workerId: pendingAction.workerId,
            contractVersion: WORKER_CONTRACT_VERSION,
            pendingAction: {
              ...pendingAction,
              status: "pending",
              createdAt: new Date().toISOString(),
            },
          },
        });
        return NextResponse.json({
          ok: true,
          sessionId,
          mode: "proposal",
          pendingAction,
          workerId: pendingAction.workerId,
          contractVersion: WORKER_CONTRACT_VERSION,
          workerResponse,
        });
      }

      const text =
        workerResponse.mode === "answer"
          ? workerResponse.text
          : "무엇을 도와드릴까요?";
      await insertMessage(client, {
        sessionId,
        role: "assistant",
        content: text,
        metadata: {
          app: "data-agent",
          workerId: DATA_READINESS_WORKER_ID,
          contractVersion: WORKER_CONTRACT_VERSION,
        },
      });
      return NextResponse.json({
        ok: true,
        sessionId,
        mode: "answer",
        text,
        workerId: DATA_READINESS_WORKER_ID,
        contractVersion: WORKER_CONTRACT_VERSION,
        workerResponse,
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
