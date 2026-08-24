import { NextResponse } from "next/server";
import { query, queryOne, type Exam } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { SEAT_ORDER_ASC } from "@/lib/seatSort";

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

  const seats = Number.isFinite(examId)
    ? await query<{ cid: string; seat_number: string }>(
        `SELECT cid, seat_number FROM submissions
         WHERE exam_id = $1
         ORDER BY ${SEAT_ORDER_ASC}`,
        [examId],
      )
    : [];

  const header: string[] = ["Seat number", "CID", "MCQ score"];
  const rows: string[][] = [
    header,
    ...seats.map((s) => [s.seat_number, s.cid, ""]),
  ];
  const body = "﻿" + toCsv(rows) + "\n";
  const safe = (exam?.code || exam?.name || "mcq")
    .replace(/[^a-z0-9\-_]+/gi, "_")
    .slice(0, 60);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}_mcq_template.csv"`,
    },
  });
}
