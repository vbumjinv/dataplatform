import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, AUTH_COOKIE_SECURE } from "@/lib/auth-session";

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url));
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
