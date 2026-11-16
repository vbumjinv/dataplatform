import { NextResponse } from "next/server";
import { PYKRX_DATASETS } from "../_lib/pykrx-datasets";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, items: PYKRX_DATASETS });
}
