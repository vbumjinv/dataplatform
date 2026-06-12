import { NextResponse } from "next/server";
import { extractTableFromPdf, toRectangular } from "../_lib/openai-pdf";

export const runtime = "nodejs";

const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8MB

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "잘못된 요청 형식입니다. (multipart/form-data 필요)" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const description = (form.get("description") ?? "").toString().trim();
  const pageHint = (form.get("pageHint") ?? "").toString().trim();

  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json(
      { ok: false, error: "PDF 파일을 첨부하세요." },
      { status: 400 },
    );
  }
  const fileName =
    file instanceof File && file.name ? file.name : "uploaded.pdf";
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(fileName);
  if (!isPdf) {
    return NextResponse.json(
      { ok: false, error: "PDF 파일만 업로드할 수 있습니다." },
      { status: 400 },
    );
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `PDF 크기가 너무 큽니다. (최대 ${Math.round(
          MAX_PDF_BYTES / (1024 * 1024),
        )}MB)`,
      },
      { status: 400 },
    );
  }
  if (!description) {
    return NextResponse.json(
      { ok: false, error: "추출할 표의 제목/설명을 입력하세요." },
      { status: 400 },
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");
    const { table, responseId } = await extractTableFromPdf({
      base64,
      filename: fileName,
      description,
      pageHint: pageHint || null,
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
        message: "설명에 맞는 표를 찾지 못했습니다. 설명을 더 구체적으로 입력해 보세요.",
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
      error instanceof Error ? error.message : "PDF 표 추출에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
