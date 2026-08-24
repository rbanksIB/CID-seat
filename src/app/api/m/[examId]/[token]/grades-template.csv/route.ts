import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { query, queryOne, type Exam } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { SEAT_ORDER_ASC } from "@/lib/seatSort";

export const dynamic = "force-dynamic";

// Token-scoped grades template.
//
// Primary marker: every non-absent seat, columns Seat number / Grade /
// Comments (with an MCQ score reference column inserted when the exam
// has MCQ enabled).
//
// Secondary marker: only the seats in their assigned sample, columns
// Seat number / Primary Marker's grade / Secondary Marker grade /
// Secondary Marker comments (with an MCQ score reference column
// inserted when the exam has MCQ enabled). The primary marker's grade
// column is populated for reference so the second marker can compare
// while filling in their own grade.
//
// CIDs are never included on the marker template.
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

  const mcqEnabled = exam.mcq_enabled;
  let rows: string[][];
  if (role === "secondary") {
    const seats = await query<{
      seat_number: string;
      grade: string | null;
      mcq_score: string | null;
    }>(
      `SELECT seat_number, grade, mcq_score FROM submissions
       WHERE exam_id = $1 AND in_sample = true AND absent = false
       ORDER BY ${SEAT_ORDER_ASC}`,
      [examId],
    );
    const header = [
      "Seat number",
      ...(mcqEnabled ? ["MCQ score"] : []),
      "Primary Marker's grade",
      "Secondary Marker grade",
      "Secondary Marker comments",
    ];
    rows = [
      header,
      ...seats.map((s) =>
        mcqEnabled
          ? [s.seat_number, s.mcq_score ?? "", s.grade ?? "", "", ""]
          : [s.seat_number, s.grade ?? "", "", ""],
      ),
    ];
  } else {
    const seats = await query<{
      seat_number: string;
      mcq_score: string | null;
    }>(
      `SELECT seat_number, mcq_score FROM submissions
       WHERE exam_id = $1 AND absent = false
       ORDER BY ${SEAT_ORDER_ASC}`,
      [examId],
    );
    const header = [
      "Seat number",
      ...(mcqEnabled ? ["MCQ score"] : []),
      "Grade",
      "Comments",
    ];
    rows = [
      header,
      ...seats.map((s) =>
        mcqEnabled
          ? [s.seat_number, s.mcq_score ?? "", "", ""]
          : [s.seat_number, "", ""],
      ),
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
