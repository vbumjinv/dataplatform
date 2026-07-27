import { NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { canUseDb, connectWithTimeout, createDbClient } from "@/app/api/ai-forecast/_lib/db";
import {
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_SECURE,
  AUTH_SESSION_MAX_AGE_SECONDS,
  createSessionToken,
} from "@/lib/auth-session";

type LoginPayload = {
  email?: string;
  password?: string;
};

const REQUIRE_EMAIL_VERIFIED =
  String(process.env.AUTH_REQUIRE_EMAIL_VERIFIED ?? "false").toLowerCase() ===
  "true";

const toClientIp = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip") ||
  "";

const writeAccessLog = async (
  client: NonNullable<ReturnType<typeof createDbClient>>,
  payload: {
    userId?: number | null;
    email?: string | null;
    status: "success" | "failed";
    detail?: string | null;
    ipAddress?: string;
    userAgent?: string;
  },
) => {
  try {
    await client.query(
      `
        insert into public.user_access_log (
          user_id,
          email,
          action,
          status,
          ip_address,
          user_agent,
          detail
        )
        values ($1, $2, 'login', $3, $4, $5, $6)
      `,
      [
        payload.userId ?? null,
        payload.email ?? null,
        payload.status,
        payload.ipAddress ?? null,
        payload.userAgent ?? null,
        payload.detail ?? null,
      ],
    );
  } catch {
    // ignore logging failures to keep login flow stable
  }
};

export async function POST(request: Request) {
  let payload: LoginPayload | null = null;
  try {
    payload = (await request.json()) as LoginPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const email = payload?.email?.trim().toLowerCase();
  const password = payload?.password ?? "";
  const ipAddress = toClientIp(request);
  const userAgent = request.headers.get("user-agent") ?? "";

  if (!email || !password) {
    return NextResponse.json(
      { ok: false, error: "이메일과 비밀번호를 입력하세요." },
      { status: 400 },
    );
  }

  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 설정이 올바르지 않아 로그인을 수행할 수 없습니다." },
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
    const result = await client.query(
      `
        select id, email, password, name, email_verified, role
        from public.users
        where lower(email) = $1
        limit 1
      `,
      [email],
    );

    if (result.rowCount === 0) {
      await writeAccessLog(client, {
        email: email ?? null,
        status: "failed",
        detail: "user_not_found",
        ipAddress,
        userAgent,
      });
      return NextResponse.json(
        { ok: false, error: "로그인 정보가 올바르지 않습니다." },
        { status: 401 },
      );
    }

    const row = result.rows[0] as {
      id: number;
      email: string;
      password: string;
      name: string | null;
      email_verified: boolean | null;
      role: string | null;
    };

    const isPasswordMatched = await compare(password, row.password ?? "");
    if (!isPasswordMatched) {
      await writeAccessLog(client, {
        userId: row.id,
        email: row.email,
        status: "failed",
        detail: "password_mismatch",
        ipAddress,
        userAgent,
      });
      return NextResponse.json(
        { ok: false, error: "로그인 정보가 올바르지 않습니다." },
        { status: 401 },
      );
    }

    if (REQUIRE_EMAIL_VERIFIED && row.email_verified !== true) {
      await writeAccessLog(client, {
        userId: row.id,
        email: row.email,
        status: "failed",
        detail: "email_not_verified",
        ipAddress,
        userAgent,
      });
      return NextResponse.json(
        { ok: false, error: "이메일 인증이 완료되지 않은 계정입니다." },
        { status: 403 },
      );
    }

    const token = createSessionToken({
      userId: row.id,
      email: row.email,
      name: row.name,
      role: row.role ?? "user",
    });
    await writeAccessLog(client, {
      userId: row.id,
      email: row.email,
      status: "success",
      detail: "login_success",
      ipAddress,
      userAgent,
    });

    const response = NextResponse.json({
      ok: true,
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role ?? "user",
      },
    });

    response.cookies.set({
      name: AUTH_COOKIE_NAME,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: AUTH_COOKIE_SECURE,
      path: "/",
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    });

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "로그인 처리에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
