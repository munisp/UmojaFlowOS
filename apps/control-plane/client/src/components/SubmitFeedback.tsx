import { useCallback, useEffect, useRef, useState } from "react";

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
 *  - **Retry is offered only when retrying is safe.** A transport failure left
 *    the outcome unknown but changed nothing the operator can see, so one click
 *    should resend it. A business refusal — a consumed rate lock, a missing
 *    submission reference — will refuse identically every time, so offering
 *    retry there trains operators to click through refusals instead of reading
 *    them. See `classifyFailure`.
 */

export type SubmitFeedbackState =
  | { kind: "idle" }
  | { kind: "submitting"; slow: boolean }
  | { kind: "error"; message: string; retryable: boolean };

/** Requests slower than this are called out, rather than looking frozen. */
const SLOW_THRESHOLD_MS = 2_000;

/**
 * Decides whether resending the identical request could plausibly succeed.
 *
 * The distinction is not cosmetic. Retry is offered for failures where the
 * request did not reach a decision — network loss, timeout, a gateway or
 * overload response, an aborted connection. It is withheld for every failure
 * where the server evaluated the request and refused it, because the same
 * input will be refused again and the operator needs to read the reason rather
 * than resend.
 *
 * A timeout is deliberately treated as retryable *and* the pending notice warns
 * the action may already have been recorded. Those are consistent: the
 * platform's mutating procedures are either idempotent by key or refuse a
 * duplicate outright, so a second attempt is either absorbed or refused with a
 * clear reason — never silently doubled.
 */
export function classifyFailure(message: string): { retryable: boolean } {
  const text = message.toLowerCase();

  // Unambiguous transport signals are checked first. These are emitted by the
  // network stack, never by a policy decision, so no refusal can contain one.
  // "connect ECONNREFUSED …" was previously misread as a refusal because it
  // contains the substring "refused".
  const unambiguousTransport = ["econnrefused", "econnreset", "etimedout", "enotfound", "socket hang up", "fetch failed", "failed to fetch"];
  if (unambiguousTransport.some(token => text.includes(token))) return { retryable: true };

  // Server-side refusals: the request was understood and declined. These are
  // checked first so a refusal mentioning, say, "connection" in its wording
  // cannot be misread as a transport failure.
  const refusal = [
    "permission",
    "forbidden",
    "unauthorized",
    "unauthorised",
    "not found",
    "already",
    "invalid",
    "required",
    "refused",
    "must ",
    "cannot ",
    "no active",
    "not configured",
    "expired",
    "consumed",
    "conflict",
    "duplicate",
  ];
  if (refusal.some(token => text.includes(token))) return { retryable: false };

  const transport = [
    "network",
    "timeout",
    "timed out",
    "aborted",
    "502",
    "503",
    "504",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "internal server error",
  ];
  if (transport.some(token => text.includes(token))) return { retryable: true };

  // Unrecognised failures are treated as refusals. Withholding a retry button
  // costs one manual resubmission; offering one on a refusal invites repeated
  // attempts at something that will never succeed.
  return { retryable: false };
}

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
  if (error) return { kind: "error", message: error, retryable: classifyFailure(error).retryable };
  return { kind: "idle" };
}

/**
 * Wraps a submit function so the last attempted payload can be resent.
 *
 * Retry deliberately resends the captured payload rather than re-reading the
 * form. The operator may have started editing the form after the failure, and
 * silently sending the edited values under a button labelled "retry" would
 * submit something they never reviewed.
 */
export function useRetryableSubmit<TInput>(submit: (input: TInput) => void) {
  const last = useRef<TInput | null>(null);

  const run = useCallback(
    (input: TInput) => {
      last.current = input;
      submit(input);
    },
    [submit],
  );

  const retry = useCallback(() => {
    if (last.current === null) return;
    submit(last.current);
  }, [submit]);

  return { run, retry, hasAttempt: last.current !== null };
}

export function SubmitFeedback({ state, onRetry }: { state: SubmitFeedbackState; onRetry?: () => void }) {
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
      {state.retryable ? (
        <>
          <p className="mt-1 text-black/55">
            The request did not reach the service, so no decision was recorded. Your entries are unchanged and can be sent again.
          </p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              data-testid="submit-retry"
              className="mt-2 bg-black px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-white transition-transform duration-150 ease-out active:scale-[0.97]"
            >
              Retry submission
            </button>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-black/55">Nothing was recorded. Correct the input above and submit again.</p>
      )}
    </div>
  );
}
