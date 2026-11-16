import { NextResponse } from "next/server";
import { inspectForecastPython } from "../_lib/execute";

export const runtime = "nodejs";

export async function GET() {
  const status = await inspectForecastPython();
  return NextResponse.json({ ok: !status.error, ...status });
}
