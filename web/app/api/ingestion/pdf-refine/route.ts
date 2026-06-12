import { NextResponse } from "next/server";
import { refineTableFromPdf, toRectangular } from "../_lib/openai-pdf";

export const runtime = "nodejs";

type RefineRequest = {
  previousResponseId?: string;
  instruction?: string;
};

export async function POST(request: Request) {
  let payload: RefineRequest | null = null;
  try {
    payload = (await request.json()) as RefineRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  const previousResponseId = payload?.previousResponseId?.trim();
  const instruction = payload?.instruction?.trim();
  if (!previousResponseId) {
    return NextResponse.json(
      {
        ok: false,
        error: "이전 추출 응답 ID가 없어 대화형 수정을 할 수 없습니다. 다시 추출해 주세요.",
      },
      { status: 400 },
    );
  }
  if (!instruction) {
    return NextResponse.json(
      { ok: false, error: "수정 요청 내용을 입력하세요." },
      { status: 400 },
    );
  }

  try {
    const { table, responseId } = await refineTableFromPdf({
      previousResponseId,
      instruction,
    });

    if (!table.found || table.columns.length === 0 || table.rows.length === 0) {
      return NextResponse.json({
        ok: true,
        found: false,
        responseId,
        detectedTitle: table.detectedTitle,
        unit: table.unit,
        columns: table.columns,
        rows: table.rows,
        notes: table.notes,
        message: "요청을 반영한 표를 만들지 못했습니다. 다른 표현으로 다시 시도해 보세요.",
      });
    }

    const rectangular = toRectangular(table);
    return NextResponse.json({
      ok: true,
      found: true,
      responseId,
      detectedTitle: rectangular.detectedTitle,
      unit: rectangular.unit,
      columns: rectangular.columns,
      rows: rectangular.rows,
      notes: rectangular.notes,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "표 수정에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
