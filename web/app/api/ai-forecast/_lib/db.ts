import { Client } from "pg";

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

export const canUseDb = () =>
  isNonEmpty(DB_CONFIG.url) &&
  isNonEmpty(DB_CONFIG.database) &&
  isNonEmpty(DB_CONFIG.user) &&
  isNonEmpty(DB_CONFIG.password);

export const buildConnectionString = () => {
  if (!DB_CONFIG.url) return null;
  const normalized = normalizeJdbcUrl(DB_CONFIG.url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return null;
  if (DB_CONFIG.user) parsed.username = DB_CONFIG.user;
  if (DB_CONFIG.password) parsed.password = DB_CONFIG.password;
  if (DB_CONFIG.database) parsed.pathname = `/${DB_CONFIG.database}`;
  return parsed.toString();
};

export const createDbClient = () => {
  const connectionString = buildConnectionString();
  if (!connectionString) return null;
  return new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
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

