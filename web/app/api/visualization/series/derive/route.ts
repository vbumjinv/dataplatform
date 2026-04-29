import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "파생 시리즈 기능은 viz_map_mst 전환으로 중단되었습니다. 매핑을 별도로 등록해서 사용해주세요.",
    },
    { status: 410 },
  );
}

