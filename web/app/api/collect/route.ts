import { NextResponse } from "next/server";

type ProxyPayload = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
};

const requestRemote = async (options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}) => {
  const timeout = Number.isFinite(options.timeout) ? Number(options.timeout) : 0;
  let targetUrl: URL;
  try {
    targetUrl = new URL(options.url);
  } catch {
    return NextResponse.json(
      { ok: false, error: "url 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return NextResponse.json(
      { ok: false, error: "http/https URL만 허용됩니다." },
      { status: 400 },
    );
  }

  const method = (options.method ?? "GET").trim().toUpperCase();
  if (!["GET", "POST"].includes(method)) {
    return NextResponse.json(
      { ok: false, error: "GET/POST 메서드만 허용됩니다." },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeoutId = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const response = await fetch(targetUrl.toString(), {
      method,
      headers: options.headers,
      body:
        method === "POST" && options.body !== undefined
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const message =
        typeof data === "string"
          ? data
          : (data as { error?: string }).error ?? "요청에 실패했습니다.";
      return NextResponse.json({ ok: false, error: message }, { status: response.status });
    }

    return NextResponse.json({ ok: true, data, contentType });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? "요청 시간이 초과되었습니다."
          : error.message
        : "요청에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
  }
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const timeout = Number.parseInt(searchParams.get("timeout") ?? "0", 10);

  if (!url) {
    return NextResponse.json(
      { ok: false, error: "url 파라미터가 필요합니다." },
      { status: 400 },
    );
  }
  return requestRemote({
    url,
    method: "GET",
    timeout,
  });
}

export async function POST(request: Request) {
  let payload: ProxyPayload | null = null;
  try {
    payload = (await request.json()) as ProxyPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  const url = (payload?.url ?? "").trim();
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "url 파라미터가 필요합니다." },
      { status: 400 },
    );
  }

  return requestRemote({
    url,
    method: payload?.method ?? "POST",
    headers: payload?.headers,
    body: payload?.body,
    timeout: payload?.timeout,
  });
}
