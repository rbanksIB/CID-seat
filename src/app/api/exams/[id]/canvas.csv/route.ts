import { NextResponse } from "next/server";
import { adminAllowed } from "@/lib/actor";
import {
  query,
  queryOne,
  type Exam,
  type Submission,
} from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { computeWeightedGrade } from "@/lib/weighted";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await adminAllowed())) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { id } = await params;
  const examId = Number(id);
  if (!Number.isFinite(examId)) {
    return new NextResponse("Invalid exam id", { status: 400 });
  }

  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) return new NextResponse("Exam not found", { status: 404 });
  if (exam.status !== "complete") {
    return new NextResponse(
      "Canvas CSV is available once every seat has a final grade",
      { status: 409 },
    );
  }

  const submissions = await query<Submission>(
    `SELECT * FROM submissions
     WHERE exam_id = $1 AND absent = false AND final_grade IS NOT NULL
     ORDER BY cid`,
    [examId],
  );

  const header = [
    "Student",
    "ID",
    "SIS User ID",
    "SIS Login ID",
    "Section",
    exam.name,
  ];
  const rows: (string | number | null)[][] = [header];
  for (const s of submissions) {
    // Where MCQ is enabled we export the weighted grade; otherwise the
    // final grade. Falls back to final grade if either input is missing.
    const gradeForCanvas = computeWeightedGrade(
      s.final_grade,
      s.mcq_score,
      exam.mcq_weighting,
      exam.mcq_enabled,
    );
    rows.push(["", "", s.cid, "", "", gradeForCanvas]);
  }

  // Prepend a UTF-8 BOM so Excel opens the file with the correct
  // encoding — without it, Excel decodes bytes as the local codepage
  // and characters like the em-dash render as garbled sequences
  // (e.g. "‚Äî").
  const body = "﻿" + toCsv(rows) + "\n";
  const safeName = (exam.code || exam.name)
    .replace(/[^a-z0-9\-_]+/gi, "_")
    .slice(0, 60);
  const filename = `${safeName}_canvas_gradebook.csv`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
