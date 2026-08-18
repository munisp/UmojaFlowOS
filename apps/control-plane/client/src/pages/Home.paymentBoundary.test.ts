import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("managed payment workflow boundary", () => {
  it("drafts payments only through canonical PostgreSQL procedures", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");

    // Drafting, lifecycle transitions, and rate-lock expiry are canonical.
    expect(source).toContain("trpc.postgres.createPaymentOrder.useMutation");
    expect(source).toContain("trpc.postgres.transitionPaymentOrder.useMutation");
    expect(source).toContain("trpc.postgres.expireRateLocks.useMutation");
    expect(source).toContain("trpc.postgres.paymentOrders.useQuery");
    expect(source).toContain("trpc.postgres.paymentLegs.useQuery");

    // No transitional payment read or write may remain bound in the console.
    expect(source).not.toContain("trpc.umoja.payments.");

    expect(source).not.toContain('button("Draft", "payment")');
    expect(source).not.toContain('button("Leg", "payment-leg")');
    expect(source).not.toContain('openComposer("payment")');
    expect(source).not.toContain('openComposer("payment-leg")');
  });

  it("never offers a provider-dependent execution state from the console", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");
    const workflow = readFileSync(
      resolve(process.cwd(), "client/src/components/PaymentWorkflowControls.tsx"),
      "utf8",
    );

    // Execution, settlement, and failure states require a verified provider
    // reference, so the console must not offer them as selectable transitions.
    for (const state of ["executing", "partially_completed", "completed", "failed"]) {
      expect(source).not.toContain(`"${state}"`);
      const offered = new RegExp(`internalPaymentTransitions[^=]*=[^;]*"${state}"`, "s");
      expect(offered.test(workflow)).toBe(false);
    }
  });
});
