import { NextResponse } from "next/server";
import { fetchBokStatistic, isBokCycle } from "@/app/workflow/lib/bok";
import type { BokCycle, BokNodeOptions } from "@/app/workflow/types";

export const runtime = "nodejs";

type BokRequest = Partial<BokNodeOptions> & {
  preview?: boolean;
};

export async function POST(request: Request) {
  let body: BokRequest = {};
  try {
    body = (await request.json()) as BokRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 값을 확인할 수 없습니다." },
      { status: 400 },
    );
  }

  const cycle = (body.cycle ?? "").trim().toUpperCase();
  if (!isBokCycle(cycle)) {
    return NextResponse.json(
      { ok: false, error: "주기를 선택해주세요." },
      { status: 400 },
    );
  }

  const options: BokNodeOptions = {
    apiKey: body.apiKey?.trim() ?? "",
    statCode: body.statCode?.trim() ?? "",
    statName: body.statName?.trim() ?? "",
    cycle: cycle as BokCycle,
    startDate: body.startDate?.trim() ?? "",
    endDate: body.endDate?.trim() ?? "",
  };

  try {
    const fetched = await fetchBokStatistic(
      options,
      body.preview ? 10 : 100000,
      !body.preview,
    );
    if (!fetched.ok) {
      return NextResponse.json({ ok: false, error: fetched.error }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      columns: fetched.columns,
      rows: fetched.rows,
      total: fetched.total,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "한국은행 API 호출에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
