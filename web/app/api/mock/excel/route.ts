import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    data: {
      sheet: "Sheet1",
      rows: [
        { id: 1, name: "Alpha", score: 82 },
        { id: 2, name: "Bravo", score: 91 },
        { id: 3, name: "Charlie", score: 77 },
      ],
    },
  });
}
