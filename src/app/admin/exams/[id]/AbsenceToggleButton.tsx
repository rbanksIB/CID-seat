"use client";

import { useTransition } from "react";
import { toggleAbsentAction } from "../../actions";

// Checkbox in the "Absent" column of the seats table. Ticked = absent,
// unticked = present. If flipping Present -> Absent would wipe saved
// grades, warns first.
export function AbsenceToggleButton({
  examId,
  submissionId,
  isAbsent,
  hasGrades,
}: {
  examId: number;
  submissionId: number;
  isAbsent: boolean;
  hasGrades: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function onChange() {
    if (!isAbsent && hasGrades) {
      const ok = window.confirm(
        "Warning - this student's exam has been graded. Marking the student as absent will delete the grades given by markers. Are you sure you want to mark the student as absent?",
      );
      if (!ok) return;
    }
    startTransition(async () => {
      await toggleAbsentAction(examId, submissionId);
    });
  }

  return (
    <input
      type="checkbox"
      checked={isAbsent}
      disabled={pending}
      onChange={onChange}
      aria-label={
        isAbsent ? "Mark student as present" : "Mark student as absent"
      }
      title={
        isAbsent
          ? "Absent — untick to mark present"
          : hasGrades
            ? "Present — tick to mark absent (will warn before deleting saved grades)"
            : "Present — tick to mark absent"
      }
      className="h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}
