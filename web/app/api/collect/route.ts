import { NextResponse } from "next/server";

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

  let targetUrl: URL;
  try {
    targetUrl = new URL(url);
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

  const controller = new AbortController();
  const timeoutId = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const response = await fetch(targetUrl.toString(), {
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
}
