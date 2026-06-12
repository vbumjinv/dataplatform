import { Client } from "pg";

export const CONNECT_TIMEOUT_MS = 5000;

export type DbInput = {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
  dbType?: "postgres";
  settingId?: number | null;
};

export type ResolvedDbConfig = {
  url: string;
  database: string;
  user: string;
  password: string;
  dbType: "postgres";
};

export const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const normalizeJdbcUrl = (raw: string) =>
  raw.startsWith("jdbc:") ? raw.replace(/^jdbc:/, "") : raw;

export const buildConnectionString = (payload: DbInput) => {
  if (!payload.url) return null;
  const normalized = normalizeJdbcUrl(payload.url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return null;
  }
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};

const hasInlineConfig = (payload: DbInput) =>
  isNonEmpty(payload.url) &&
  isNonEmpty(payload.database) &&
  isNonEmpty(payload.user) &&
  isNonEmpty(payload.password);

const bootstrapConnectionFromEnv = () =>
  buildConnectionString({
    dbType: "postgres",
    url: process.env.DP_DB_URL,
    database: process.env.DP_DB_NAME,
    user: process.env.DP_DB_USER,
    password: process.env.DP_DB_PASSWORD,
  });

export const loadStoredDbConfig = async (): Promise<ResolvedDbConfig | null> => {
  const bootstrapConnection = bootstrapConnectionFromEnv();
  if (!bootstrapConnection) return null;

  const bootstrapClient = new Client({
    connectionString: bootstrapConnection,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  try {
    await bootstrapClient.connect();
    const result = await bootstrapClient.query(
      `
        select db_type, url, database_name, user_name, password
        from public.app_db_connection_setting
        order by updated_at desc
        limit 1
      `,
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (
      String(row.db_type) !== "postgres" ||
      !isNonEmpty(row.url) ||
      !isNonEmpty(row.database_name) ||
      !isNonEmpty(row.user_name) ||
      !isNonEmpty(row.password)
    ) {
      return null;
    }
    return {
      dbType: "postgres",
      url: row.url,
      database: row.database_name,
      user: row.user_name,
      password: row.password,
    };
  } catch {
    return null;
  } finally {
    try {
      await bootstrapClient.end();
    } catch {
      // ignore
    }
  }
};

export const loadStoredDbConfigById = async (
  settingId: number,
): Promise<ResolvedDbConfig | null> => {
  const bootstrapConnection = bootstrapConnectionFromEnv();
  if (!bootstrapConnection) return null;

  const bootstrapClient = new Client({
    connectionString: bootstrapConnection,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  try {
    await bootstrapClient.connect();
    const result = await bootstrapClient.query(
      `
        select db_type, url, database_name, user_name, password
        from public.app_db_connection_setting
        where id = $1
        limit 1
      `,
      [settingId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (
      String(row.db_type) !== "postgres" ||
      !isNonEmpty(row.url) ||
      !isNonEmpty(row.database_name) ||
      !isNonEmpty(row.user_name) ||
      !isNonEmpty(row.password)
    ) {
      return null;
    }
    return {
      dbType: "postgres",
      url: row.url,
      database: row.database_name,
      user: row.user_name,
      password: row.password,
    };
  } catch {
    return null;
  } finally {
    try {
      await bootstrapClient.end();
    } catch {
      // ignore
    }
  }
};

export const resolveDbConfig = async (
  payload: DbInput,
): Promise<ResolvedDbConfig | null> => {
  if (hasInlineConfig(payload)) {
    return {
      dbType: "postgres",
      url: payload.url!.trim(),
      database: payload.database!.trim(),
      user: payload.user!.trim(),
      password: payload.password!,
    };
  }
  if (typeof payload.settingId === "number" && Number.isFinite(payload.settingId)) {
    return loadStoredDbConfigById(payload.settingId);
  }
  return loadStoredDbConfig();
};
