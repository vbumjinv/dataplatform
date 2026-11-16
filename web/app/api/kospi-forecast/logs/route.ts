import { NextResponse } from "next/server";
import { readForecastLogs } from "../_lib/run-log";

export const runtime = "nodejs";

export async function GET() {
  const logs = await readForecastLogs();
  return NextResponse.json({ ok: true, logs });
}
