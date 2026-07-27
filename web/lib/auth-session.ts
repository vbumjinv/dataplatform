import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "dp_admin_session";

// Keep login effectively persistent unless explicitly configured.
const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years
const HMAC_ALGO = "sha256";

export type AuthSession = {
  userId: number;
  email: string;
  name: string | null;
  role: string;
  exp: number;
};

const getAuthSecret = () =>
  process.env.AUTH_SECRET || "dev-only-secret-change-in-production";
const getSessionMaxAgeSeconds = () => {
  const raw = Number(process.env.AUTH_SESSION_MAX_AGE_SECONDS ?? DEFAULT_SESSION_MAX_AGE_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_MAX_AGE_SECONDS;
  return Math.trunc(raw);
};
export const AUTH_SESSION_MAX_AGE_SECONDS = getSessionMaxAgeSeconds();

// Secure 쿠키는 HTTPS 에서만 브라우저에 저장된다. HTTP(예: 사내망 TLS 미적용)로
// 서비스하면 브라우저가 Secure 쿠키를 버려 로그인 직후 세션이 사라진다.
// 기본은 production 에서 secure=true 이되, HTTP 로 띄우는 서버는
// AUTH_ALLOW_INSECURE_COOKIE=true 로 끌 수 있게 한다.
export const AUTH_COOKIE_SECURE =
  process.env.NODE_ENV === "production" &&
  String(process.env.AUTH_ALLOW_INSECURE_COOKIE ?? "false").toLowerCase() !==
    "true";

const base64UrlEncode = (raw: string) =>
  Buffer.from(raw, "utf8").toString("base64url");

const base64UrlDecode = (encoded: string) =>
  Buffer.from(encoded, "base64url").toString("utf8");

const sign = (payload: string) =>
  createHmac(HMAC_ALGO, getAuthSecret()).update(payload).digest("base64url");

export const createSessionToken = (
  user: Pick<AuthSession, "userId" | "email" | "name" | "role">,
  maxAgeSeconds = AUTH_SESSION_MAX_AGE_SECONDS,
) => {
  const exp = Date.now() + maxAgeSeconds * 1000;
  const payloadObj: AuthSession = {
    userId: user.userId,
    email: user.email,
    name: user.name,
    role: user.role,
    exp,
  };
  const payload = base64UrlEncode(JSON.stringify(payloadObj));
  const signature = sign(payload);
  return `${payload}.${signature}`;
};

export const verifySessionToken = (token: string | undefined | null) => {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const providedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<AuthSession>;
    if (
      typeof parsed.userId !== "number" ||
      typeof parsed.email !== "string" ||
      typeof parsed.role !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() >= parsed.exp) return null;
    return {
      userId: parsed.userId,
      email: parsed.email,
      name: typeof parsed.name === "string" ? parsed.name : null,
      role: parsed.role,
      exp: parsed.exp,
    } satisfies AuthSession;
  } catch {
    return null;
  }
};
