import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  canManageRateLocks,
  isCancellableRateLock,
  RateLockForm,
  RateLockTable,
  type MarketObservationRow,
  type RateLockRow,
} from "./RateLockControls";

afterEach(cleanup);

const NOW = new Date("2026-08-18T12:00:00Z");

function lock(overrides: Partial<RateLockRow> = {}): RateLockRow {
  return {
    id: "lock-1",
    corridor: "NIGERIA_NGN",
    baseAsset: "USD",
    quoteAsset: "NGN",
    lockedRate: "1650.25000000",
    expiresAt: new Date("2026-08-18T13:00:00Z"),
    status: "locked",
    ...overrides,
  };
}

describe("rate-lock control boundaries", () => {
  it("restricts rate-lock management to treasury operators and administrators", () => {
    expect(canManageRateLocks("treasury_operator")).toBe(true);
    expect(canManageRateLocks("admin")).toBe(true);
    expect(canManageRateLocks("compliance_officer")).toBe(false);
    expect(canManageRateLocks("auditor")).toBe(false);
    expect(canManageRateLocks(undefined)).toBe(false);
  });

  it("treats only a live lock as cancellable", () => {
    expect(isCancellableRateLock(lock(), NOW)).toBe(true);
    expect(isCancellableRateLock(lock({ status: "expired" }), NOW)).toBe(false);
    expect(isCancellableRateLock(lock({ status: "cancelled" }), NOW)).toBe(false);
    expect(isCancellableRateLock(lock({ expiresAt: new Date("2026-08-18T11:00:00Z") }), NOW)).toBe(false);
  });
});

describe("rate-lock console rendering", () => {
  it("offers a reasoned cancellation control to treasury but not to auditors", () => {
    const { unmount } = render(
      <RateLockTable rows={[lock()]} loading={false} role="treasury_operator" cancel={() => undefined} now={NOW} />,
    );
    const form = screen.getByTestId("rate-lock-cancel-form-lock-1");
    expect(form).toBeTruthy();
    // The reason is mandatory because the lock carries no cancellation column.
    expect(form.querySelector("input[name='reason'][required]")).toBeTruthy();
    unmount();

    render(<RateLockTable rows={[lock()]} loading={false} role="auditor" cancel={() => undefined} now={NOW} />);
    expect(screen.queryByTestId("rate-lock-cancel-form-lock-1")).toBeNull();
  });

  it("offers no cancellation control for an expired or already cancelled lock", () => {
    render(
      <RateLockTable
        rows={[lock({ id: "lock-2", status: "expired" }), lock({ id: "lock-3", status: "cancelled" })]}
        loading={false}
        role="treasury_operator"
        cancel={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId("rate-lock-cancel-form-lock-2")).toBeNull();
    expect(screen.queryByTestId("rate-lock-cancel-form-lock-3")).toBeNull();
  });

  it("shows the locked rate and expiry for review without offering any action to auditors", () => {
    render(<RateLockTable rows={[lock()]} loading={false} role="auditor" now={NOW} />);
    expect(screen.getByText("1650.25000000")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains the empty lock state without implying a rate", () => {
    render(<RateLockTable rows={[]} loading={false} role="treasury_operator" cancel={() => undefined} now={NOW} />);
    expect(screen.getByTestId("rate-locks-empty")).toBeTruthy();
    expect(screen.getByText(/No rate is assumed/)).toBeTruthy();
  });

  it("withholds lock creation until a recorded observation exists", () => {
    const { unmount } = render(<RateLockForm observations={[]} pending={false} submit={() => undefined} />);
    expect(screen.getByTestId("rate-lock-form-unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    const observations: MarketObservationRow[] = [
      { id: "obs-1", baseAsset: "USD", quoteAsset: "NGN", rate: "1650.25000000", observedAt: new Date("2026-08-18T11:30:00Z") },
    ];
    render(<RateLockForm observations={observations} pending={false} submit={() => undefined} />);
    expect(screen.getByTestId("rate-lock-form")).toBeTruthy();
    expect(screen.getByText(/No rate is entered by hand/)).toBeTruthy();
  });
});
