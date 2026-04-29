import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    data: {
      table: "users",
      rows: [
        { id: "u-1001", name: "Dana", role: "admin" },
        { id: "u-1002", name: "Evan", role: "analyst" },
        { id: "u-1003", name: "Rita", role: "viewer" },
      ],
    },
  });
}
