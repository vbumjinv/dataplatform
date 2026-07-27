// 기존 API 라우트를 서버측에서 호출(기존 코드 재사용, 미수정). 쿠키를 전달해 인증을 승계한다.

export const getOrigin = (request: Request) => {
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
};

export type InternalResponse = { status: number; ok: boolean; json: unknown };

export const internalFetch = async (
  request: Request,
  path: string,
  init: RequestInit = {},
): Promise<InternalResponse> => {
  const cookie = request.headers.get("cookie") ?? "";
  const response = await fetch(`${getOrigin(request)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      cookie,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: response.status, ok: response.ok, json };
};
