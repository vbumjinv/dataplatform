import { createDbClient, connectWithTimeout } from "../../ai-forecast/_lib/db";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatSession = {
  sessionId: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
};

export type ChatMessage = {
  messageId: number;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

const mapSession = (row: Record<string, unknown>): ChatSession => ({
  sessionId: String(row.session_id),
  userId: String(row.user_id),
  title: (row.title as string | null) ?? null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  lastMessageAt: String(row.last_message_at),
});

const mapMessage = (row: Record<string, unknown>): ChatMessage => ({
  messageId: Number(row.message_id),
  sessionId: String(row.session_id),
  role: String(row.role) as ChatRole,
  content: String(row.content ?? ""),
  createdAt: String(row.created_at),
  metadata: (row.metadata as Record<string, unknown> | null) ?? null,
});

export const withChatDb = async <T>(work: (client: NonNullable<ReturnType<typeof createDbClient>>) => Promise<T>) => {
  const client = createDbClient();
  if (!client) {
    throw new Error("DB 접속 URL 형식이 올바르지 않습니다.");
  }
  try {
    await connectWithTimeout(client);
    return await work(client);
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
};

export const ensureSession = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  payload: { sessionId: string; userId: string; title?: string | null },
) => {
  await client.query(
    `
      insert into dp.ai_forecast_chat_session (session_id, user_id, title)
      values ($1::uuid, $2::text, $3::text)
      on conflict (session_id) do update
      set
        user_id = excluded.user_id,
        title = coalesce(dp.ai_forecast_chat_session.title, excluded.title),
        updated_at = now()
    `,
    [payload.sessionId, payload.userId, payload.title ?? null],
  );

  const result = await client.query(
    `
      select
        session_id,
        user_id,
        title,
        created_at,
        updated_at,
        last_message_at
      from dp.ai_forecast_chat_session
      where session_id = $1::uuid
      limit 1
    `,
    [payload.sessionId],
  );
  if (!result.rowCount) throw new Error("세션 생성/조회에 실패했습니다.");
  return mapSession(result.rows[0]);
};

export const listSessions = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  userId: string,
  limit = 30,
) => {
  const result = await client.query(
    `
      select
        session_id,
        user_id,
        title,
        created_at,
        updated_at,
        last_message_at
      from dp.ai_forecast_chat_session
      where user_id = $1::text
        and is_active = true
      order by last_message_at desc
      limit $2::int
    `,
    [userId, Math.max(1, Math.min(100, limit))],
  );
  return result.rows.map(mapSession);
};

export const insertMessage = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  payload: {
    sessionId: string;
    role: ChatRole;
    content: string;
    metadata?: Record<string, unknown> | null;
  },
) => {
  const result = await client.query(
    `
      insert into dp.ai_forecast_chat_message (session_id, role, content, metadata)
      values ($1::uuid, $2::text, $3::text, $4::jsonb)
      returning message_id, session_id, role, content, created_at, metadata
    `,
    [payload.sessionId, payload.role, payload.content, payload.metadata ?? null],
  );
  await client.query(
    `
      update dp.ai_forecast_chat_session
      set
        last_message_at = now(),
        updated_at = now()
      where session_id = $1::uuid
    `,
    [payload.sessionId],
  );
  return mapMessage(result.rows[0]);
};

export const getMessages = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  sessionId: string,
  limit = 40,
) => {
  const result = await client.query(
    `
      select
        message_id,
        session_id,
        role,
        content,
        created_at,
        metadata
      from dp.ai_forecast_chat_message
      where session_id = $1::uuid
      order by created_at desc, message_id desc
      limit $2::int
    `,
    [sessionId, Math.max(1, Math.min(400, limit))],
  );
  return result.rows.map(mapMessage).reverse();
};

export const getSummary = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  sessionId: string,
) => {
  const result = await client.query(
    `
      select summary_text, summarized_through_message_id, updated_at
      from dp.ai_forecast_chat_summary
      where session_id = $1::uuid
      limit 1
    `,
    [sessionId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    summaryText: String(row.summary_text ?? ""),
    summarizedThroughMessageId:
      typeof row.summarized_through_message_id === "number"
        ? row.summarized_through_message_id
        : Number(row.summarized_through_message_id ?? 0) || null,
    updatedAt: String(row.updated_at),
  };
};

export const upsertSummary = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  payload: {
    sessionId: string;
    summaryText: string;
    summarizedThroughMessageId?: number | null;
  },
) => {
  await client.query(
    `
      insert into dp.ai_forecast_chat_summary (
        session_id,
        summary_text,
        summarized_through_message_id,
        updated_at
      )
      values ($1::uuid, $2::text, $3::bigint, now())
      on conflict (session_id) do update
      set
        summary_text = excluded.summary_text,
        summarized_through_message_id = excluded.summarized_through_message_id,
        updated_at = now()
    `,
    [payload.sessionId, payload.summaryText, payload.summarizedThroughMessageId ?? null],
  );
};
