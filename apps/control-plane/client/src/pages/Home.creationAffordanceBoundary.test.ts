import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONSOLE = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");
// Canonical customer creation moved out of Home.tsx into its own workspace
// component (the Enterprise Customers list + tabbed detail view); the
// role-gating boundary check follows it there.
const CUSTOMER_WORKSPACE = readFileSync(resolve(process.cwd(), "client/src/components/EnterpriseCustomersWorkspace.tsx"), "utf8");

/**
 * Creation affordances are the highest-risk controls in the console: they are
 * how operational records come into existence. An auditor must never see one.
 * These checks read the console source so a future edit cannot reintroduce an
 * ungated shortcut without failing the suite.
 */
describe("creation affordance boundary", () => {
  it("keeps no legacy ungated customer or beneficiary form in the console", () => {
    // The transitional numeric-ID forms were removed. Canonical onboarding is
    // the only path, and it is gated.
    expect(CONSOLE).not.toContain("function CustomerForm(");
    expect(CONSOLE).not.toContain("function BeneficiaryForm(");
  });

  it("gates canonical customer onboarding to compliance officers and administrators", () => {
    const index = CUSTOMER_WORKSPACE.indexOf("<PostgresCustomerOnboardingForm");
    expect(index).toBeGreaterThan(-1);
    const preceding = CUSTOMER_WORKSPACE.slice(Math.max(0, index - 400), index);
    // The rendering site is guarded by the workspace's canEdit flag.
    expect(preceding).toMatch(/canEdit/);
    // canEdit itself must resolve to compliance_officer or admin, not a
    // broader or looser check.
    expect(CUSTOMER_WORKSPACE).toContain('canEdit = role === "compliance_officer" || role === "admin"');
  });

  it("gates payment order and payment leg creation behind the payment role check", () => {
    for (const form of ["<PaymentOrderForm", "<PaymentLegForm"]) {
      const index = CONSOLE.indexOf(form);
      expect(index, `${form} should be rendered`).toBeGreaterThan(-1);
      const preceding = CONSOLE.slice(Math.max(0, index - 260), index);
      expect(preceding, `${form} must be role gated`).toContain("canOperatePayments(user?.role)");
    }
  });

  it("gates rate-lock creation behind the treasury role check", () => {
    const index = CONSOLE.indexOf("<RateLockForm");
    expect(index).toBeGreaterThan(-1);
    const preceding = CONSOLE.slice(Math.max(0, index - 260), index);
    expect(preceding).toContain("canManageRateLocks(user?.role)");
  });

  it("routes every creation mutation through the canonical namespace", () => {
    const creationMutations = [
      "createPaymentOrder",
      "createPaymentLeg",
      "createRateLock",
    ];
    for (const name of creationMutations) {
      const pattern = new RegExp(`const ${name} = trpc\\.postgres\\.`);
      expect(CONSOLE, `${name} must bind to trpc.postgres`).toMatch(pattern);
    }
    // No creation mutation may bind to the transitional namespace.
    expect(CONSOLE).not.toMatch(/const create[A-Za-z]* = trpc\.umoja\./);
    expect(CUSTOMER_WORKSPACE, "createCustomer must bind to trpc.postgres").toMatch(/const createCustomer = trpc\.postgres\./);
    expect(CUSTOMER_WORKSPACE).not.toMatch(/const create[A-Za-z]* = trpc\.umoja\./);
  });
});
