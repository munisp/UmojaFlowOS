import { useEffect, useRef, useState } from "react";

/**
 * Shared submission feedback for console forms.
 *
 * Three things this deliberately does, because the alternative is worse in a
 * compliance console specifically:
 *
 *  - **Errors are shown in place, not only as a toast.** A toast disappears. An
 *    operator who looks away during a rejected SAR/STR transition would
 *    otherwise have no way to find out why it failed, and the most likely
 *    recovery is to try again — which is exactly wrong.
 *  - **The error text is the server's own.** No message here rewrites, softens,
 *    or generalises a refusal. A fail-closed reason is operational information;
 *    replacing it with "Something went wrong" destroys it.
 *  - **A slow submission is distinguished from a stalled one.** Past a
 *    threshold, the operator is told the request is still in flight, so they do
 *    not resubmit an action that may already have been recorded.
 */

export type SubmitFeedbackState =
  | { kind: "idle" }
  | { kind: "submitting"; slow: boolean }
  | { kind: "error"; message: string };

/** Requests slower than this are called out, rather than looking frozen. */
const SLOW_THRESHOLD_MS = 2_000;

export function useSubmitFeedback(pending: boolean, error?: string | null): SubmitFeedbackState {
  const [slow, setSlow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pending) {
      setSlow(false);
      timer.current = setTimeout(() => setSlow(true), SLOW_THRESHOLD_MS);
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }
    if (timer.current) clearTimeout(timer.current);
    setSlow(false);
    return undefined;
  }, [pending]);

  if (pending) return { kind: "submitting", slow };
  if (error) return { kind: "error", message: error };
  return { kind: "idle" };
}

export function SubmitFeedback({ state }: { state: SubmitFeedbackState }) {
  if (state.kind === "idle") return null;

  if (state.kind === "submitting") {
    return (
      <div
        className="flex items-center gap-2 border border-black/15 bg-black/[0.03] px-3 py-2 text-xs leading-5 text-black/70"
        role="status"
        aria-live="polite"
        data-testid="submit-pending"
      >
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 shrink-0 animate-spin border-2 border-black/20 border-t-[#e11919] motion-reduce:animate-none"
        />
        <span>
          {state.slow
            ? "Still submitting. The request has been sent and is awaiting a response — do not resubmit, as the action may already have been recorded."
            : "Submitting…"}
        </span>
      </div>
    );
  }

  return (
    <div
      className="border-l-4 border-[#e11919] bg-[#e11919]/[0.06] px-3 py-2 text-xs leading-5"
      role="alert"
      aria-live="assertive"
      data-testid="submit-error"
    >
      <p className="font-black uppercase tracking-[0.14em] text-[#e11919]">Submission refused</p>
      {/* The server's exact wording. A refusal reason is the most useful thing
          on the screen and must not be paraphrased. */}
      <p className="mt-1 text-black/80">{state.message}</p>
      <p className="mt-1 text-black/55">Nothing was recorded. Correct the input above and submit again.</p>
    </div>
  );
}
