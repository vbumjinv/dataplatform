import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { Client } from "pg";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth-session";
import {
  buildConnectionString,
  CONNECT_TIMEOUT_MS,
  isNonEmpty,
} from "@/app/api/db/_lib/connection";

type DbSettingsPayload = {
  id?: number | string;
  settingName?: string;
  dbType?: "postgres";
  host?: string;
  port?: number | string;
  database?: string;
  user?: string;
  password?: string;
};

type NormalizedPayload = {
  id?: number;
  settingName: string;
  dbType: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  url: string;
};

const createBootstrapClient = () => {
  const connectionString = buildConnectionString({
    dbType: "postgres",
    url: process.env.DP_DB_URL,
    database: process.env.DP_DB_NAME,
    user: process.env.DP_DB_USER,
    password: process.env.DP_DB_PASSWORD,
  });
  if (!connectionString) return null;
  return new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
};

const requireAdminSession = async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ ok: false, error: "로그인이 필요합니다." }, { status: 401 }),
    };
  }
  if (session.role !== "admin") {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, error: "관리자 권한이 필요합니다." },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, email: session.email };
};

const normalizePayload = (
  payload: DbSettingsPayload | null,
  options: { requireId: boolean; requirePassword: boolean },
): { ok: true; value: NormalizedPayload } | { ok: false; error: string } => {
  if (!payload || payload.dbType !== "postgres") {
    return { ok: false, error: "현재 Postgres만 지원합니다." };
  }

  const host = (payload.host ?? "").trim();
  const database = (payload.database ?? "").trim();
  const user = (payload.user ?? "").trim();
  const password = payload.password ?? "";
  const settingName = (payload.settingName ?? "").trim() || "DB 설정";
  const parsedPort = Number(payload.port);

  if (!isNonEmpty(host) || !Number.isInteger(parsedPort) || parsedPort <= 0) {
    return { ok: false, error: "모든 값을 입력하세요" };
  }
  if (!isNonEmpty(database) || !isNonEmpty(user)) {
    return { ok: false, error: "모든 값을 입력하세요" };
  }
  if (options.requirePassword && !isNonEmpty(password)) {
    return { ok: false, error: "모든 값을 입력하세요" };
  }

  const parsedId =
    payload.id === undefined || payload.id === null || payload.id === ""
      ? undefined
      : Number(payload.id);
  if (options.requireId && (!Number.isInteger(parsedId) || (parsedId ?? 0) <= 0)) {
    return { ok: false, error: "수정할 설정 ID가 올바르지 않습니다." };
  }

  const url = `jdbc:postgresql://${host}:${parsedPort}/`;
  return {
    ok: true,
    value: {
      id: parsedId,
      settingName,
      dbType: "postgres",
      host,
      port: parsedPort,
      database,
      user,
      password,
      url,
    },
  };
};

export async function GET() {
  const auth = await requireAdminSession();
  if (!auth.ok) return auth.response;

  const client = createBootstrapClient();
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "기본 DB 연결 설정이 올바르지 않습니다." },
      { status: 500 },
    );
  }

  try {
    await client.connect();
    const result = await client.query(
      `
        select
          id,
          coalesce(setting_name, '기본 연결') as setting_name,
          db_type,
          host,
          port,
          url,
          database_name,
          user_name,
          password,
          updated_by,
          updated_at
        from public.app_db_connection_setting
        order by updated_at desc
      `,
    );

    const settings = result.rows.map((row) => ({
      id: Number(row.id),
      settingName: String(row.setting_name),
      dbType: row.db_type,
      host: typeof row.host === "string" ? row.host : "",
      port: typeof row.port === "number" ? row.port : null,
      url: String(row.url),
      database: String(row.database_name),
      user: String(row.user_name),
      password: String(row.password ?? ""),
      hasPassword: true,
      updatedBy: row.updated_by ?? null,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    }));

    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DB 설정 조회에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) return auth.response;

  let payload: DbSettingsPayload | null = null;
  try {
    payload = (await request.json()) as DbSettingsPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const normalized = normalizePayload(payload, {
    requireId: false,
    requirePassword: true,
  });
  if (!normalized.ok) {
    return NextResponse.json({ ok: false, error: normalized.error }, { status: 400 });
  }
  const config = normalized.value;
  const bootstrapClient = createBootstrapClient();
  if (!bootstrapClient) {
    return NextResponse.json(
      { ok: false, error: "기본 DB 연결 설정이 올바르지 않습니다." },
      { status: 500 },
    );
  }

  try {
    await bootstrapClient.connect();
    await bootstrapClient.query(
      `
        insert into public.app_db_connection_setting (
          id,
          setting_name,
          db_type,
          host,
          port,
          url,
          database_name,
          user_name,
          password,
          updated_by
        )
        values (
          coalesce((select max(id) + 1 from public.app_db_connection_setting), 1),
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )
      `,
      [
        config.settingName,
        config.dbType,
        config.host,
        config.port,
        config.url,
        config.database,
        config.user,
        config.password,
        auth.email,
      ],
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DB 설정 저장에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await bootstrapClient.end();
    } catch {
      // ignore
    }
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) return auth.response;

  let payload: DbSettingsPayload | null = null;
  try {
    payload = (await request.json()) as DbSettingsPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const normalized = normalizePayload(payload, {
    requireId: true,
    requirePassword: true,
  });
  if (!normalized.ok) {
    return NextResponse.json({ ok: false, error: normalized.error }, { status: 400 });
  }
  const config = normalized.value;

  const bootstrapClient = createBootstrapClient();
  if (!bootstrapClient) {
    return NextResponse.json(
      { ok: false, error: "기본 DB 연결 설정이 올바르지 않습니다." },
      { status: 500 },
    );
  }

  try {
    await bootstrapClient.connect();

    const current = await bootstrapClient.query(
      `
        select id
        from public.app_db_connection_setting
        where id = $1
      `,
      [config.id],
    );
    if (!current.rowCount) {
      return NextResponse.json({ ok: false, error: "수정 대상 설정이 없습니다." }, { status: 404 });
    }

    await bootstrapClient.query(
      `
        update public.app_db_connection_setting
        set
          setting_name = $1,
          db_type = $2,
          host = $3,
          port = $4,
          url = $5,
          database_name = $6,
          user_name = $7,
          password = $8,
          updated_by = $9
        where id = $10
      `,
      [
        config.settingName,
        config.dbType,
        config.host,
        config.port,
        config.url,
        config.database,
        config.user,
        config.password,
        auth.email,
        config.id,
      ],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DB 설정 수정에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await bootstrapClient.end();
    } catch {
      // ignore
    }
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) return auth.response;

  let payload: DbSettingsPayload | null = null;
  try {
    payload = (await request.json()) as DbSettingsPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "삭제할 설정 ID가 올바르지 않습니다." }, { status: 400 });
  }

  const bootstrapClient = createBootstrapClient();
  if (!bootstrapClient) {
    return NextResponse.json(
      { ok: false, error: "기본 DB 연결 설정이 올바르지 않습니다." },
      { status: 500 },
    );
  }

  try {
    await bootstrapClient.connect();
    const deleted = await bootstrapClient.query(
      `
        delete from public.app_db_connection_setting
        where id = $1
        returning id
      `,
      [id],
    );
    if (!deleted.rowCount) {
      return NextResponse.json({ ok: false, error: "삭제 대상 설정이 없습니다." }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DB 설정 삭제에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await bootstrapClient.end();
    } catch {
      // ignore
    }
  }
}
