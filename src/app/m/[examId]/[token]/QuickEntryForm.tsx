"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  SAVE_STATE_INITIAL,
  type SaveState,
} from "@/lib/actionState";
import { setGradeBySeatByTokenActionState } from "./actions";

export function QuickEntryForm({
  examId,
  token,
}: {
  examId: number;
  token: string;
}) {
  const boundAction = setGradeBySeatByTokenActionState.bind(null, examId, token);
  const [state, formAction, pending] = useActionState<SaveState, FormData>(
    boundAction,
    SAVE_STATE_INITIAL,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const seatInputRef = useRef<HTMLInputElement>(null);

  // On successful save, clear the fields and jump back to the seat box.
  useEffect(() => {
    if (state.ok && state.error === null) {
      formRef.current?.reset();
      seatInputRef.current?.focus();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="mt-3"
    >
      <div className="flex flex-wrap gap-2">
        <input
          ref={seatInputRef}
          name="seat"
          placeholder="Seat"
          required
          autoFocus
          className="w-32 rounded border px-3 py-2 text-sm font-mono"
        />
        <input
          name="grade"
          placeholder="Grade"
          required
          pattern="^\d+(\.\d)?$"
          inputMode="decimal"
          title="A number between 0 and 100 with at most one decimal place, e.g. 70 or 70.5"
          className="w-32 rounded border px-3 py-2 text-sm"
        />
        <input
          name="comment"
          placeholder="Comment (optional)"
          className="flex-1 min-w-48 rounded border px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {pending ? "Submitting…" : "Save"}
        </button>
      </div>
      {state.error && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      )}
    </form>
  );
}
