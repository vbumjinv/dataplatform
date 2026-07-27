import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, AUTH_COOKIE_SECURE } from "@/lib/auth-session";

export async function GET(request: Request) {
  // 실제 접속 호스트(Host 헤더) 기준으로 /login 절대 URL 을 만든다.
  // request.url 이 localhost 로 잡히는 환경에서 공인 IP→loopback 리다이렉트가
  // 브라우저 CORS(Private Network Access)에 막히는 문제를 피한다.
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    new URL(request.url).protocol.replace(":", "");
  const response = NextResponse.redirect(new URL("/login", `${proto}://${host}`));
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: "",
    path: "/",
    expires: new Date(0),
    httpOnly: true,
    sameSite: "lax",
    secure: AUTH_COOKIE_SECURE,
  });
  return response;
}
