import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { query, queryOne, type Exam, type Submission } from "@/lib/db";
import { SEAT_ORDER_ASC } from "@/lib/seatSort";
import {
  isPrimaryMarkingPhase,
  isSecondaryMarkingPhase,
} from "@/lib/examStatus";
import { sweepDeadlineStatuses } from "@/lib/deadlines";
import { formatDateOnly } from "@/lib/datetime";
import {
  completeFinalMarkingByTokenAction,
  completePrimaryMarkingByTokenAction,
  completeSecondaryMarkingByTokenAction,
} from "./actions";
import { GradeTable, type GradeRow } from "./GradeTable";
import { MarkerUploadPanel } from "./MarkerUploadPanel";
import { QuickEntryForm } from "./QuickEntryForm";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

async function getOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

type MarkerRole = "primary" | "secondary";

export default async function MarkerByTokenPage({
  params,
}: {
  params: Promise<{ examId: string; token: string }>;
}) {
  const { examId: rawId, token } = await params;
  const examId = Number(rawId);
  if (!Number.isFinite(examId)) notFound();

  const origin = await getOrigin();
  await sweepDeadlineStatuses({ origin, examId });

  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) notFound();

  let role: MarkerRole;
  if (token && token === exam.primary_access_token) role = "primary";
  else if (token && token === exam.secondary_access_token) role = "secondary";
  else notFound();

  const isPrimary = role === "primary";
  const isSecondary = role === "secondary";

  // Primary marker in 'review' status is resolving discrepancies.
  const isResolving = isPrimary && exam.status === "review";

  // Source rows for the table view.
  const rawRows = isResolving
    ? await query<Submission>(
        // Show every row that had a discrepancy at second-marking time,
        // including ones the primary has already resolved -- so the row
        // doesn't vanish after saving and they can edit if needed.
        `SELECT * FROM submissions
         WHERE exam_id = $1
           AND in_sample = true
           AND grade IS DISTINCT FROM secondary_grade
         ORDER BY ${SEAT_ORDER_ASC}`,
        [examId],
      )
    : isSecondary
      ? await query<Submission>(
          // In 'full' sampling mode, second marker sees every seat
          // (including absent students, whose row is unmarkable). In
          // 'standard' mode they only see the sample.
          exam.sampling_mode === "full"
            ? `SELECT * FROM submissions
               WHERE exam_id = $1
               ORDER BY ${SEAT_ORDER_ASC}`
            : `SELECT * FROM submissions
               WHERE exam_id = $1 AND in_sample = true
               ORDER BY ${SEAT_ORDER_ASC}`,
          [examId],
        )
      : await query<Submission>(
          `SELECT * FROM submissions
           WHERE exam_id = $1
           ORDER BY ${SEAT_ORDER_ASC}`,
          [examId],
        );

  const tableRows: GradeRow[] = rawRows.map((r) =>
    isResolving
      ? {
          id: r.id,
          seat_number: r.seat_number,
          current_grade: r.final_grade,
          saved_at: r.final_graded_at,
          current_comment: r.final_comment,
          primary_grade: r.grade,
          primary_comment: r.primary_comment,
          secondary_grade: r.secondary_grade,
          secondary_comment: r.secondary_comment,
          absent: r.absent,
          mcq_score: r.mcq_score,
        }
      : isSecondary
        ? {
            id: r.id,
            seat_number: r.seat_number,
            current_grade: r.secondary_grade,
            saved_at: r.secondary_graded_at,
            current_comment: r.secondary_comment,
            primary_grade: r.grade,
            absent: r.absent,
            mcq_score: r.mcq_score,
          }
        : {
            id: r.id,
            seat_number: r.seat_number,
            current_grade: r.grade,
            saved_at: r.graded_at,
            current_comment: r.primary_comment,
            absent: r.absent,
            mcq_score: r.mcq_score,
          },
  );

  // If an admin is acting (cookie-based identity), they can edit grades on
  // the marker page regardless of the exam phase. Their saves are logged
  // as overrides via the same route.
  const { getActingAdmin } = await import("@/lib/actor");
  const actingAdmin = await getActingAdmin();
  const isAdminOverride = actingAdmin != null;

  // True once the marker has clicked "Submit marks" for their phase.
  // Used to swap the neutral info box for a prominent success banner,
  // suppress the (now-irrelevant) deadline reminder, and freeze the
  // marker view — even an admin acting via the marker URL cannot edit
  // once the marker has submitted; overrides go through /admin/exams/.
  const marksSubmitted =
    !isResolving &&
    ((isPrimary && exam.primary_completed_at != null) ||
      (isSecondary && exam.secondary_completed_at != null));

  const markingOpen =
    !marksSubmitted &&
    (isAdminOverride ||
      isResolving ||
      (isPrimary && isPrimaryMarkingPhase(exam.status)) ||
      (isSecondary && isSecondaryMarkingPhase(exam.status)));

  const myDeadline =
    isPrimary && exam.primary_deadline_date
      ? exam.primary_deadline_date
      : isSecondary && exam.secondary_deadline_date
        ? exam.secondary_deadline_date
        : null;
  const showLateBanner =
    exam.status === "first_marking_late" ||
    exam.status === "second_marking_late";
  const showOverdueBanner =
    !showLateBanner &&
    (exam.status === "first_marking_overdue" ||
      exam.status === "second_marking_overdue");

  // Absent students can never be graded, so exclude them from the
  // "graded / total" ratio and the completeness check.
  const gradableRows = tableRows.filter((r) => !r.absent);
  const total = gradableRows.length;
  const graded = gradableRows.filter((r) => r.current_grade != null).length;
  // Second marker: every seat where their grade differs from the
  // primary marker's must carry a comment before they can submit.
  const secondaryMismatchesMissingComment = isSecondary
    ? gradableRows.filter(
        (r) =>
          r.current_grade != null &&
          r.primary_grade != null &&
          r.current_grade !== r.primary_grade &&
          (r.current_comment ?? "").trim() === "",
      ).length
    : 0;
  const canComplete =
    markingOpen &&
    total > 0 &&
    graded === total &&
    secondaryMismatchesMissingComment === 0;

  const headerText = isResolving
    ? "Discrepancies to review"
    : isSecondary
      ? "second marker"
      : "primary marker";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{exam.name}</h1>
        {exam.code && <p className="text-sm text-slate-600">{exam.code}</p>}
        {isResolving ? (
          <p className="mt-2 text-sm text-slate-600">
            <strong>Final marking.</strong> Review each discrepancy below
            between your grade and the second marker&apos;s, and submit a
            final grade. {graded} of {total} resolved.
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            You are the <strong>{headerText}</strong>. {graded} of {total}{" "}
            {isSecondary ? "sampled seats" : "seats"} graded.
          </p>
        )}
        {myDeadline && !isResolving && !marksSubmitted && (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
              showLateBanner
                ? "border-red-300 bg-red-50 text-red-900"
                : showOverdueBanner
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-slate-200 bg-slate-50 text-slate-700"
            }`}
          >
            <span className="font-semibold">
              {showLateBanner
                ? "Marking is LATE — please submit immediately."
                : showOverdueBanner
                  ? "Marking is OVERDUE — please submit as soon as possible."
                  : "Deadline"}
            </span>{" "}
            <span>
              Your grades must be submitted by the end of{" "}
              <strong>{formatDateOnly(myDeadline)}</strong> (UK time).
            </span>
          </div>
        )}
      </div>

      {marksSubmitted && (
        <div className="rounded-lg border-2 border-green-300 bg-green-50 px-6 py-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl leading-none text-green-700">✓</span>
            <div>
              <h2 className="text-lg font-bold text-green-900">
                Your marks have been submitted
              </h2>
              <p className="mt-1 text-sm text-green-800">
                {isPrimary
                  ? exam.status === "first_marking_review"
                    ? "Thanks. The admin is now reviewing the second-marking sample."
                    : isSecondaryMarkingPhase(exam.status)
                      ? "Thanks. The second marker is now reviewing a sample of your grades."
                      : "Thanks. This exam is now complete."
                  : exam.status === "review"
                    ? "Thanks. The primary marker is reviewing any discrepancies between your grades and theirs."
                    : "Thanks. This exam is now complete."}
              </p>
            </div>
          </div>
        </div>
      )}
      {!markingOpen && !marksSubmitted && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          {isPrimary && exam.status === "setup" && (
            <>The admin hasn&apos;t started marking yet.</>
          )}
          {isSecondary &&
            (exam.status === "setup" ||
              exam.status === "primary_marking" ||
              exam.status === "first_marking_review") && (
              <>The primary marker is still working, or the admin is reviewing the sample. You&apos;ll be notified when it&apos;s your turn.</>
            )}
          {exam.status === "complete" && (
            <>This exam is closed for marker edits.</>
          )}
        </div>
      )}

      {markingOpen && !isResolving && (
        <section className="rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Quick entry</h2>
          <p className="mt-1 text-sm text-slate-600">
            Type a seat number and grade, then press Enter. Grades must be a
            number between 0 and 100 with at most one decimal place (e.g. 70
            or 70.5).
          </p>
          <QuickEntryForm examId={examId} token={token} />
        </section>
      )}

      {markingOpen && !isResolving && (
        <MarkerUploadPanel examId={examId} token={token} />
      )}

      <GradeTable
        examId={examId}
        token={token}
        rows={tableRows}
        isSecondary={isSecondary}
        isResolving={isResolving}
        markingOpen={markingOpen}
        mcqEnabled={exam.mcq_enabled}
      />

      {markingOpen && (
        <section className="rounded-lg border bg-white p-6 shadow-sm">
          {isResolving ? (
            <form
              action={async () => {
                "use server";
                await completeFinalMarkingByTokenAction(examId, token);
              }}
            >
              <SubmitButton
                label="Submit final marks"
                disabled={!canComplete}
                scrollToTop
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              />
              <p className="mt-2 text-xs text-slate-500">
                Marks all discrepancies as resolved and returns the exam to
                Ready for Canvas upload.
              </p>
            </form>
          ) : isPrimary ? (
            <form
              action={async () => {
                "use server";
                await completePrimaryMarkingByTokenAction(examId, token);
              }}
            >
              <SubmitButton
                label="Submit marks"
                disabled={!canComplete}
                scrollToTop
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              />
              <p className="mt-2 text-xs text-slate-500">
                Locks in your grades and hands over to the admin to review the
                second-marking sample before the second marker is notified.
              </p>
            </form>
          ) : (
            <form
              action={async () => {
                "use server";
                await completeSecondaryMarkingByTokenAction(examId, token);
              }}
            >
              <SubmitButton
                label="Submit marks"
                disabled={!canComplete}
                scrollToTop
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              />
              {secondaryMismatchesMissingComment > 0 && (
                <p className="mt-2 text-xs text-red-700">
                  {secondaryMismatchesMissingComment} sampled seat
                  {secondaryMismatchesMissingComment === 1 ? "" : "s"} have a
                  grade that differs from the primary marker&apos;s but no
                  comment. Add a comment on each — on the page or via a CSV
                  upload — before submitting.
                </p>
              )}
              <p className="mt-2 text-xs text-slate-500">
                Locks in your grades. The primary marker will be asked to
                resolve any discrepancies.
              </p>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
