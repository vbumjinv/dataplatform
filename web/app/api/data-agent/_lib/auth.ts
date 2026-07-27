// 기존 db/settings/route.ts 의 requireAdminSession 을 복제(기존 파일 미수정).
import { cookies } from "next/headers";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth-session";

export type AdminSessionResult =
  | {
      ok: true;
      session: {
        userId: number;
        email: string;
        name: string | null;
        role: string;
      };
    }
  | { ok: false; status: number; error: string };

export const requireAdminSession = async (): Promise<AdminSessionResult> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  if (!session) {
    return { ok: false, status: 401, error: "로그인이 필요합니다." };
  }
  if (session.role !== "admin") {
    return { ok: false, status: 403, error: "관리자 권한이 필요합니다." };
  }
  return { ok: true, session };
};
