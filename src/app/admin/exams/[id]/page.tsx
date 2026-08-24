import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  EXAM_STATUS_LABEL,
  query,
  queryOne,
  type Exam,
  type Submission,
  type User,
} from "@/lib/db";
import { STATUS_BADGE_CLASS } from "@/lib/examStatus";
import { sweepDeadlineStatuses } from "@/lib/deadlines";
import {
  adminOverrideGradeActionState,
  deleteSeatAction,
  reassignMarkerAction,
  regenerateMarkerTokenAction,
  resetSeatsAction,
  setMcqScoreActionState,
  startPrimaryMarkingAction,
  startSecondaryMarkingAction,
  updateMcqWeightingAction,
  updatePrimaryDeadlineActionState,
  updateSecondaryDeadlineActionState,
} from "../../actions";
import { AbsenceToggleButton } from "./AbsenceToggleButton";
import { AddSeatForm } from "./AddSeatForm";
import { DeadlineForm } from "./DeadlineForm";
import { InlineSaveForm } from "./InlineSaveForm";
import { ResetSeatsForm } from "./ResetSeatsForm";
import { SampleToggle } from "./SampleToggle";
import { SeatUploadForm } from "./SeatUploadForm";
import { SubmitButton } from "@/components/SubmitButton";
import { computeWeightedGrade } from "@/lib/weighted";
import {
  CID_ORDER_ASC,
  CID_ORDER_DESC,
  SEAT_ORDER_ASC,
  SEAT_ORDER_DESC,
} from "@/lib/seatSort";
import { McqUploadPanel } from "./McqUploadPanel";
import { DeleteExamForm } from "./DeleteExamForm";
import { formatDateOnly, formatDateTime, todayUkIsoDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

async function getOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

type SeatSortKey =
  | "seat_asc"
  | "seat_desc"
  | "cid_asc"
  | "cid_desc"
  | "mcq_asc"
  | "mcq_desc"
  | "grade_asc"
  | "grade_desc"
  | "secondary_asc"
  | "secondary_desc"
  | "final_asc"
  | "final_desc";

const SEAT_SORT_SQL: Record<SeatSortKey, string> = {
  seat_asc: SEAT_ORDER_ASC,
  seat_desc: SEAT_ORDER_DESC,
  cid_asc: CID_ORDER_ASC,
  cid_desc: CID_ORDER_DESC,
  mcq_asc: "NULLIF(mcq_score, '')::float NULLS LAST, seat_number",
  mcq_desc: "NULLIF(mcq_score, '')::float DESC NULLS LAST, seat_number",
  grade_asc: "NULLIF(grade, '')::float NULLS LAST, seat_number",
  grade_desc: "NULLIF(grade, '')::float DESC NULLS LAST, seat_number",
  secondary_asc:
    "NULLIF(secondary_grade, '')::float NULLS LAST, seat_number",
  secondary_desc:
    "NULLIF(secondary_grade, '')::float DESC NULLS LAST, seat_number",
  final_asc: "NULLIF(final_grade, '')::float NULLS LAST, seat_number",
  final_desc:
    "NULLIF(final_grade, '')::float DESC NULLS LAST, seat_number",
};

function parseSeatSort(v: string | undefined): SeatSortKey {
  if (v && v in SEAT_SORT_SQL) return v as SeatSortKey;
  return "seat_asc";
}

export default async function AdminExamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const examId = Number(id);
  if (!Number.isFinite(examId)) notFound();
  const seatSort = parseSeatSort(sp.sort);

  const origin = await getOrigin();
  await sweepDeadlineStatuses({ origin, examId });

  const exam = await queryOne<Exam>("SELECT * FROM exams WHERE id = $1", [
    examId,
  ]);
  if (!exam) notFound();
  const primaryUrl = exam.primary_access_token
    ? `${origin}/m/${exam.id}/${exam.primary_access_token}`
    : null;
  const secondaryUrl = exam.secondary_access_token
    ? `${origin}/m/${exam.id}/${exam.secondary_access_token}`
    : null;

  const submissions = await query<Submission>(
    `SELECT * FROM submissions WHERE exam_id = $1 ORDER BY ${SEAT_SORT_SQL[seatSort]}`,
    [examId],
  );
  const programme = exam.programme_id
    ? ((await queryOne<import("@/lib/db").Programme>(
        "SELECT * FROM programmes WHERE id = $1",
        [exam.programme_id],
      )) ?? null)
    : null;
  const primaryMarker = exam.primary_marker_id
    ? ((await queryOne<User>("SELECT * FROM users WHERE id = $1", [
        exam.primary_marker_id,
      ])) ?? null)
    : null;
  const secondaryMarker = exam.secondary_marker_id
    ? ((await queryOne<User>("SELECT * FROM users WHERE id = $1", [
        exam.secondary_marker_id,
      ])) ?? null)
    : null;

  const totalSeats = submissions.length;
  const primaryGraded = submissions.filter((s) => s.grade !== null).length;
  const sampleCount = submissions.filter((s) => s.in_sample).length;
  const secondaryGraded = submissions.filter(
    (s) => s.in_sample && s.secondary_grade !== null,
  ).length;
  const showFinalColumn =
    exam.status === "review" || exam.status === "complete";
  const canStartMarking =
    exam.status === "setup" && totalSeats > 0 && exam.primary_marker_id;
  const isFirstMarkingReview = exam.status === "first_marking_review";
  const canDownloadCsv = exam.status === "complete";

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <Link href="/admin" className="text-sm text-blue-600 hover:underline">
            ← All exams
          </Link>
          <h1 className="mt-1 text-2xl font-bold">{exam.name}</h1>
          {exam.code && <p className="text-sm text-slate-600">{exam.code}</p>}
          {programme && (
            <p className="text-sm text-slate-600">
              {programme.name}{" "}
              <span className="text-slate-400">
                ({programme.programme_id}, {programme.level})
              </span>
            </p>
          )}
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={exam.status} />
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                exam.is_resit
                  ? "bg-orange-100 text-orange-800"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {exam.is_resit ? "Resit" : "Main sitting"}
            </span>
            <span className="text-xs text-slate-500">
              {exam.sampling_mode === "full"
                ? "Full second marking"
                : "Standard sampling (10% + boundaries)"}
            </span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {canDownloadCsv ? (
            <a
              href={`/api/exams/${exam.id}/canvas.csv`}
              className="rounded border bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
            >
              Download Canvas CSV
            </a>
          ) : (
            <span
              className="rounded border bg-slate-50 px-3 py-2 text-sm text-slate-400"
              title="Available once every seat has a final grade"
            >
              Download Canvas CSV
            </span>
          )}
          <a
            href={`/api/exams/${exam.id}/audit.csv`}
            className="rounded border bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Download audit CSV
          </a>
        </div>
      </div>

      {isFirstMarkingReview && (
        <div className="rounded-lg border border-purple-300 bg-purple-50 p-4">
          <h3 className="font-semibold text-purple-900">
            Review the second-marking sample
          </h3>
          <p className="mt-1 text-sm text-purple-800">
            {sampleCount} of {totalSeats} seats are currently selected for
            second marking. Tick or untick the checkbox on any row below to
            add or remove a seat. Check the second marker deadline and update
            if required. When you&apos;re happy, click{" "}
            <em>Start second marking</em>.
          </p>
          <form
            action={async (fd) => {
              "use server";
              await startSecondaryMarkingAction(exam.id, fd);
            }}
            className="mt-3 flex flex-wrap items-end gap-3"
          >
            <label className="text-sm">
              <span className="block text-xs font-medium text-purple-900">
                Second marker deadline
              </span>
              <input
                type="date"
                name="secondary_deadline"
                defaultValue={exam.secondary_deadline_date ?? ""}
                min={todayUkIsoDate()}
                required
                className="mt-1 rounded border px-2 py-1 text-sm"
              />
            </label>
            <SubmitButton
              label="Start second marking → notify second marker"
              disabled={sampleCount === 0}
              className="rounded bg-purple-700 px-3 py-2 text-sm font-medium text-white hover:bg-purple-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            />
          </form>
        </div>
      )}

      {exam.status === "review" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h3 className="font-semibold text-amber-900">
            Awaiting primary marker review of discrepancies
          </h3>
          <p className="mt-1 text-sm text-amber-800">
            The primary marker has been notified to resolve each discrepancy
            below. When they finish, the exam returns to <em>Ready for Canvas upload</em>.
          </p>
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <MarkerCard
          role="primary"
          examId={exam.id}
          marker={primaryMarker}
          completedAt={exam.primary_completed_at}
          shareUrl={primaryUrl}
          status={exam.status}
        />
        <MarkerCard
          role="secondary"
          examId={exam.id}
          marker={secondaryMarker}
          completedAt={exam.secondary_completed_at}
          shareUrl={secondaryUrl}
          status={exam.status}
        />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">
            Primary marker deadline
          </p>
          {exam.primary_deadline_date && (
            <p className="mt-1 font-medium">
              End of {formatDateOnly(exam.primary_deadline_date)} (UK time)
            </p>
          )}
          <DeadlineForm
            action={updatePrimaryDeadlineActionState.bind(null, exam.id)}
            name="primary_deadline"
            defaultValue={exam.primary_deadline_date ?? ""}
            helper="Deadline is end of that day, UK time."
          />
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">
            Second marker deadline
          </p>
          {exam.secondary_deadline_date && (
            <p className="mt-1 font-medium">
              End of {formatDateOnly(exam.secondary_deadline_date)} (UK time)
            </p>
          )}
          <DeadlineForm
            action={updateSecondaryDeadlineActionState.bind(null, exam.id)}
            name="secondary_deadline"
            defaultValue={exam.secondary_deadline_date ?? ""}
            helper="Deadline is end of that day, UK time."
          />
        </div>
      </section>

      {exam.status === "setup" && (
        <section className="rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Seats (seat → CID)</h2>
          <p className="mt-1 text-sm text-slate-600">
            Upload a two-column CSV (headers <code>CID</code> and{" "}
            <code>Seat number</code>, in either order) or add a single row.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <a
              href={`/api/exams/${exam.id}/seats-template.csv`}
              className="text-xs text-blue-600 hover:underline"
            >
              Download blank template CSV
            </a>
            <ResetSeatsForm examId={exam.id} count={totalSeats} />
          </div>
          <SeatUploadForm examId={exam.id} />

          <AddSeatForm examId={exam.id} />

          {canStartMarking && (
            <form
              action={async () => {
                "use server";
                await startPrimaryMarkingAction(exam.id);
              }}
              className="mt-6 border-t pt-4"
            >
              <SubmitButton
                label="Start primary marking"
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              />
              <p className="mt-2 text-xs text-slate-500">
                Sampling mode locks at this point. Send the primary marker URL
                shown above to {primaryMarker?.email ?? "the primary marker"}.
              </p>
            </form>
          )}
        </section>
      )}

      {exam.mcq_enabled && (
        <section className="rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">MCQ element</h2>
          <p className="mt-1 text-sm text-slate-600">
            MCQ scores contribute to each student&apos;s weighted grade at
            the configured weighting. Weighting can be updated at any time.
          </p>
          <form
            action={async (fd) => {
              "use server";
              await updateMcqWeightingAction(exam.id, fd);
            }}
            className="mt-3 flex flex-wrap items-end gap-2"
          >
            <label className="text-sm">
              <span className="block text-xs font-medium text-slate-600">
                Weighting (%)
              </span>
              <input
                name="mcq_weighting"
                type="text"
                defaultValue={exam.mcq_weighting ?? ""}
                pattern="^\d+(\.\d{1,2})?$"
                inputMode="decimal"
                className="mt-1 w-40 rounded border px-3 py-2 text-sm"
              />
            </label>
            <SubmitButton
              label="Save weighting"
              className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
            />
          </form>
          {exam.status === "setup" && (
            <div className="mt-4">
              <McqUploadPanel examId={exam.id} />
            </div>
          )}
        </section>
      )}

      <section className="rounded-lg border bg-white shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="text-lg font-semibold">
            All seats ({totalSeats}) · primary {primaryGraded}/{totalSeats}
            {sampleCount > 0 && (
              <span className="text-slate-500">
                {" "}
                · secondary {secondaryGraded}/{sampleCount}
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-500">
            Markers never see the CID column.{" "}
            {isFirstMarkingReview
              ? "Click the star to toggle whether a seat is in the second-marking sample."
              : "A tick marks rows in the second-marking sample."}
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-4 py-2">
                <SeatSortHeader
                  label="Seat"
                  asc="seat_asc"
                  desc="seat_desc"
                  current={seatSort}
                  buildHref={(s) => `/admin/exams/${exam.id}?sort=${s}`}
                />
              </th>
              <th className="px-4 py-2">
                <SeatSortHeader
                  label="CID"
                  asc="cid_asc"
                  desc="cid_desc"
                  current={seatSort}
                  buildHref={(s) => `/admin/exams/${exam.id}?sort=${s}`}
                />
              </th>
              <th className="px-4 py-2 text-center">Absent</th>
              {exam.mcq_enabled && (
                <th className="px-4 py-2">
                  <SeatSortHeader
                    label="MCQ score"
                    asc="mcq_asc"
                    desc="mcq_desc"
                    current={seatSort}
                    buildHref={(s) => `/admin/exams/${exam.id}?sort=${s}`}
                  />
                </th>
              )}
              <th className="px-4 py-2">
                <SeatSortHeader
                  label="Primary grade"
                  asc="grade_asc"
                  desc="grade_desc"
                  current={seatSort}
                  buildHref={(s) => `/admin/exams/${exam.id}?sort=${s}`}
                />
              </th>
              <th className="px-4 py-2">Comment</th>
              <th className="px-4 py-2 text-center">Sample</th>
              <th className="px-4 py-2">
                <SeatSortHeader
                  label="Secondary grade"
                  asc="secondary_asc"
                  desc="secondary_desc"
                  current={seatSort}
                  buildHref={(s) => `/admin/exams/${exam.id}?sort=${s}`}
                />
              </th>
              <th className="px-4 py-2">Comment</th>
              {showFinalColumn && (
                <th className="px-4 py-2">
                  <SeatSortHeader
                    label="Final grade"
                    asc="final_asc"
                    desc="final_desc"
                    current={seatSort}
                    buildHref={(s) => `/admin/exams/${exam.id}?sort=${s}`}
                  />
                </th>
              )}
              {showFinalColumn && exam.mcq_enabled && (
                <th className="px-4 py-2">Weighted grade</th>
              )}
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {submissions.length === 0 && (
              <tr>
                <td
                  colSpan={
                    9 +
                    (showFinalColumn ? 1 : 0) +
                    (exam.mcq_enabled ? 1 : 0) +
                    (showFinalColumn && exam.mcq_enabled ? 1 : 0)
                  }
                  className="px-4 py-8 text-center text-slate-500"
                >
                  No seats uploaded yet.
                </td>
              </tr>
            )}
            {submissions.map((s) => {
              const needsResolution =
                showFinalColumn && s.in_sample && s.final_grade === null;
              const mismatch =
                s.in_sample &&
                s.grade !== null &&
                s.secondary_grade !== null &&
                s.grade !== s.secondary_grade;
              const rowClass = needsResolution
                ? "bg-amber-100"
                : mismatch
                  ? "bg-amber-50"
                  : "";
              return (
                <tr
                  key={s.id}
                  className={`border-b last:border-b-0 align-top ${rowClass}`}
                >
                  <td className="px-4 py-2 font-mono">{s.seat_number}</td>
                  <td className="px-4 py-2 font-mono">{s.cid}</td>
                  <td className="px-4 py-2 text-center">
                    <AbsenceToggleButton
                      examId={exam.id}
                      submissionId={s.id}
                      isAbsent={s.absent}
                      hasGrades={
                        s.grade !== null ||
                        s.secondary_grade !== null ||
                        s.final_grade !== null ||
                        s.mcq_score !== null
                      }
                    />
                  </td>
                  {exam.mcq_enabled && (
                    <td className="px-4 py-2">
                      {s.absent ? (
                        <span className="text-slate-400">n/a</span>
                      ) : (
                        <InlineSaveForm
                          action={setMcqScoreActionState.bind(
                            null,
                            exam.id,
                            s.id,
                          )}
                          defaultValue={s.mcq_score ?? ""}
                          name="mcq_score"
                          pattern="^\d+(\.\d{1,2})?$"
                          inputMode="decimal"
                          title="Number between 0 and 100 with up to 2 decimal places"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2">
                    {s.absent ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <InlineSaveForm
                        action={adminOverrideGradeActionState.bind(
                          null,
                          exam.id,
                          s.id,
                          "grade",
                        )}
                        defaultValue={s.grade ?? ""}
                        pattern="^\d+(\.\d{1,2})?$"
                        inputMode="decimal"
                        title={
                          s.override_note ??
                          "Admin override — type a new grade and save"
                        }
                      />
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {s.primary_comment ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {isFirstMarkingReview ? (
                      <SampleToggle
                        examId={exam.id}
                        submissionId={s.id}
                        initialChecked={s.in_sample}
                      />
                    ) : (
                      <input
                        type="checkbox"
                        checked={s.in_sample}
                        disabled
                        readOnly
                        aria-label={s.in_sample ? "In sample" : "Not in sample"}
                        title={s.in_sample ? "In sample" : "Not in sample"}
                        className="h-4 w-4 accent-blue-600"
                      />
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {s.absent ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <InlineSaveForm
                        action={adminOverrideGradeActionState.bind(
                          null,
                          exam.id,
                          s.id,
                          "secondary_grade",
                        )}
                        defaultValue={s.secondary_grade ?? ""}
                        pattern="^\d+(\.\d{1,2})?$"
                        inputMode="decimal"
                        title={
                          s.override_note ??
                          "Admin override — type a new grade and save"
                        }
                      />
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {s.in_sample ? (
                      (s.secondary_comment ?? (
                        <span className="text-slate-400">—</span>
                      ))
                    ) : (
                      <span className="text-slate-300">n/a</span>
                    )}
                  </td>
                  {showFinalColumn && (
                    <td className="px-4 py-2">
                      {s.absent ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <InlineSaveForm
                          action={adminOverrideGradeActionState.bind(
                            null,
                            exam.id,
                            s.id,
                            "final_grade",
                          )}
                          defaultValue={s.final_grade ?? ""}
                          placeholder={needsResolution ? "resolve" : "—"}
                          pattern="^\d+(\.\d{1,2})?$"
                          inputMode="decimal"
                          title={
                            needsResolution
                              ? "Awaiting primary marker resolution — admin can also enter a final grade here"
                              : (s.override_note ??
                                "Admin override — type a new grade and save")
                          }
                          inputClassName={`w-20 rounded border px-2 py-1 text-sm ${needsResolution ? "border-amber-400" : ""}`}
                        />
                      )}
                    </td>
                  )}
                  {showFinalColumn && exam.mcq_enabled && (
                    <td className="px-4 py-2 font-medium">
                      {s.absent ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        (computeWeightedGrade(
                          s.final_grade,
                          s.mcq_score,
                          exam.mcq_weighting,
                          exam.mcq_enabled,
                        ) ?? <span className="text-slate-400">—</span>)
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2 text-right">
                    {exam.status === "setup" && (
                      <form
                        action={async () => {
                          "use server";
                          await deleteSeatAction(exam.id, s.id);
                        }}
                      >
                        <SubmitButton
                          label="Remove"
                          className="text-xs text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="border-t pt-6">
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-900">
            Danger zone
          </summary>
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-4">
            <DeleteExamForm examId={exam.id} examName={exam.name} />
          </div>
        </details>
      </section>
    </div>
  );
}

function MarkerCard({
  role,
  examId,
  marker,
  completedAt,
  shareUrl,
  status,
}: {
  role: "primary" | "secondary";
  examId: number;
  marker: User | null;
  completedAt: string | null;
  shareUrl: string | null;
  status: Exam["status"];
}) {
  const heading = role === "primary" ? "Primary marker" : "Second marker";
  const activeNow =
    (role === "primary" &&
      (status === "primary_marking" || status === "review")) ||
    (role === "secondary" && status === "secondary_marking");
  const hint =
    role === "primary"
      ? status === "setup"
        ? "Send once you click Start primary marking."
        : status === "primary_marking"
          ? "Send this URL to the primary marker."
          : status === "review"
            ? "Send this URL to the primary marker to resolve discrepancies."
            : "Primary marking is finished."
      : status === "setup" ||
          status === "primary_marking" ||
          status === "first_marking_review"
        ? "Send once you click Start second marking."
        : status === "secondary_marking"
          ? "Send this URL to the second marker."
          : "Second marking is finished.";

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-slate-500">
          {heading}
        </p>
        {activeNow && (
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800">
            Active
          </span>
        )}
      </div>
      {marker ? (
        <>
          <p className="mt-1 font-medium">{marker.name ?? marker.email}</p>
          {marker.name && (
            <p className="text-sm text-slate-600">{marker.email}</p>
          )}
          {completedAt && (
            <p className="mt-1 text-xs text-green-700">
              Completed {formatDateTime(completedAt)}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm text-slate-400">Not set</p>
      )}

      {shareUrl && (
        <div className="mt-3">
          <p className="text-xs text-slate-500">Marker URL</p>
          <input
            readOnly
            value={shareUrl}
            className="mt-1 w-full rounded border bg-slate-50 px-2 py-1 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-slate-500">{hint}</p>
          <details className="mt-2 text-xs text-slate-600">
            <summary className="cursor-pointer hover:text-slate-900">
              Regenerate URL (invalidates the previous link)
            </summary>
            <form
              action={async () => {
                "use server";
                await regenerateMarkerTokenAction(examId, role);
              }}
              className="mt-2"
            >
              <SubmitButton
                label="Regenerate"
                className="rounded border bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </form>
          </details>
        </div>
      )}

      <details className="mt-3 text-xs text-slate-600">
        <summary className="cursor-pointer hover:text-slate-900">
          Reassign marker
        </summary>
        <form
          action={async (fd) => {
            "use server";
            await reassignMarkerAction(examId, role, fd);
          }}
          className="mt-2 flex flex-col gap-2"
        >
          <input
            type="email"
            name="email"
            required
            placeholder="email@imperial.ac.uk"
            className="rounded border px-2 py-1 text-sm"
          />
          <input
            name="name"
            placeholder="Name (optional)"
            className="rounded border px-2 py-1 text-sm"
          />
          <SubmitButton
            label="Save"
            className="rounded border bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </form>
      </details>
    </div>
  );
}

function StatusBadge({ status }: { status: Exam["status"] }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[status]}`}
    >
      {EXAM_STATUS_LABEL[status]}
    </span>
  );
}

function SeatSortHeader({
  label,
  asc,
  desc,
  current,
  buildHref,
}: {
  label: string;
  asc: SeatSortKey;
  desc: SeatSortKey;
  current: SeatSortKey;
  buildHref: (sort: SeatSortKey) => string;
}) {
  const next: SeatSortKey =
    current === asc ? desc : desc && current === desc ? asc : asc;
  const arrow =
    current === asc ? " ↑" : current === desc ? " ↓" : "";
  return (
    <Link href={buildHref(next)} className="hover:text-slate-900">
      {label}
      <span className="text-slate-400">{arrow || " ↕"}</span>
    </Link>
  );
}
