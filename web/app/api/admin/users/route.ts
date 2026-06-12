import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { canUseDb, connectWithTimeout, createDbClient } from "@/app/api/ai-forecast/_lib/db";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth-session";

type UserRow = {
  id: number;
  email: string;
  name: string | null;
  phoneNo: string | null;
  role: string;
  emailVerified: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type AccessLogRow = {
  accessLogId: number;
  userId: number | null;
  email: string | null;
  action: string;
  status: string;
  ipAddress: string | null;
  detail: string | null;
  createdAt: string;
};

const toStringOrNull = (value: unknown) =>
  typeof value === "string" ? value : null;

const toIsoOrNull = (value: unknown) => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
};

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "관리자 권한이 필요합니다." }, { status: 403 });
  }

  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 설정이 올바르지 않습니다." },
      { status: 500 },
    );
  }

  const client = createDbClient();
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 클라이언트를 만들 수 없습니다." },
      { status: 500 },
    );
  }

  try {
    await connectWithTimeout(client);

    const usersRes = await client.query(
      `
        select
          id,
          email,
          name,
          phone_no,
          coalesce(role, 'user') as role,
          email_verified,
          created_at,
          updated_at
        from public.users
        order by id desc
      `,
    );

    let logs: AccessLogRow[] = [];
    try {
      const logsRes = await client.query(
        `
          select
            access_log_id,
            user_id,
            email,
            action,
            status,
            ip_address,
            detail,
            created_at
          from public.user_access_log
          order by access_log_id desc
          limit 200
        `,
      );
      logs = logsRes.rows.map((row) => ({
        accessLogId: Number(row.access_log_id),
        userId: row.user_id === null ? null : Number(row.user_id),
        email: toStringOrNull(row.email),
        action: String(row.action),
        status: String(row.status),
        ipAddress: toStringOrNull(row.ip_address),
        detail: toStringOrNull(row.detail),
        createdAt: toIsoOrNull(row.created_at) ?? "",
      }));
    } catch {
      logs = [];
    }

    const users: UserRow[] = usersRes.rows.map((row) => ({
      id: Number(row.id),
      email: String(row.email),
      name: toStringOrNull(row.name),
      phoneNo: toStringOrNull(row.phone_no),
      role: String(row.role ?? "user"),
      emailVerified:
        typeof row.email_verified === "boolean" ? row.email_verified : null,
      createdAt: toIsoOrNull(row.created_at),
      updatedAt: toIsoOrNull(row.updated_at),
    }));

    return NextResponse.json({ ok: true, users, accessLogs: logs });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "사용자 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
