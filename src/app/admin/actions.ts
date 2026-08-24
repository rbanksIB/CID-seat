"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { findOrCreateUser } from "@/lib/auth";
import { query, queryOne, randomToken, type Exam } from "@/lib/db";
import { parseCsv } from "@/lib/csv";
import { parseUkLocalDateTime, todayUkIsoDate } from "@/lib/datetime";
import {
  buildMarkerEmail,
  markerUrl,
  recordEmail,
} from "@/lib/deadlines";
import { type SaveState, toErrorState } from "@/lib/actionState";

async function getOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

// Deadlines are now stored as a bare 'YYYY-MM-DD' UK date. Overdue
// detection treats the deadline as passed once local UK time crosses
// midnight into the following date -- see endOfDeadlineDay().
function parseDeadline(input: FormDataEntryValue | null): string | null {
  const v = String(input ?? "").trim();
  if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error("Deadline is not a valid date");
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Same as parseDeadline but refuses any date earlier than today (UK).
// Use when the caller is entering a NEW deadline. Stored past-date
// deadlines from earlier are read back unchanged.
function parseFutureDeadline(
  input: FormDataEntryValue | null,
  label: string,
): string | null {
  const d = parseDeadline(input);
  if (d && d < todayUkIsoDate()) {
    throw new Error(`${label} cannot be in the past`);
  }
  return d;
}

function parseEmail(input: FormDataEntryValue | null): string {
  const e = String(input ?? "").trim().toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new Error("Please provide a valid email address");
  }
  return e;
}

function parseSamplingMode(v: FormDataEntryValue | null): "standard" | "full" {
  const s = String(v ?? "standard").trim();
  return s === "full" ? "full" : "standard";
}

export async function createExamAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim() || null;
  const moduleName =
    String(formData.get("module_name") ?? "").trim() || null;
  const academicYearRaw =
    String(formData.get("academic_year") ?? "").trim() || null;
  const academicYear =
    academicYearRaw && /^\d{2}\/\d{2}$/.test(academicYearRaw)
      ? academicYearRaw
      : null;
  const samplingMode = parseSamplingMode(formData.get("sampling_mode"));
  const primaryDeadline = parseFutureDeadline(
    formData.get("primary_deadline"),
    "Primary marker deadline",
  );
  const secondaryDeadline = parseFutureDeadline(
    formData.get("secondary_deadline"),
    "Second marker deadline",
  );
  const programmeIdRaw = String(formData.get("programme_id") ?? "").trim();
  const programmeId = programmeIdRaw ? Number(programmeIdRaw) : null;
  const mcqEnabled = formData.get("mcq_enabled") === "on";
  const isResit = formData.get("is_resit") === "on";
  const mcqWeightingRaw = String(formData.get("mcq_weighting") ?? "").trim();
  let mcqWeighting: number | null = null;
  if (mcqEnabled) {
    if (!/^\d+(\.\d{1,2})?$/.test(mcqWeightingRaw)) {
      throw new Error(
        "MCQ weighting must be a number 0-100 with up to 2 decimal places",
      );
    }
    mcqWeighting = Number(mcqWeightingRaw);
    if (mcqWeighting < 0 || mcqWeighting > 100) {
      throw new Error("MCQ weighting must be between 0 and 100");
    }
  }
  if (programmeIdRaw && !Number.isFinite(programmeId)) {
    throw new Error("Programme selection is invalid");
  }
  if (!name) throw new Error("Exam name is required");
  if (!primaryDeadline) {
    throw new Error("Primary marker deadline is required");
  }
  if (!secondaryDeadline) {
    throw new Error("Second marker deadline is required");
  }

  const primaryEmail = parseEmail(formData.get("primary_email"));
  const primaryName =
    String(formData.get("primary_name") ?? "").trim() || null;
  const secondaryEmail = parseEmail(formData.get("secondary_email"));
  const secondaryName =
    String(formData.get("secondary_name") ?? "").trim() || null;

  if (primaryEmail === secondaryEmail) {
    throw new Error(
      "Primary and secondary markers must have different email addresses",
    );
  }

  const primary = await findOrCreateUser(primaryEmail, primaryName);
  const secondary = await findOrCreateUser(secondaryEmail, secondaryName);

  const row = await queryOne<{ id: number }>(
    `INSERT INTO exams
       (name, code, module_name, academic_year, primary_marker_id,
        secondary_marker_id, status, sampling_mode,
        primary_access_token, secondary_access_token,
        primary_deadline_date, secondary_deadline_date, programme_id,
        mcq_enabled, mcq_weighting, is_resit)
     VALUES ($1, $2, $3, $4, $5, $6, 'setup', $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      name,
      code,
      moduleName,
      academicYear,
      primary.id,
      secondary.id,
      samplingMode,
      randomToken(),
      randomToken(),
      primaryDeadline,
      secondaryDeadline,
      programmeId,
      mcqEnabled,
      mcqWeighting,
      isResit,
    ],
  );
  if (!row) throw new Error("Failed to create exam");

  redirect(`/admin/exams/${row.id}`);
}

export async function resetSeatsAction(examId: number) {
  const exam = await queryOne<Exam>(
    "SELECT status FROM exams WHERE id = $1",
    [examId],
  );
  if (!exam) throw new Error("Exam not found");
  if (exam.status !== "setup") {
    throw new Error(
      "Seat list can only be reset before primary marking begins",
    );
  }
  await query("DELETE FROM submissions WHERE exam_id = $1", [examId]);
  revalidatePath(`/admin/exams/${examId}`);
}

export async function setMcqScoreAction(
  examId: number,
  submissionId: number,
  formData: FormData,
) {
  const raw = String(formData.get("mcq_score") ?? "").trim();
  if (raw !== "" && !/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(
      "MCQ score must be a number with up to 2 decimal places",
    );
  }
  await query(
    "UPDATE submissions SET mcq_score = $1 WHERE id = $2 AND exam_id = $3",
    [raw === "" ? null : raw, submissionId, examId],
  );
  revalidatePath(`/admin/exams/${examId}`);
}

export async function uploadMcqCsvAction(
  examId: number,
  formData: FormData,
): Promise<{ saved: number; skipped: string[] }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("No file uploaded");
  }
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("CSV is empty");

  const first = rows[0].map((s) => s.trim().toLowerCase());
  const hasHeader = first.some((c) => /cid|seat|mcq|score/i.test(c));
  let cidIdx = 0;
  let seatIdx = 1;
  let scoreIdx = 2;
  let start = 0;
  if (hasHeader) {
    start = 1;
    const findIdx = (patterns: RegExp[]) =>
      first.findIndex((c) => patterns.some((p) => p.test(c)));
    const c = findIdx([/^cid\b/i, /student.?id/i]);
    const s = findIdx([/^seat/i, /seat.?number/i]);
    const m = findIdx([/mcq/i, /score/i]);
    if (c >= 0) cidIdx = c;
    if (s >= 0) seatIdx = s;
    if (m >= 0) scoreIdx = m;
  }

  const subs = await query<{ id: number; seat_number: string; cid: string }>(
    "SELECT id, seat_number, cid FROM submissions WHERE exam_id = $1",
    [examId],
  );
  const bySeat = new Map(subs.map((r) => [r.seat_number, r]));
  const byCid = new Map(subs.map((r) => [r.cid, r]));

  const skipped: string[] = [];
  let saved = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const cid = (r[cidIdx] ?? "").trim();
    const seat = (r[seatIdx] ?? "").trim();
    const score = (r[scoreIdx] ?? "").trim();
    if (!cid && !seat) continue;
    const target = (cid && byCid.get(cid)) || (seat && bySeat.get(seat));
    if (!target) {
      skipped.push(`Row for ${cid || seat}: not in exam`);
      continue;
    }
    if (score !== "" && !/^\d+(\.\d{1,2})?$/.test(score)) {
      skipped.push(
        `Seat ${target.seat_number}: MCQ score "${score}" is not a valid number`,
      );
      continue;
    }
    await query(
      "UPDATE submissions SET mcq_score = $1 WHERE id = $2",
      [score === "" ? null : score, target.id],
    );
    saved++;
  }
  revalidatePath(`/admin/exams/${examId}`);
  return { saved, skipped };
}

export async function updateMcqWeightingAction(
  examId: number,
  formData: FormData,
) {
  const raw = String(formData.get("mcq_weighting") ?? "").trim();
  if (raw === "") {
    await query(
      "UPDATE exams SET mcq_weighting = NULL WHERE id = $1",
      [examId],
    );
  } else {
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      throw new Error(
        "MCQ weighting must be a number 0-100 with up to 2 decimal places",
      );
    }
    const n = Number(raw);
    if (n < 0 || n > 100) {
      throw new Error("MCQ weighting must be between 0 and 100");
    }
    await query(
      "UPDATE exams SET mcq_weighting = $1 WHERE id = $2",
      [n, examId],
    );
  }
  revalidatePath(`/admin/exams/${examId}`);
}

// Admin grade override. Writes to whichever column matches the given
// field, appending an override note that identifies the acting admin.
export async function adminOverrideGradeAction(
  examId: number,
  submissionId: number,
  field: "grade" | "secondary_grade" | "final_grade" | "mcq_score",
  formData: FormData,
) {
  const { getActingAdmin } = await import("@/lib/actor");
  const acting = await getActingAdmin();
  const raw = String(formData.get("value") ?? "").trim();
  if (raw !== "" && !/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(
      "Grade must be a number with up to 2 decimal places",
    );
  }
  // Grade fields (not MCQ) are constrained to the 0-100 range.
  if (raw !== "" && field !== "mcq_score") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error("Grade must be between 0 and 100");
    }
  }
  const value = raw === "" ? null : raw;
  const note = `Grade (${field}) was changed by Admin user ${
    acting?.name ?? "unknown"
  } on ${new Date().toISOString()}`;
  // Guard column name against injection.
  const allowed = new Set([
    "grade",
    "secondary_grade",
    "final_grade",
    "mcq_score",
  ]);
  if (!allowed.has(field)) throw new Error("Invalid field");
  await query(
    `UPDATE submissions
     SET ${field} = $1,
         override_note = COALESCE(override_note || E'\\n', '') || $2
     WHERE id = $3 AND exam_id = $4`,
    [value, note, submissionId, examId],
  );
  revalidatePath(`/admin/exams/${examId}`);
}

export async function toggleAbsentAction(
  examId: number,
  submissionId: number,
) {
  const exam = await queryOne<Exam>(
    "SELECT status FROM exams WHERE id = $1",
    [examId],
  );
  if (!exam) throw new Error("Exam not found");
  await query(
    `UPDATE submissions
     SET absent = NOT absent,
         -- If we're marking absent, wipe any grade / comment that leaked in.
         grade = CASE WHEN NOT absent THEN NULL ELSE grade END,
         graded_at = CASE WHEN NOT absent THEN NULL ELSE graded_at END,
         primary_comment = CASE WHEN NOT absent THEN NULL ELSE primary_comment END,
         secondary_grade = CASE WHEN NOT absent THEN NULL ELSE secondary_grade END,
         secondary_graded_at = CASE WHEN NOT absent THEN NULL ELSE secondary_graded_at END,
         secondary_comment = CASE WHEN NOT absent THEN NULL ELSE secondary_comment END,
         final_grade = CASE WHEN NOT absent THEN NULL ELSE final_grade END,
         final_comment = CASE WHEN NOT absent THEN NULL ELSE final_comment END,
         final_graded_at = CASE WHEN NOT absent THEN NULL ELSE final_graded_at END,
         in_sample = CASE WHEN NOT absent THEN false ELSE in_sample END
     WHERE id = $1 AND exam_id = $2`,
    [submissionId, examId],
  );
  revalidatePath(`/admin/exams/${examId}`);
}

export async function updatePrimaryDeadlineAction(
  examId: number,
  formData: FormData,
) {
  const deadline = parseFutureDeadline(
    formData.get("primary_deadline"),
    "Primary marker deadline",
  );
  // Also snap status out of overdue/late so the sweep can re-diagnose
  // against the new date. Other statuses are left alone.
  await query(
    `UPDATE exams
     SET primary_deadline_date = $1,
         primary_overdue_notified_at = NULL,
         primary_late_notified_at = NULL,
         status = CASE
           WHEN status IN ('first_marking_overdue', 'first_marking_late')
             THEN 'primary_marking'
           ELSE status
         END
     WHERE id = $2`,
    [deadline, examId],
  );
  revalidatePath(`/admin/exams/${examId}`);
}

export async function updateSecondaryDeadlineAction(
  examId: number,
  formData: FormData,
) {
  const deadline = parseFutureDeadline(
    formData.get("secondary_deadline"),
    "Second marker deadline",
  );
  await query(
    `UPDATE exams
     SET secondary_deadline_date = $1,
         secondary_overdue_notified_at = NULL,
         secondary_late_notified_at = NULL,
         status = CASE
           WHEN status IN ('second_marking_overdue', 'second_marking_late')
             THEN 'secondary_marking'
           ELSE status
         END
     WHERE id = $2`,
    [deadline, examId],
  );
  revalidatePath(`/admin/exams/${examId}`);
}

export async function reassignMarkerAction(
  examId: number,
  role: "primary" | "secondary",
  formData: FormData,
) {
  const email = parseEmail(formData.get("email"));
  const name = String(formData.get("name") ?? "").trim() || null;

  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) throw new Error("Exam not found");

  const user = await findOrCreateUser(email, name);

  if (role === "primary" && user.id === exam.secondary_marker_id) {
    throw new Error("Primary and secondary markers must be different people");
  }
  if (role === "secondary" && user.id === exam.primary_marker_id) {
    throw new Error("Primary and secondary markers must be different people");
  }

  const column =
    role === "primary" ? "primary_marker_id" : "secondary_marker_id";
  await query(`UPDATE exams SET ${column} = $1 WHERE id = $2`, [
    user.id,
    examId,
  ]);

  revalidatePath(`/admin/exams/${examId}`);
}

export async function uploadSeatsAction(examId: number, formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("No file uploaded");
  }
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("CSV is empty");

  // Header detection: look for known column names and remember their
  // position. Falls back to positional (seat, cid) if no header row.
  const first = rows[0].map((s) => s.trim().toLowerCase());
  const hasHeader = first.some((c) => /seat|cid|student/i.test(c));
  let seatIdx = 0;
  let cidIdx = 1;
  let start = 0;
  if (hasHeader) {
    start = 1;
    const findIdx = (patterns: RegExp[]) =>
      first.findIndex((c) => patterns.some((p) => p.test(c)));
    const s = findIdx([/^seat/i, /seat.?number/i, /seat.?no/i]);
    const c = findIdx([/^cid$/i, /^cid\b/i, /student.?id/i]);
    if (s >= 0) seatIdx = s;
    if (c >= 0) cidIdx = c;
  }

  const entries: { seat: string; cid: string }[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const seat = (r[seatIdx] ?? "").trim();
    const cid = (r[cidIdx] ?? "").trim();
    if (!seat || !cid) continue;
    entries.push({ seat, cid });
  }
  if (entries.length === 0) throw new Error("No valid seat/CID rows found");

  // Reject the whole upload if the CSV repeats a seat number or a CID.
  const seenSeats = new Set<string>();
  const seenCids = new Set<string>();
  for (const { seat, cid } of entries) {
    if (seenSeats.has(seat) || seenCids.has(cid)) {
      throw new Error(
        "CSV upload rejected. CSV contains duplicate entries. All CIDs and seat numbers must be unique.",
      );
    }
    seenSeats.add(seat);
    seenCids.add(cid);
  }

  for (const { seat, cid } of entries) {
    await query(
      `INSERT INTO submissions (exam_id, seat_number, cid)
       VALUES ($1, $2, $3)
       ON CONFLICT (exam_id, seat_number)
       DO UPDATE SET cid = EXCLUDED.cid`,
      [examId, seat, cid],
    );
  }

  revalidatePath(`/admin/exams/${examId}`);
}

export async function addSeatAction(examId: number, formData: FormData) {
  const seat = String(formData.get("seat") ?? "").trim();
  const cid = String(formData.get("cid") ?? "").trim();
  if (!seat || !cid) {
    throw new Error("Both seat number and CID are required");
  }

  // Reject if either the seat_number or the CID is already used on
  // this exam. Every seat must map to exactly one CID and vice versa.
  const clash = await queryOne<{ seat_number: string; cid: string }>(
    `SELECT seat_number, cid FROM submissions
     WHERE exam_id = $1 AND (seat_number = $2 OR cid = $3)
     LIMIT 1`,
    [examId, seat, cid],
  );
  if (clash) {
    if (clash.seat_number === seat && clash.cid === cid) {
      throw new Error(`Seat ${seat} with CID ${cid} is already in this exam`);
    }
    if (clash.seat_number === seat) {
      throw new Error(
        `Seat ${seat} is already in this exam (currently linked to CID ${clash.cid})`,
      );
    }
    throw new Error(
      `CID ${cid} is already in this exam (currently on seat ${clash.seat_number})`,
    );
  }

  await query(
    `INSERT INTO submissions (exam_id, seat_number, cid) VALUES ($1, $2, $3)`,
    [examId, seat, cid],
  );

  revalidatePath(`/admin/exams/${examId}`);
}

export async function addSeatActionState(
  examId: number,
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  try {
    await addSeatAction(examId, formData);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

export async function deleteSeatAction(examId: number, submissionId: number) {
  await query("DELETE FROM submissions WHERE id = $1 AND exam_id = $2", [
    submissionId,
    examId,
  ]);
  revalidatePath(`/admin/exams/${examId}`);
}

export async function deleteExamAction(examId: number, formData: FormData) {
  const exam = await queryOne<Exam>("SELECT name FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) return;
  const typed = String(formData.get("confirm_name") ?? "").trim();
  if (typed !== exam.name) {
    throw new Error(
      `Type the exam name exactly to confirm deletion. Got "${typed}", expected "${exam.name}".`,
    );
  }
  await query("DELETE FROM exams WHERE id = $1", [examId]);
  redirect("/admin");
}

export async function startPrimaryMarkingAction(examId: number) {
  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) throw new Error("Exam not found");
  if (exam.status !== "setup") {
    throw new Error("Marking has already started for this exam");
  }
  if (!exam.primary_marker_id) {
    throw new Error("Primary marker is not set");
  }

  const seats = await queryOne<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM submissions WHERE exam_id = $1",
    [examId],
  );
  if (!seats || seats.n === 0) {
    throw new Error("Upload seat numbers before starting marking");
  }

  // If MCQ is enabled, every non-absent student must have an MCQ score.
  if (exam.mcq_enabled) {
    const missing = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM submissions
       WHERE exam_id = $1 AND absent = false AND mcq_score IS NULL`,
      [examId],
    );
    if ((missing?.n ?? 0) > 0) {
      throw new Error(
        `MCQ is enabled: ${missing?.n} student(s) still need an MCQ score before primary marking can start.`,
      );
    }
  }

  await query(
    "UPDATE exams SET status = 'primary_marking' WHERE id = $1",
    [examId],
  );

  // Stub email to the primary marker. Will go through real SMTP later.
  const marker = await queryOne<{ email: string; name: string | null }>(
    "SELECT email, name FROM users WHERE id = $1",
    [exam.primary_marker_id],
  );
  if (marker) {
    const origin = await getOrigin();
    await recordEmail(
      buildMarkerEmail({
        kind: "commence",
        markerName: marker.name,
        markerEmail: marker.email,
        examName: exam.name,
        examCode: exam.code,
        role: "primary",
        deadline: exam.primary_deadline_date,
        url: markerUrl(origin, exam.id, exam.primary_access_token),
        examId: exam.id,
      }),
    );
  }

  revalidatePath(`/admin/exams/${examId}`);
}

export async function toggleInSampleAction(
  examId: number,
  submissionId: number,
) {
  const exam = await queryOne<Exam>("SELECT status FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) throw new Error("Exam not found");
  if (exam.status !== "first_marking_review") {
    throw new Error(
      "Sample can only be adjusted while awaiting admin review of first marking",
    );
  }
  await query(
    "UPDATE submissions SET in_sample = NOT in_sample WHERE id = $1 AND exam_id = $2",
    [submissionId, examId],
  );
  revalidatePath(`/admin/exams/${examId}`);
}

export async function startSecondaryMarkingAction(
  examId: number,
  formData: FormData,
) {
  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) throw new Error("Exam not found");
  if (exam.status !== "first_marking_review") {
    throw new Error("Exam is not awaiting admin review");
  }
  const secondaryDeadline = parseFutureDeadline(
    formData.get("secondary_deadline"),
    "Second marker deadline",
  );
  if (!secondaryDeadline) {
    throw new Error(
      "Set a deadline for the second marker before starting second marking",
    );
  }
  const sample = await queryOne<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM submissions WHERE exam_id = $1 AND in_sample = true",
    [examId],
  );
  if (!sample || sample.n === 0) {
    throw new Error("Add at least one seat to the second-marking sample");
  }
  await query(
    `UPDATE exams
     SET status = 'secondary_marking',
         secondary_deadline_date = $1,
         secondary_overdue_notified_at = NULL,
         secondary_late_notified_at = NULL
     WHERE id = $2`,
    [secondaryDeadline, examId],
  );

  // Stub email to the second marker.
  if (exam.secondary_marker_id) {
    const marker = await queryOne<{ email: string; name: string | null }>(
      "SELECT email, name FROM users WHERE id = $1",
      [exam.secondary_marker_id],
    );
    if (marker) {
      const origin = await getOrigin();
      await recordEmail(
        buildMarkerEmail({
          kind: "commence",
          markerName: marker.name,
          markerEmail: marker.email,
          examName: exam.name,
          examCode: exam.code,
          role: "secondary",
          deadline: secondaryDeadline,
          // secondaryDeadline is now a 'YYYY-MM-DD' string
          url: markerUrl(origin, exam.id, exam.secondary_access_token),
          examId: exam.id,
        }),
      );
    }
  }

  revalidatePath(`/admin/exams/${examId}`);
}

export async function regenerateMarkerTokenAction(
  examId: number,
  role: "primary" | "secondary",
) {
  const column =
    role === "primary" ? "primary_access_token" : "secondary_access_token";
  await query(`UPDATE exams SET ${column} = $1 WHERE id = $2`, [
    randomToken(),
    examId,
  ]);
  revalidatePath(`/admin/exams/${examId}`);
}

// State-returning wrappers used by client components with useActionState.
// They convert a thrown Error into { ok:false, error } so the caller can
// render the message inline instead of crashing the page.

export async function adminOverrideGradeActionState(
  examId: number,
  submissionId: number,
  field: "grade" | "secondary_grade" | "final_grade" | "mcq_score",
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  try {
    await adminOverrideGradeAction(examId, submissionId, field, formData);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

export async function setMcqScoreActionState(
  examId: number,
  submissionId: number,
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  try {
    await setMcqScoreAction(examId, submissionId, formData);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

export async function uploadSeatsActionState(
  examId: number,
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  try {
    await uploadSeatsAction(examId, formData);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

export async function updatePrimaryDeadlineActionState(
  examId: number,
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  try {
    await updatePrimaryDeadlineAction(examId, formData);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

export async function updateSecondaryDeadlineActionState(
  examId: number,
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  try {
    await updateSecondaryDeadlineAction(examId, formData);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}
