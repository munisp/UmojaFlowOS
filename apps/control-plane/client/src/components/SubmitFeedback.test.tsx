import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure, SubmitFeedback, useSubmitFeedback } from "./SubmitFeedback";

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
    render(<SubmitFeedback state={{ kind: "error", message, retryable: false }} />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toMatch(/Nothing was recorded/);
  });

  it("does not paraphrase or truncate a long refusal", () => {
    const message =
      "a submitted regulatory report requires an authorised channel submission reference; the supplied reference does not correspond to a verified channel";
    render(<SubmitFeedback state={{ kind: "error", message, retryable: false }} />);
    expect(screen.getByRole("alert").textContent).toContain(message);
  });

  it("offers one-click retry when the request never reached a decision", () => {
    const onRetry = vi.fn();
    render(
      <SubmitFeedback state={{ kind: "error", message: "fetch failed", retryable: true }} onRetry={onRetry} />,
    );
    const retry = screen.getByTestId("submit-retry");
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // It must also say why retrying is safe here.
    expect(screen.getByRole("alert").textContent).toMatch(/no decision was recorded/i);
  });

  it("withholds retry on a business refusal, because the same input will be refused again", () => {
    render(
      <SubmitFeedback state={{ kind: "error", message: "rate lock already consumed", retryable: false }} onRetry={() => {}} />,
    );
    expect(screen.queryByTestId("submit-retry")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Correct the input above/);
  });

  it("shows no retry control when the caller supplies no retry handler", () => {
    render(<SubmitFeedback state={{ kind: "error", message: "network error", retryable: true }} />);
    // Retryable, but nothing to call: rendering a dead button would be worse
    // than rendering none.
    expect(screen.queryByTestId("submit-retry")).toBeNull();
  });
});

describe("failure classification", () => {
  it("treats transport failures as retryable", () => {
    for (const message of [
      "fetch failed",
      "network request failed",
      "The operation timed out",
      "connect ECONNREFUSED 127.0.0.1:9000",
      "socket hang up",
      "502 Bad Gateway",
      "503 Service Unavailable",
    ]) {
      expect(classifyFailure(message).retryable, message).toBe(true);
    }
  });

  it("treats evaluated refusals as not retryable", () => {
    for (const message of [
      "permission denied for this role",
      "rate lock already consumed",
      "counterparty not found",
      "a submission reference is required",
      "no active integration is configured for this corridor",
      "the recommendation has expired",
      "invalid corridor for this regulator",
    ]) {
      expect(classifyFailure(message).retryable, message).toBe(false);
    }
  });

  it("does not misread a refusal that happens to mention a network term", () => {
    // "connection" appears, but this is a decision the server made and will
    // make again.
    expect(classifyFailure("no active provider connection is configured").retryable).toBe(false);
  });

  it("withholds retry for an unrecognised failure rather than guessing", () => {
    expect(classifyFailure("unexpected condition in ledger projection").retryable).toBe(false);
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
    expect(result.current).toEqual({ kind: "error", message: "permission denied", retryable: false });
  });

  it("marks a transport failure retryable when the request settles", () => {
    const { result } = renderHook(() => useSubmitFeedback(false, "fetch failed"));
    expect(result.current).toEqual({ kind: "error", message: "fetch failed", retryable: true });
  });
});
