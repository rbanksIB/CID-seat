"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { GRADE_REGEX_SOURCE, isValidGrade } from "@/lib/validation";
import { formatDateTime } from "@/lib/datetime";
import { saveGradesByTokenAction } from "./actions";

export type GradeRow = {
  id: number;
  seat_number: string;
  current_grade: string | null;
  saved_at: string | null;
  current_comment: string | null;
  absent?: boolean;
  mcq_score?: string | null;
  // For secondary marker: the primary marker's grade.
  primary_grade?: string | null;
  // For primary marker in resolution view:
  primary_comment?: string | null;
  secondary_grade?: string | null;
  secondary_comment?: string | null;
};

type SortKey =
  | "seat"
  | "grade"
  | "primary_grade"
  | "mcq"
  | "saved";
type SortDir = "asc" | "desc";

const naturalSeatCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
function naturalCompareSeat(a: string, b: string): number {
  return naturalSeatCollator.compare(a, b);
}
function numericCompare(a: string | null | undefined, b: string | null | undefined): number {
  const aN = a == null ? NaN : Number(a);
  const bN = b == null ? NaN : Number(b);
  const aBad = !Number.isFinite(aN);
  const bBad = !Number.isFinite(bN);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  return aN - bN;
}

type SaveResult = { id: number; saved_at: string | null };

function fmtTime(iso: string | null): string {
  return formatDateTime(iso);
}

export function GradeTable({
  examId,
  token,
  rows,
  isSecondary,
  isResolving,
  markingOpen,
  mcqEnabled = false,
}: {
  examId: number;
  token: string;
  rows: GradeRow[];
  isSecondary: boolean;
  isResolving: boolean;
  markingOpen: boolean;
  mcqEnabled?: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "seat",
    dir: "asc",
  });
  function onSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }
  const sortedRows = [...rows].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    switch (sort.key) {
      case "seat":
        return dir * naturalCompareSeat(a.seat_number, b.seat_number);
      case "grade":
        return dir * numericCompare(a.current_grade, b.current_grade);
      case "primary_grade":
        return dir * numericCompare(a.primary_grade, b.primary_grade);
      case "mcq":
        return dir * numericCompare(a.mcq_score, b.mcq_score);
      case "saved":
        return dir * (a.saved_at ?? "").localeCompare(b.saved_at ?? "");
    }
  });
  const [values, setValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.current_grade ?? ""])),
  );
  const [comments, setComments] = useState<Record<number, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.current_comment ?? ""])),
  );
  const [savedAt, setSavedAt] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.saved_at])),
  );
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const lastServerRowsRef = useRef<GradeRow[]>(rows);
  useEffect(() => {
    const prev = new Map(lastServerRowsRef.current.map((r) => [r.id, r]));
    setValues((current) => {
      const next = { ...current };
      for (const r of rows) {
        const prevServer = prev.get(r.id)?.current_grade ?? "";
        if (!(r.id in current) || current[r.id] === prevServer) {
          next[r.id] = r.current_grade ?? "";
        }
      }
      return next;
    });
    setComments((current) => {
      const next = { ...current };
      for (const r of rows) {
        const prevServer = prev.get(r.id)?.current_comment ?? "";
        if (!(r.id in current) || current[r.id] === prevServer) {
          next[r.id] = r.current_comment ?? "";
        }
      }
      return next;
    });
    setSavedAt((current) => {
      const next = { ...current };
      for (const r of rows) next[r.id] = r.saved_at;
      return next;
    });
    lastServerRowsRef.current = rows;
  }, [rows]);

  function persist(ids: number[]): void {
    if (ids.length === 0) return;
    setError(null);
    // Client-side validation: refuse to send anything malformed.
    for (const id of ids) {
      const v = (values[id] ?? "").trim();
      if (!isValidGrade(v)) {
        setError(
          `Grade "${v}" must be a number between 0 and 100 with at most one decimal place`,
        );
        return;
      }
    }
    setPendingIds((prev) => new Set([...prev, ...ids]));
    const updates = ids.map((id) => ({
      id,
      grade: values[id] ?? "",
      comment: comments[id] ?? "",
    }));
    startTransition(async () => {
      try {
        const results: SaveResult[] = await saveGradesByTokenAction(
          examId,
          token,
          updates,
        );
        setSavedAt((prev) => {
          const next = { ...prev };
          for (const r of results) next[r.id] = r.saved_at;
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    });
  }

  function saveOne(id: number) {
    persist([id]);
  }

  function saveAll() {
    const gradable = rows.filter((r) => !r.absent);
    const dirty = gradable
      .filter(
        (r) =>
          values[r.id] !== (r.current_grade ?? "") ||
          comments[r.id] !== (r.current_comment ?? ""),
      )
      .map((r) => r.id);
    if (dirty.length === 0) {
      persist(gradable.map((r) => r.id));
    } else {
      persist(dirty);
    }
  }

  const dirtyCount = rows.filter(
    (r) =>
      !r.absent &&
      (values[r.id] !== (r.current_grade ?? "") ||
        comments[r.id] !== (r.current_comment ?? "")),
  ).length;

  const showPrimary = isSecondary || isResolving;
  const showSecondary = isResolving;
  // Secondary marker sees the MCQ column right after Seat (so they can
  // read it before the primary's grade); every other view keeps MCQ
  // between the primary/secondary columns and the marker's own grade.
  const mcqBeforePrimary = mcqEnabled && isSecondary && !isResolving;
  const mcqAfterPrimary = mcqEnabled && !mcqBeforePrimary;
  const yourLabel = isResolving
    ? "Final grade"
    : isSecondary
      ? "Your grade"
      : "Grade";

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold">
            {isResolving
              ? "Discrepancies"
              : isSecondary
                ? "Sampled seats"
                : "All seats"}
          </h2>
          <p className="text-xs text-slate-500">
            CIDs are hidden from markers. Comments are optional.
          </p>
        </div>
        {markingOpen && (
          <button
            type="button"
            onClick={saveAll}
            disabled={pendingIds.size > 0}
            className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {pendingIds.size > 0
              ? "Submitting…"
              : dirtyCount > 0
                ? `Save all (${dirtyCount} unsaved)`
                : "Save all"}
          </button>
        )}
      </div>
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="border-b bg-slate-50 text-left text-slate-600">
          <tr>
            <SortableTh
              label="Seat"
              active={sort.key === "seat"}
              dir={sort.dir}
              onClick={() => onSort("seat")}
              className="w-20"
            />
            {mcqBeforePrimary && (
              <SortableTh
                label="MCQ score"
                active={sort.key === "mcq"}
                dir={sort.dir}
                onClick={() => onSort("mcq")}
              />
            )}
            {showPrimary && (
              <SortableTh
                label="Primary grade"
                active={sort.key === "primary_grade"}
                dir={sort.dir}
                onClick={() => onSort("primary_grade")}
              />
            )}
            {isResolving && <th className="px-4 py-2">Primary comment</th>}
            {showSecondary && <th className="px-4 py-2">Secondary grade</th>}
            {isResolving && <th className="px-4 py-2">Secondary comment</th>}
            {mcqAfterPrimary && (
              <SortableTh
                label="MCQ score"
                active={sort.key === "mcq"}
                dir={sort.dir}
                onClick={() => onSort("mcq")}
              />
            )}
            <SortableTh
              label={yourLabel}
              active={sort.key === "grade"}
              dir={sort.dir}
              onClick={() => onSort("grade")}
            />
            <th className="px-4 py-2">Comment</th>
            <SortableTh
              label="Saved"
              active={sort.key === "saved"}
              dir={sort.dir}
              onClick={() => onSort("saved")}
            />
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 && (
            <tr>
              <td
                colSpan={
                  3 +
                  (showPrimary ? 1 : 0) +
                  (showSecondary ? 1 : 0) +
                  (isResolving ? 2 : 0) +
                  (mcqEnabled ? 1 : 0)
                }
                className="px-4 py-8 text-center text-slate-500"
              >
                {isResolving
                  ? "No discrepancies to resolve."
                  : isSecondary
                    ? "No sample available yet."
                    : "No seats uploaded for this exam yet."}
              </td>
            </tr>
          )}
          {sortedRows.map((r) => {
            const value = values[r.id] ?? "";
            const comment = comments[r.id] ?? "";
            const dirty =
              value !== (r.current_grade ?? "") ||
              comment !== (r.current_comment ?? "");
            const saving = pendingIds.has(r.id);
            // Second marker must comment whenever their grade differs
            // from the primary's; drives the red outline + placeholder
            // on the comment input while they're still typing.
            const commentRequired =
              isSecondary &&
              !isResolving &&
              value.trim() !== "" &&
              r.primary_grade != null &&
              value !== r.primary_grade;
            const commentMissing = commentRequired && comment.trim() === "";
            return (
              <tr key={r.id} className="border-b last:border-b-0 align-top">
                <td className="px-4 py-2 font-mono">{r.seat_number}</td>
                {mcqBeforePrimary && (
                  <td className="px-4 py-2 font-mono text-slate-700">
                    {r.absent ? "—" : (r.mcq_score ?? "—")}
                  </td>
                )}
                {showPrimary && (
                  <td className="px-4 py-2 font-mono text-slate-700">
                    {r.primary_grade ?? "—"}
                  </td>
                )}
                {isResolving && (
                  <td className="px-4 py-2 text-slate-700">
                    {r.primary_comment ?? "—"}
                  </td>
                )}
                {showSecondary && (
                  <td className="px-4 py-2 font-mono text-slate-700">
                    {r.secondary_grade ?? "—"}
                  </td>
                )}
                {isResolving && (
                  <td className="px-4 py-2 text-slate-700">
                    {r.secondary_comment ?? "—"}
                  </td>
                )}
                {mcqAfterPrimary && (
                  <td className="px-4 py-2 font-mono text-slate-700">
                    {r.absent ? "—" : (r.mcq_score ?? "—")}
                  </td>
                )}
                <td className="px-4 py-2">
                  {r.absent ? (
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-medium text-white">
                      Absent
                    </span>
                  ) : markingOpen ? (
                    <input
                      value={value}
                      onChange={(e) =>
                        setValues((p) => ({ ...p, [r.id]: e.target.value }))
                      }
                      placeholder="—"
                      pattern={GRADE_REGEX_SOURCE}
                      inputMode="decimal"
                      title="Number between 0 and 100 with at most one decimal place"
                      className={`w-24 rounded border px-2 py-1 text-sm ${dirty ? "border-blue-400 bg-blue-50" : ""}`}
                    />
                  ) : (
                    <span className="font-mono">{value || "—"}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.absent ? (
                    <span className="text-slate-400">n/a</span>
                  ) : markingOpen ? (
                    <input
                      value={comment}
                      onChange={(e) =>
                        setComments((p) => ({ ...p, [r.id]: e.target.value }))
                      }
                      placeholder={commentRequired ? "required" : "optional"}
                      title={
                        commentRequired
                          ? "Your grade differs from the primary marker's — a comment is required."
                          : undefined
                      }
                      className={`w-full min-w-32 rounded border px-2 py-1 text-sm ${
                        commentMissing
                          ? "border-red-400 bg-red-50"
                          : dirty
                            ? "border-blue-400 bg-blue-50"
                            : ""
                      }`}
                    />
                  ) : (
                    <span className="text-slate-700">{comment || "—"}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-600">
                  {r.absent
                    ? ""
                    : savedAt[r.id]
                      ? `Saved at ${fmtTime(savedAt[r.id]!)}`
                      : ""}
                  {markingOpen && !r.absent && (
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() => saveOne(r.id)}
                        disabled={saving}
                        className="rounded border bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100"
                      >
                        {saving ? "Submitting…" : "Save"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={`px-4 py-2 ${className ?? ""}`}>
      <button
        type="button"
        onClick={onClick}
        className="hover:text-slate-900"
      >
        {label}
        <span className="ml-1 text-slate-400">
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}
