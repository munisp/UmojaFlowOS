import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmitFeedback, useSubmitFeedback } from "./SubmitFeedback";

/**
 * The feedback component carries a specific responsibility in this console: a
 * refusal is operational information, so it must be shown in place, kept
 * verbatim, and paired with a statement of what did or did not happen.
 */
describe("submission feedback", () => {
  afterEach(cleanup);

  it("shows nothing when idle", () => {
    const { container } = render(<SubmitFeedback state={{ kind: "idle" }} />);
    expect(container.firstChild).toBeNull();
  });

  it("announces an in-flight submission politely", () => {
    render(<SubmitFeedback state={{ kind: "submitting", slow: false }} />);
    const status = screen.getByRole("status");
    // Polite, not assertive: a submission starting should not interrupt a
    // screen-reader user mid-sentence.
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toMatch(/Submitting/);
  });

  it("warns against resubmitting once a request is slow", () => {
    render(<SubmitFeedback state={{ kind: "submitting", slow: true }} />);
    // The dangerous behaviour is an operator resubmitting a payment-adjacent
    // action they believe failed.
    expect(screen.getByRole("status").textContent).toMatch(/do not resubmit/i);
  });

  it("shows the server's message verbatim and states nothing was recorded", () => {
    const message = "rate lock cannot be consumed twice";
    render(<SubmitFeedback state={{ kind: "error", message }} />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toMatch(/Nothing was recorded/);
  });

  it("does not paraphrase or truncate a long refusal", () => {
    const message =
      "a submitted regulatory report requires an authorised channel submission reference; the supplied reference does not correspond to a verified channel";
    render(<SubmitFeedback state={{ kind: "error", message }} />);
    expect(screen.getByRole("alert").textContent).toContain(message);
  });
});

describe("submission feedback state", () => {
  afterEach(cleanup);

  it("reports idle when nothing is happening", () => {
    const { result } = renderHook(() => useSubmitFeedback(false, null));
    expect(result.current.kind).toBe("idle");
  });

  it("escalates to slow only after the threshold", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSubmitFeedback(true, null));
      expect(result.current).toEqual({ kind: "submitting", slow: false });
      act(() => { vi.advanceTimersByTime(1_900); });
      // Calling a 1.9s request "slow" would fire on almost every submission and
      // stop meaning anything.
      expect(result.current).toEqual({ kind: "submitting", slow: false });
      act(() => { vi.advanceTimersByTime(200); });
      expect(result.current).toEqual({ kind: "submitting", slow: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the pending state over a stale error", () => {
    // Retrying must clear the previous refusal, otherwise the operator sees an
    // error for a request that is currently in flight.
    const { result } = renderHook(() => useSubmitFeedback(true, "previous failure"));
    expect(result.current.kind).toBe("submitting");
  });

  it("surfaces the error once the request settles", () => {
    const { result } = renderHook(() => useSubmitFeedback(false, "permission denied"));
    expect(result.current).toEqual({ kind: "error", message: "permission denied" });
  });
});
