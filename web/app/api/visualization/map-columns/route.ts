import { NextResponse } from "next/server";
import { canUseDb, createDbClient, connectWithTimeout, isNonEmpty } from "../_lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!canUseDb()) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const client = createDbClient();
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const schema = (url.searchParams.get("schema") ?? "dp").trim() || "dp";
  const table = (url.searchParams.get("table") ?? "").trim();
  if (!isNonEmpty(table)) {
    return NextResponse.json(
      { ok: false, error: "table 파라미터가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    await connectWithTimeout(client);
    const result = await client.query(
      `
        select
          column_name,
          data_type
        from information_schema.columns
        where table_schema = $1
          and table_name = $2
        order by ordinal_position
      `,
      [schema, table],
    );
    return NextResponse.json({
      ok: true,
      columns: result.rows.map((row) => ({
        name: row.column_name as string,
        dataType: row.data_type as string,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "테이블 컬럼 목록을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

