import { Client } from "pg";
import { buildConnectionString, resolveDbConfig } from "../../db/_lib/connection";

const CONNECT_TIMEOUT_MS = 5000;

const resolveConnString = async (settingId?: number | null): Promise<string | null> => {
  if (typeof settingId === "number" && Number.isFinite(settingId) && settingId > 0) {
    const resolved = await resolveDbConfig({ settingId });
    return resolved ? buildConnectionString(resolved) : null;
  }
  return buildConnectionString({
    dbType: "postgres",
    url: process.env.DP_DB_URL,
    database: process.env.DP_DB_NAME,
    user: process.env.DP_DB_USER,
    password: process.env.DP_DB_PASSWORD,
  });
};

export const connectNewsClient = async (settingId?: number | null): Promise<Client> => {
  const connectionString = await resolveConnString(settingId);
  if (!connectionString) {
    throw new Error("DB 연결 설정을 찾을 수 없습니다.");
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  let timeoutId: NodeJS.Timeout | null = null;
  await Promise.race([
    client.connect(),
    new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("DB 연결 시간이 초과되었습니다.")),
        CONNECT_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return client;
};
