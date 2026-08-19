import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StakeholderOnboardingWorkspace, type OnboardingSignals } from "./StakeholderOnboardingWorkspace";

const emptySignals: OnboardingSignals = {
  counterparties: 0,
  integrations: 0,
  customers: 0,
  consents: 0,
  documents: 0,
  liquidityPositions: 0,
  rateLocks: 0,
  paymentOrders: 0,
  complianceCases: 0,
  reports: 0,
  auditEvents: 0,
};

describe("stakeholder onboarding workspace", () => {
  afterEach(cleanup);

  it("gives an administrator a guided, non-activating provider-setup journey", async () => {
    const onNavigate = vi.fn();
    render(<StakeholderOnboardingWorkspace role="admin" signals={emptySignals} onNavigate={onNavigate} />);

    expect(screen.getByTestId("stakeholder-onboarding-admin")).toBeTruthy();
    expect(screen.getByText("Establish controlled operating foundations")).toBeTruthy();
    expect(screen.getByText(/does not activate a provider/i)).toBeTruthy();
    expect(screen.getByText("0/4")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /open registry for record a regulated counterparty/i }));
    expect(onNavigate).toHaveBeenCalledWith("registry");
  });

  it("keeps compliance analysis explicitly evidence-only", () => {
    render(<StakeholderOnboardingWorkspace role="compliance_officer" signals={emptySignals} onNavigate={vi.fn()} />);

    expect(screen.getByTestId("stakeholder-onboarding-compliance_officer")).toBeTruthy();
    expect(screen.getByText("Create a reviewable evidence journey")).toBeTruthy();
    expect(screen.getByText(/never grants an automated KYC\/KYB approval/i)).toBeTruthy();
    expect(screen.getByText("Record verification consent")).toBeTruthy();
  });

  it("keeps the treasury journey separate from fund movement", () => {
    render(<StakeholderOnboardingWorkspace role="treasury_operator" signals={emptySignals} onNavigate={vi.fn()} />);

    expect(screen.getByTestId("stakeholder-onboarding-treasury_operator")).toBeTruthy();
    expect(screen.getByText("Build a controlled payment path")).toBeTruthy();
    expect(screen.getByText(/does not move funds/i)).toBeTruthy();
  });

  it("gives auditors a read-only evidence journey", () => {
    render(<StakeholderOnboardingWorkspace role="auditor" signals={emptySignals} onNavigate={vi.fn()} />);

    expect(screen.getByTestId("stakeholder-onboarding-auditor")).toBeTruthy();
    expect(screen.getByText("Inspect attributable control evidence")).toBeTruthy();
    expect(screen.getByText(/cannot approve a payment/i)).toBeTruthy();
  });

  it("shows milestone progress only from supplied recorded signals", () => {
    render(
      <StakeholderOnboardingWorkspace
        role="treasury_operator"
        signals={{ ...emptySignals, liquidityPositions: 1, rateLocks: 1 }}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByText("2/4")).toBeTruthy();
    expect(screen.getAllByText(/Record available/)).toHaveLength(2);
  });

  it("withholds role guidance until a user is authenticated", () => {
    render(<StakeholderOnboardingWorkspace role={undefined} signals={emptySignals} onNavigate={vi.fn()} />);

    expect(screen.getByText("Sign in to see your controlled workflow")).toBeTruthy();
    expect(screen.queryByText("Establish controlled operating foundations")).toBeNull();
  });
});
