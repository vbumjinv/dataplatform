// 파이프라인용 플랫폼 DB(dp 스키마, DP_DB_* env) 연결 헬퍼.
import { Client } from "pg";
import { resolveDbConfig } from "../../db/_lib/connection";

const CONNECT_TIMEOUT_MS = 5000;
const DB_CONFIG = {
  url: process.env.DP_DB_URL,
  database: process.env.DP_DB_NAME,
  user: process.env.DP_DB_USER,
  password: process.env.DP_DB_PASSWORD,
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeJdbcUrl = (raw: string) =>
  raw.startsWith("jdbc:") ? raw.replace(/^jdbc:/, "") : raw;

const buildConnectionStringFromPayload = (payload: {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
}) => {
  if (!payload.url) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalizeJdbcUrl(payload.url));
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return null;
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};

const buildConnectionString = () =>
  buildConnectionStringFromPayload({
    url: DB_CONFIG.url,
    database: DB_CONFIG.database,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
  });

export const canUseDb = () =>
  isNonEmpty(DB_CONFIG.url) &&
  isNonEmpty(DB_CONFIG.database) &&
  isNonEmpty(DB_CONFIG.user) &&
  isNonEmpty(DB_CONFIG.password);

export const createPipelineClient = () => {
  const connectionString = buildConnectionString();
  if (!connectionString) return null;
  return new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
};

export const parseDbSettingIdFromRequest = (request: Request) => {
  const selectedSettingId = new URL(request.url).searchParams.get("dbSettingId");
  if (!selectedSettingId) return null;
  const numericId = Number(selectedSettingId);
  return Number.isFinite(numericId) ? Math.trunc(numericId) : null;
};

export const createPipelineClientBySettingId = async (settingId: number | null = null) => {
  const resolvedDb = await resolveDbConfig({ settingId });
  if (!resolvedDb) return null;
  const connectionString = buildConnectionStringFromPayload(resolvedDb);
  if (!connectionString) return null;
  return new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
};

export const createPipelineClientFromRequest = async (request: Request) => {
  const settingId = parseDbSettingIdFromRequest(request);
  return createPipelineClientBySettingId(settingId);
};

export const connectWithTimeout = async (client: Client) => {
  let timeoutId: NodeJS.Timeout | null = null;
  await Promise.race([
    client.connect(),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("DB 연결 시간이 초과되었습니다."));
      }, CONNECT_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
};
