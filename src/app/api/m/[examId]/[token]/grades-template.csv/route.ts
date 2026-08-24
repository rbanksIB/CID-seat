import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { query, queryOne, type Exam } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { SEAT_ORDER_ASC } from "@/lib/seatSort";

export const dynamic = "force-dynamic";

// Token-scoped grades template. Primary marker gets every non-absent
// seat and columns Seat number / Grade / Comments. Secondary marker
// gets only the seats in their assigned sample and columns Seat
// number / Primary Marker's grade / Secondary Marker grade /
// Secondary Marker comments — the primary column is populated for
// reference so the second marker can compare while filling in their
// own grade. CIDs are never included on the marker template.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ examId: string; token: string }> },
) {
  const { examId: rawId, token } = await params;
  const examId = Number(rawId);
  if (!Number.isFinite(examId) || !token) notFound();

  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) notFound();

  let role: "primary" | "secondary";
  if (token === exam.primary_access_token) role = "primary";
  else if (token === exam.secondary_access_token) role = "secondary";
  else notFound();

  const safe = (exam.code || exam.name || "grades")
    .replace(/[^a-z0-9\-_]+/gi, "_")
    .slice(0, 60);

  let rows: string[][];
  if (role === "secondary") {
    const seats = await query<{ seat_number: string; grade: string | null }>(
      `SELECT seat_number, grade FROM submissions
       WHERE exam_id = $1 AND in_sample = true AND absent = false
       ORDER BY ${SEAT_ORDER_ASC}`,
      [examId],
    );
    rows = [
      [
        "Seat number",
        "Primary Marker's grade",
        "Secondary Marker grade",
        "Secondary Marker comments",
      ],
      ...seats.map((s) => [s.seat_number, s.grade ?? "", "", ""]),
    ];
  } else {
    const seats = await query<{ seat_number: string }>(
      `SELECT seat_number FROM submissions
       WHERE exam_id = $1 AND absent = false
       ORDER BY ${SEAT_ORDER_ASC}`,
      [examId],
    );
    rows = [
      ["Seat number", "Grade", "Comments"],
      ...seats.map((s) => [s.seat_number, "", ""]),
    ];
  }

  const body = "﻿" + toCsv(rows) + "\n";
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}_grades_template.csv"`,
    },
  });
}
