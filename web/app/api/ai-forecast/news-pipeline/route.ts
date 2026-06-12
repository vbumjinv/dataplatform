import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

type PipelinePayload = {
  ingest?: {
    queries?: string[];
    displayPerQuery?: number;
    marketCode?: string;
    provider?: "auto" | "openai" | "ollama";
    model?: string;
    dryRun?: boolean;
  };
  aggregate?: {
    marketCode?: string;
    bucketMinutes?: number;
    lookbackHours?: number;
  };
  featureRefresh?: {
    marketCode?: string;
    sourceMapId?: number;
    bucketMinutes?: number;
    featureVersion?: string;
  };
  stopOnError?: boolean;
};

export async function POST(request: Request) {
  let payload: PipelinePayload | null = null;
  try {
    payload = (await request.json()) as PipelinePayload;
  } catch {
    payload = {};
  }

  const stopOnError = payload?.stopOnError !== false;
  const origin = new URL(request.url).origin;
  const results: Array<{ step: string; ok: boolean; status: number; body: unknown }> = [];

  const callStep = async (step: string, path: string, body: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
    });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = { ok: false, error: "JSON 응답 파싱 실패" };
    }
    const ok = response.ok && !!(parsed as { ok?: boolean })?.ok;
    results.push({ step, ok, status: response.status, body: parsed });
    if (!ok && stopOnError) {
      throw new Error(`${step} 실패`);
    }
  };

  try {
    await callStep("ingest", "/api/ai-forecast/news-ingest", payload?.ingest ?? {});
    await callStep("aggregate", "/api/ai-forecast/news-aggregate", payload?.aggregate ?? {});
    await callStep("feature_refresh", "/api/ai-forecast/feature-refresh", payload?.featureRefresh ?? {});

    const allOk = results.every((item) => item.ok);
    return NextResponse.json({ ok: allOk, results }, { status: allOk ? 200 : 207 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "뉴스 파이프라인 실행 실패";
    return NextResponse.json({ ok: false, error: message, results }, { status: 500 });
  }
}
