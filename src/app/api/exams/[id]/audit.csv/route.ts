import { NextResponse } from "next/server";
import { adminAllowed } from "@/lib/actor";
import {
  EXAM_STATUS_LABEL,
  query,
  queryOne,
  type Exam,
  type Submission,
  type User,
} from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { computeWeightedGrade } from "@/lib/weighted";
import { SEAT_ORDER_ASC } from "@/lib/seatSort";

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

  const submissions = await query<Submission>(
    `SELECT * FROM submissions WHERE exam_id = $1 ORDER BY ${SEAT_ORDER_ASC}`,
    [examId],
  );

  const primary = exam.primary_marker_id
    ? await queryOne<User>("SELECT * FROM users WHERE id = $1", [
        exam.primary_marker_id,
      ])
    : null;
  const secondary = exam.secondary_marker_id
    ? await queryOne<User>("SELECT * FROM users WHERE id = $1", [
        exam.secondary_marker_id,
      ])
    : null;

  const meta = [
    ["# Exam", exam.name],
    ["# Code", exam.code ?? ""],
    ["# Module name", exam.module_name ?? ""],
    ["# Academic year", exam.academic_year ?? ""],
    ["# Status", EXAM_STATUS_LABEL[exam.status]],
    ["# Sampling mode", exam.sampling_mode],
    ["# MCQ enabled", exam.mcq_enabled ? "Yes" : "No"],
    ["# MCQ weighting", exam.mcq_weighting ?? ""],
    ["# Created at", exam.created_at],
    ["# Primary completed at", exam.primary_completed_at ?? ""],
    ["# Secondary completed at", exam.secondary_completed_at ?? ""],
    [
      "# Primary marker",
      primary ? `${primary.name ?? ""} <${primary.email}>` : "",
    ],
    [
      "# Secondary marker",
      secondary ? `${secondary.name ?? ""} <${secondary.email}>` : "",
    ],
    [""],
  ];

  const header = [
    "Seat",
    "CID",
    "Absent",
    "In sample",
    "Primary grade",
    "Primary comment",
    "Primary graded at",
    "Secondary grade",
    "Secondary comment",
    "Secondary graded at",
    "Final grade",
    "Final marker comment",
    "Final graded at",
    "MCQ score",
    "Weighted grade",
    "Override note",
  ];

  const rows: (string | number | null)[][] = [...meta, header];
  for (const s of submissions) {
    const weighted = s.absent
      ? null
      : computeWeightedGrade(
          s.final_grade,
          s.mcq_score,
          exam.mcq_weighting,
          exam.mcq_enabled,
        );
    rows.push([
      s.seat_number,
      s.cid,
      s.absent ? "Yes" : "No",
      s.in_sample ? "Yes" : "No",
      s.grade,
      s.primary_comment,
      s.graded_at,
      s.secondary_grade,
      s.secondary_comment,
      s.secondary_graded_at,
      s.final_grade,
      s.final_comment,
      s.final_graded_at,
      s.mcq_score,
      weighted,
      s.override_note,
    ]);
  }

  const body = "﻿" + toCsv(rows) + "\n";
  const safeName = (exam.code || exam.name)
    .replace(/[^a-z0-9\-_]+/gi, "_")
    .slice(0, 60);
  const filename = `${safeName}_audit.csv`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
