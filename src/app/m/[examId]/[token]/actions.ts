"use server";

import { revalidatePath } from "next/cache";
import { isValidGrade, query, queryOne, type Exam } from "@/lib/db";
import {
  isPrimaryMarkingPhase,
  isSecondaryMarkingPhase,
} from "@/lib/examStatus";
import { computeFinalGrade } from "@/lib/finalGrade";
import { computeSampleIdsForMode } from "@/lib/sampling";
import { parseCsv as parseCsvText } from "@/lib/csv";
import { type SaveState, toErrorState } from "@/lib/actionState";

type MarkerRole = "primary" | "secondary";

type AccessContext = { exam: Exam; role: MarkerRole };

async function authorize(
  examId: number,
  token: string,
): Promise<AccessContext> {
  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) throw new Error("Exam not found");
  if (!token) throw new Error("Missing access token");
  if (token === exam.primary_access_token) return { exam, role: "primary" };
  if (token === exam.secondary_access_token) return { exam, role: "secondary" };
  throw new Error("Invalid access token");
}

// A marker is "in their phase" if the exam is in their active marking
// status OR an overdue/late variant of it. Overdue/late doesn't block the
// marker -- they can still save and complete grades.
function isInMarkerPhase(
  role: MarkerRole,
  status: Exam["status"],
): boolean {
  return role === "primary"
    ? isPrimaryMarkingPhase(status)
    : isSecondaryMarkingPhase(status);
}

export async function saveGradesByTokenAction(
  examId: number,
  token: string,
  updates: { id: number; grade: string; comment?: string | null }[],
): Promise<{ id: number; saved_at: string | null }[]> {
  const { exam, role } = await authorize(examId, token);
  const isPrimary = role === "primary";

  // If an admin identity cookie is present, treat this as an override
  // save: bypass phase gating and stamp an override note on each row.
  const { getActingAdmin } = await import("@/lib/actor");
  const actingAdmin = await getActingAdmin();
  const isAdminOverride = actingAdmin != null;

  // Marker phase write OR primary marker resolving review discrepancies.
  const inMarkingPhase = isInMarkerPhase(role, exam.status);
  const inResolutionPhase = isPrimary && exam.status === "review";
  if (!isAdminOverride && !inMarkingPhase && !inResolutionPhase) {
    throw new Error("Marking is not currently open for you on this exam");
  }

  const ids = updates.map((u) => u.id);
  if (ids.length === 0) return [];

  for (const u of updates) {
    if (!isValidGrade(u.grade.trim())) {
      throw new Error(
        `Grade "${u.grade}" must be a number between 0 and 100 with at most one decimal place`,
      );
    }
  }

  const rows = await query<{
    id: number;
    in_sample: boolean;
    grade: string | null;
    secondary_grade: string | null;
    absent: boolean;
  }>(
    `SELECT id, in_sample, grade, secondary_grade, absent FROM submissions
     WHERE exam_id = $1 AND id = ANY($2::int[])`,
    [examId, ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Silently drop absent-student rows so callers (individual saves and
  // CSV upload) get consistent behaviour: their grade is ignored, but
  // everything else in the batch still saves.
  const filteredUpdates = updates.filter((u) => {
    const row = byId.get(u.id);
    return row ? !row.absent : true;
  });
  for (const u of filteredUpdates) {
    const row = byId.get(u.id);
    if (!row) throw new Error(`Submission ${u.id} not found for this exam`);
    if (role === "secondary" && !row.in_sample) {
      throw new Error("One or more seats are not in the second-marking sample");
    }
    if (inResolutionPhase) {
      // Primary resolution: only allowed on rows that need it (mismatch in
      // sample). Marking other rows risks rewriting confirmed final grades.
      if (!row.in_sample || row.grade === row.secondary_grade) {
        throw new Error("That seat does not need primary-marker review");
      }
    }
    // Secondary marker giving a grade that doesn't match the primary's must
    // provide a comment. Admin override skips this check.
    if (
      role === "secondary" &&
      !inResolutionPhase &&
      !isAdminOverride
    ) {
      const newGrade = u.grade.trim();
      const primaryGrade = row.grade;
      if (
        newGrade !== "" &&
        primaryGrade != null &&
        newGrade !== primaryGrade
      ) {
        const c = (u.comment ?? "").trim();
        if (c === "") {
          throw new Error(
            `Seat ${row.id}: your grade differs from the primary marker's, please add a comment before saving.`,
          );
        }
      }
    }
  }

  const results: { id: number; saved_at: string | null }[] = [];
  for (const { id, grade, comment } of filteredUpdates) {
    const raw = grade.trim();
    const commentTrim = comment == null ? null : comment.trim();
    const finalComment = commentTrim === "" ? null : commentTrim;

    if (inResolutionPhase) {
      // Resolution phase saves into separate final_* columns so the
      // marker's original primary grade, comment and timestamp are
      // preserved for the audit trail.
      if (raw === "") {
        await query(
          `UPDATE submissions
           SET final_grade = NULL,
               final_comment = $1,
               final_graded_at = NULL
           WHERE id = $2`,
          [finalComment, id],
        );
        results.push({ id, saved_at: null });
      } else {
        const r = await queryOne<{ final_graded_at: string }>(
          `UPDATE submissions
           SET final_grade = $1,
               final_comment = $2,
               final_graded_at = now()
           WHERE id = $3 RETURNING final_graded_at`,
          [raw, finalComment, id],
        );
        results.push({ id, saved_at: r?.final_graded_at ?? null });
      }
    } else if (isPrimary) {
      if (raw === "") {
        await query(
          "UPDATE submissions SET grade = NULL, graded_at = NULL, primary_comment = $2 WHERE id = $1",
          [id, finalComment],
        );
        results.push({ id, saved_at: null });
      } else {
        const r = await queryOne<{ graded_at: string }>(
          `UPDATE submissions
           SET grade = $1, graded_at = now(), primary_comment = $2
           WHERE id = $3 RETURNING graded_at`,
          [raw, finalComment, id],
        );
        results.push({ id, saved_at: r?.graded_at ?? null });
      }
    } else {
      if (raw === "") {
        await query(
          "UPDATE submissions SET secondary_grade = NULL, secondary_graded_at = NULL, secondary_comment = $2 WHERE id = $1",
          [id, finalComment],
        );
        results.push({ id, saved_at: null });
      } else {
        const r = await queryOne<{ secondary_graded_at: string }>(
          `UPDATE submissions
           SET secondary_grade = $1, secondary_graded_at = now(), secondary_comment = $2
           WHERE id = $3 RETURNING secondary_graded_at`,
          [raw, finalComment, id],
        );
        results.push({ id, saved_at: r?.secondary_graded_at ?? null });
      }
    }
  }

  // Stamp an override note on every affected row when an admin was
  // acting. The note surfaces on the audit CSV so we retain the who and
  // when even after the value is later overwritten by a marker.
  if (isAdminOverride && actingAdmin && filteredUpdates.length > 0) {
    const ts = new Date().toISOString();
    const note = `Grade was changed by Admin user ${actingAdmin.name} on ${ts} (via marker page ${role})`;
    for (const { id } of filteredUpdates) {
      await query(
        `UPDATE submissions
         SET override_note = COALESCE(override_note || E'\\n', '') || $1
         WHERE id = $2`,
        [note, id],
      );
    }
  }

  revalidatePath(`/m/${examId}/${token}`);
  return results;
}

export async function setGradeBySeatByTokenAction(
  examId: number,
  token: string,
  formData: FormData,
) {
  const { exam, role } = await authorize(examId, token);
  if (!isInMarkerPhase(role, exam.status)) {
    throw new Error("Marking is not currently open for you on this exam");
  }
  const seat = String(formData.get("seat") ?? "").trim();
  const grade = String(formData.get("grade") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (!seat) return;
  if (!isValidGrade(grade)) {
    throw new Error(
      "Grade must be a number between 0 and 100 with at most one decimal place",
    );
  }

  let row = await queryOne<{ id: number; in_sample: boolean; absent: boolean }>(
    "SELECT id, in_sample, absent FROM submissions WHERE exam_id = $1 AND seat_number = $2",
    [examId, seat],
  );
  // Fall back to a natural-number match so "01" finds "1" (and vice versa)
  // when the typed value is all-digits and fits safely in bigint.
  if (!row && /^[0-9]{1,18}$/.test(seat)) {
    row = await queryOne<{ id: number; in_sample: boolean; absent: boolean }>(
      `SELECT id, in_sample, absent FROM submissions
       WHERE exam_id = $1
         AND seat_number ~ '^[0-9]+$'
         AND length(seat_number) <= 18
         AND seat_number::bigint = $2::bigint`,
      [examId, seat],
    );
  }
  if (!row) throw new Error(`Seat ${seat} not found for this exam`);
  if (row.absent) {
    throw new Error(`Seat ${seat} is marked absent; grade ignored`);
  }
  if (role === "secondary" && !row.in_sample) {
    throw new Error(`Seat ${seat} is not in the second-marking sample`);
  }

  await saveGradesByTokenAction(examId, token, [
    { id: row.id, grade, comment },
  ]);
}

// CSV upload for markers. Expected headers: Seat number, Grade, Comments.
//
// Semantics are patch, not full-replace: a blank Grade cell leaves the
// existing grade alone, a blank Comments cell leaves the existing
// comment alone. This lets a marker upload a grades-only CSV without
// wiping comments they typed on the page, and vice versa.
//
// Seat lookup is natural-number tolerant so "01" in the CSV finds the
// seat stored as "1" (and vice versa). Rows for absent students are
// silently ignored; everything else that can't be applied lands in
// `skipped` for the user to review.
export async function uploadGradesCsvByTokenAction(
  examId: number,
  token: string,
  formData: FormData,
): Promise<{ saved: number; ignoredAbsent: number; skipped: string[] }> {
  const { exam, role } = await authorize(examId, token);
  const isPrimary = role === "primary";

  const { getActingAdmin } = await import("@/lib/actor");
  const actingAdmin = await getActingAdmin();
  const isAdminOverride = actingAdmin != null;

  const inMarkingPhase = isInMarkerPhase(role, exam.status);
  const inResolutionPhase = isPrimary && exam.status === "review";
  if (!isAdminOverride && !inMarkingPhase && !inResolutionPhase) {
    throw new Error("Marking is not currently open for you on this exam");
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("No file uploaded");
  }
  const text = await file.text();
  const rows = parseCsvText(text);
  if (rows.length === 0) throw new Error("CSV is empty");

  const first = rows[0].map((s) => s.trim().toLowerCase());
  const hasHeader = first.some((c) => /seat|grade|comment/i.test(c));
  let seatIdx = 0;
  let gradeIdx = 1;
  let commentIdx = 2;
  let start = 0;
  if (hasHeader) {
    start = 1;
    const findIdx = (patterns: RegExp[]) =>
      first.findIndex((c) => patterns.some((p) => p.test(c)));
    const s = findIdx([/seat/i]);
    const g = findIdx([/^grade\b/i, /^mark\b/i]);
    const c = findIdx([/^comment/i]);
    if (s >= 0) seatIdx = s;
    if (g >= 0) gradeIdx = g;
    if (c >= 0) commentIdx = c;
  }

  const allRows = await query<{
    id: number;
    seat_number: string;
    in_sample: boolean;
    absent: boolean;
    grade: string | null;
    secondary_grade: string | null;
    secondary_comment: string | null;
  }>(
    `SELECT id, seat_number, in_sample, absent, grade, secondary_grade,
            secondary_comment
     FROM submissions WHERE exam_id = $1`,
    [examId],
  );

  // Two indexes so "01" in the CSV finds a DB seat stored as "1"
  // (and vice versa) without treating different non-numeric seats as
  // equivalent.
  const canonical = (s: string): string | null =>
    /^[0-9]+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : null;
  const bySeat = new Map(allRows.map((r) => [r.seat_number, r]));
  const byNumericSeat = new Map<string, (typeof allRows)[number]>();
  for (const r of allRows) {
    const key = canonical(r.seat_number);
    if (key !== null) byNumericSeat.set(key, r);
  }
  const resolveSeat = (input: string) => {
    const exact = bySeat.get(input);
    if (exact) return exact;
    const key = canonical(input);
    return key === null ? undefined : byNumericSeat.get(key);
  };

  const skipped: string[] = [];
  let ignoredAbsent = 0;
  let saved = 0;
  const overriddenIds: number[] = [];

  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const seat = (r[seatIdx] ?? "").trim();
    if (!seat) continue;
    const gradeCell = (r[gradeIdx] ?? "").trim();
    const commentCell = (r[commentIdx] ?? "").trim();
    const hasGrade = gradeCell !== "";
    const hasComment = commentCell !== "";
    if (!hasGrade && !hasComment) continue;

    const row = resolveSeat(seat);
    if (!row) {
      skipped.push(`Seat ${seat}: not in exam`);
      continue;
    }
    if (row.absent) {
      ignoredAbsent++;
      continue;
    }
    if (role === "secondary" && !row.in_sample && !isAdminOverride) {
      skipped.push(`Seat ${seat}: not in second-marking sample`);
      continue;
    }
    if (hasGrade && !isValidGrade(gradeCell)) {
      skipped.push(
        `Seat ${seat}: grade "${gradeCell}" must be a number between 0 and 100 with at most one decimal place`,
      );
      continue;
    }
    if (inResolutionPhase) {
      if (!row.in_sample || row.grade === row.secondary_grade) {
        skipped.push(`Seat ${seat}: not a discrepancy that needs review`);
        continue;
      }
    }
    // Secondary marker giving a grade that differs from primary must
    // provide a comment. Under patch semantics the resulting comment is
    // the new one if supplied, else the existing one on the row.
    if (
      role === "secondary" &&
      !inResolutionPhase &&
      !isAdminOverride &&
      hasGrade &&
      row.grade != null &&
      gradeCell !== row.grade
    ) {
      const effective = hasComment
        ? commentCell
        : (row.secondary_comment ?? "");
      if (effective.trim() === "") {
        skipped.push(
          `Seat ${seat}: your grade differs from the primary marker's, please add a comment before saving.`,
        );
        continue;
      }
    }

    const setParts: string[] = [];
    const params: (string | number)[] = [];
    let idx = 1;
    if (inResolutionPhase) {
      if (hasGrade) {
        setParts.push(`final_grade = $${idx++}`);
        params.push(gradeCell);
        setParts.push(`final_graded_at = now()`);
      }
      if (hasComment) {
        setParts.push(`final_comment = $${idx++}`);
        params.push(commentCell);
      }
    } else if (isPrimary) {
      if (hasGrade) {
        setParts.push(`grade = $${idx++}`);
        params.push(gradeCell);
        setParts.push(`graded_at = now()`);
      }
      if (hasComment) {
        setParts.push(`primary_comment = $${idx++}`);
        params.push(commentCell);
      }
    } else {
      if (hasGrade) {
        setParts.push(`secondary_grade = $${idx++}`);
        params.push(gradeCell);
        setParts.push(`secondary_graded_at = now()`);
      }
      if (hasComment) {
        setParts.push(`secondary_comment = $${idx++}`);
        params.push(commentCell);
      }
    }
    if (setParts.length === 0) continue;
    params.push(row.id);
    await query(
      `UPDATE submissions SET ${setParts.join(", ")} WHERE id = $${idx}`,
      params,
    );
    saved++;
    if (isAdminOverride) overriddenIds.push(row.id);
  }

  if (isAdminOverride && actingAdmin && overriddenIds.length > 0) {
    const ts = new Date().toISOString();
    const note = `Grade was changed by Admin user ${actingAdmin.name} on ${ts} (via marker page ${role} CSV upload)`;
    for (const id of overriddenIds) {
      await query(
        `UPDATE submissions
         SET override_note = COALESCE(override_note || E'\\n', '') || $1
         WHERE id = $2`,
        [note, id],
      );
    }
  }

  revalidatePath(`/m/${examId}/${token}`);
  return { saved, ignoredAbsent, skipped };
}

// Clear every grade + comment written by the current marker for this exam.
// Locked once the marker has clicked their 'Marking Complete' button.
export async function clearMarksByTokenAction(
  examId: number,
  token: string,
) {
  const { exam, role } = await authorize(examId, token);
  if (!isInMarkerPhase(role, exam.status)) {
    throw new Error("Marking is not open — cannot clear grades now");
  }
  if (role === "primary") {
    await query(
      `UPDATE submissions
       SET grade = NULL, graded_at = NULL, primary_comment = NULL
       WHERE exam_id = $1`,
      [examId],
    );
  } else {
    await query(
      `UPDATE submissions
       SET secondary_grade = NULL,
           secondary_graded_at = NULL,
           secondary_comment = NULL
       WHERE exam_id = $1`,
      [examId],
    );
  }
  revalidatePath(`/m/${examId}/${token}`);
}

// Primary marker finishes first-pass marking.
// Server picks the initial sample using the exam's sampling_mode, sets status
// to first_marking_review so the admin can adjust the sample before the
// second marker is notified.
export async function completePrimaryMarkingByTokenAction(
  examId: number,
  token: string,
) {
  const { exam, role } = await authorize(examId, token);
  if (role !== "primary") throw new Error("Primary marker only");
  if (!isPrimaryMarkingPhase(exam.status)) {
    throw new Error("Primary marking is not currently in progress");
  }

  // Only non-absent students need grades and are eligible for sampling.
  const subs = await query<{ id: number; grade: string | null }>(
    "SELECT id, grade FROM submissions WHERE exam_id = $1 AND absent = false ORDER BY id",
    [examId],
  );
  const ungraded = subs.filter((s) => s.grade == null).length;
  if (ungraded > 0) {
    throw new Error(`${ungraded} seat(s) still need a grade before completion`);
  }

  // Load programme level to pick the right fail threshold.
  const programme = exam.programme_id
    ? await queryOne<{ level: "MSc" | "MBA" | "MRes" | "PhD" | "BSc" }>(
        "SELECT level FROM programmes WHERE id = $1",
        [exam.programme_id],
      )
    : null;
  const sampleIds = computeSampleIdsForMode(
    subs,
    exam.sampling_mode,
    programme?.level ?? null,
  );
  await query("UPDATE submissions SET in_sample = false WHERE exam_id = $1", [
    examId,
  ]);
  if (sampleIds.length > 0) {
    await query(
      "UPDATE submissions SET in_sample = true WHERE id = ANY($1::int[])",
      [sampleIds],
    );
  }

  await query(
    `UPDATE exams
     SET status = 'first_marking_review', primary_completed_at = now()
     WHERE id = $1`,
    [examId],
  );

  revalidatePath(`/m/${examId}/${token}`);
  revalidatePath(`/admin/exams/${examId}`);
}

// Secondary marker finishes second-pass marking.
// Computes final grades using exact-match rule. If any sampled row has a
// mismatch, status moves to 'review' so the primary marker can resolve.
export async function completeSecondaryMarkingByTokenAction(
  examId: number,
  token: string,
) {
  const { exam, role } = await authorize(examId, token);
  if (role !== "secondary") throw new Error("Secondary marker only");
  if (!isSecondaryMarkingPhase(exam.status)) {
    throw new Error("Secondary marking is not currently in progress");
  }

  const ungraded = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM submissions
     WHERE exam_id = $1 AND in_sample = true AND absent = false
       AND secondary_grade IS NULL`,
    [examId],
  );
  if (ungraded && ungraded.n > 0) {
    throw new Error(
      `${ungraded.n} sampled seat(s) still need a second-marker grade`,
    );
  }

  // Every mismatched sampled seat must carry a comment explaining
  // the discrepancy before the second marker can submit.
  const missing = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM submissions
     WHERE exam_id = $1 AND in_sample = true AND absent = false
       AND grade IS NOT NULL AND secondary_grade IS NOT NULL
       AND grade <> secondary_grade
       AND (secondary_comment IS NULL OR btrim(secondary_comment) = '')`,
    [examId],
  );
  if (missing && missing.n > 0) {
    throw new Error(
      `${missing.n} sampled seat(s) have a grade that differs from the primary marker's but no comment. Add a comment explaining the discrepancy before submitting.`,
    );
  }

  const subs = await query<{
    id: number;
    grade: string | null;
    secondary_grade: string | null;
    in_sample: boolean;
    absent: boolean;
  }>(
    `SELECT id, grade, secondary_grade, in_sample, absent FROM submissions
     WHERE exam_id = $1`,
    [examId],
  );
  let unresolved = 0;
  for (const s of subs) {
    if (s.absent) {
      // Absent students get no final grade -- Canvas import will leave
      // them blank. Doesn't count as unresolved.
      await query(
        "UPDATE submissions SET final_grade = NULL WHERE id = $1",
        [s.id],
      );
      continue;
    }
    const { value } = computeFinalGrade(s.grade, s.secondary_grade, s.in_sample);
    if (value === null) unresolved++;
    await query("UPDATE submissions SET final_grade = $1 WHERE id = $2", [
      value,
      s.id,
    ]);
  }

  await query(
    `UPDATE exams
     SET status = $1, secondary_completed_at = now()
     WHERE id = $2`,
    [unresolved > 0 ? "review" : "complete", examId],
  );

  revalidatePath(`/m/${examId}/${token}`);
  revalidatePath(`/admin/exams/${examId}`);
}

// Primary marker confirms they've resolved all discrepancies. Flips status
// back to 'complete' so the Canvas CSV can be downloaded.
export async function completeFinalMarkingByTokenAction(
  examId: number,
  token: string,
) {
  const { exam, role } = await authorize(examId, token);
  if (role !== "primary") throw new Error("Primary marker only");
  if (exam.status !== "review") {
    throw new Error("Final marking is not currently in progress");
  }
  const remaining = await queryOne<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM submissions WHERE exam_id = $1 AND absent = false AND final_grade IS NULL",
    [examId],
  );
  if ((remaining?.n ?? 0) > 0) {
    throw new Error(
      `${remaining?.n} seat(s) still need a final grade`,
    );
  }
  await query("UPDATE exams SET status = 'complete' WHERE id = $1", [examId]);
  revalidatePath(`/m/${examId}/${token}`);
  revalidatePath(`/admin/exams/${examId}`);
}

// State-returning wrapper for the marker Quick Entry form. Turns thrown
// validation errors into an inline message the client can render.
export async function setGradeBySeatByTokenActionState(
  examId: number,
  token: string,
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  try {
    await setGradeBySeatByTokenAction(examId, token, formData);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

// State-returning wrappers around the three "Submit marks" completion
// actions. Server-side validation throws (e.g. "N sampled seats have
// a grade that differs from the primary marker's but no comment...")
// are caught here so the marker page can render a friendly inline
// message instead of Next.js's default "Server Components render"
// error box.
export async function completePrimaryMarkingByTokenActionState(
  examId: number,
  token: string,
  _prev: SaveState,
  _formData: FormData,
): Promise<SaveState> {
  try {
    await completePrimaryMarkingByTokenAction(examId, token);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

export async function completeSecondaryMarkingByTokenActionState(
  examId: number,
  token: string,
  _prev: SaveState,
  _formData: FormData,
): Promise<SaveState> {
  try {
    await completeSecondaryMarkingByTokenAction(examId, token);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}

export async function completeFinalMarkingByTokenActionState(
  examId: number,
  token: string,
  _prev: SaveState,
  _formData: FormData,
): Promise<SaveState> {
  try {
    await completeFinalMarkingByTokenAction(examId, token);
    return { ok: true, error: null };
  } catch (e) {
    return toErrorState(e);
  }
}
