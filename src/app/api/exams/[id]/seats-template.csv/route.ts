import { NextResponse } from "next/server";
import { queryOne, type Exam } from "@/lib/db";
import { toCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const examId = Number(id);
  const exam = Number.isFinite(examId)
    ? await queryOne<Exam>("SELECT name, code FROM exams WHERE id = $1", [
        examId,
      ])
    : null;

  const body = "﻿" + toCsv([["Seat number", "CID"]]) + "\n";
  const safe = (exam?.code || exam?.name || "seats")
    .replace(/[^a-z0-9\-_]+/gi, "_")
    .slice(0, 60);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}_seats_template.csv"`,
    },
  });
}
