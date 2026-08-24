"use client";

import { useActionState, type ReactNode } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import {
  SAVE_STATE_INITIAL,
  type SaveState,
} from "@/lib/actionState";

// Wraps a marker's "Submit marks" / "Submit final marks" form with a
// useActionState-driven action so a server-side validation throw
// (e.g. mismatched grade with no comment) renders as a friendly
// inline error instead of Next.js's default server-component error
// box. Any helper copy that lived under the button in the original
// form is passed in as children so the layout stays identical.
export function CompleteMarkingButton({
  action,
  label,
  disabled,
  className,
  children,
}: {
  action: (prev: SaveState, fd: FormData) => Promise<SaveState>;
  label: string;
  disabled?: boolean;
  className: string;
  children?: ReactNode;
}) {
  const [state, formAction] = useActionState<SaveState, FormData>(
    action,
    SAVE_STATE_INITIAL,
  );
  return (
    <form action={formAction}>
      <SubmitButton
        label={label}
        disabled={disabled}
        scrollToTop
        className={className}
      />
      {state.error && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          An error prevented marks from being submitted. Please check the
          page below.
        </p>
      )}
      {children}
    </form>
  );
}
