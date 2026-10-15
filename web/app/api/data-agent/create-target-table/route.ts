import { NextResponse } from "next/server";
import { createTargetTableFromApiPreview } from "@/app/api/ingestion/load-runner";
import { requireAdminSession } from "../_lib/auth";

export const runtime = "nodejs";

type Body = {
  sourceId?: number | string;
  groupId?: number | string;
  schema?: string;
  table?: string;
  dryRun?: boolean;
  dbSettingId?: number | string;
};

const toId = (value: unknown): number | null => {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const quoteSqlIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: Body | null = null;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const sourceId = toId(body?.sourceId);
  const groupId = toId(body?.groupId);
  const table = (body?.table ?? "").trim();
  if (!sourceId || !groupId || !table) {
    return NextResponse.json(
      { ok: false, error: "sourceId, groupId, table 이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const result = await createTargetTableFromApiPreview({
      sourceId,
      groupId,
      schema: body?.schema,
      table,
      dryRun: Boolean(body?.dryRun),
      dbSettingId: toId(body?.dbSettingId),
    });
    return NextResponse.json({ ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "테이블 생성에 실패했습니다.";
    const errorCode =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const permissionDenied = errorCode === "42501" || /permission denied|권한/i.test(msg);
    if (permissionDenied) {
      try {
        const preview = await createTargetTableFromApiPreview({
          sourceId,
          groupId,
          schema: body?.schema,
          table,
          dryRun: true,
          dbSettingId: toId(body?.dbSettingId),
        });
        const columnSql = preview.columns
          .map((column) => `  ${quoteSqlIdentifier(column.name)} ${column.type}`)
          .join(",\n");
        const ddl =
          `CREATE TABLE IF NOT EXISTS ${quoteSqlIdentifier(preview.schema)}.${quoteSqlIdentifier(preview.table)} (\n` +
          `${columnSql}\n);`;
        return NextResponse.json(
          {
            ok: false,
            permissionDenied: true,
            error: `${msg} CREATE 권한이 있는 계정으로 아래 생성문을 실행하세요.`,
            ddl,
            columns: preview.columns,
          },
          { status: 403 },
        );
      } catch {
        // 원래 권한 오류를 그대로 반환한다.
      }
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
