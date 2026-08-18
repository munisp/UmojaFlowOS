import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  canDecideRecommendation,
  canProposeRebalancing,
  TreasuryBufferPolicyTable,
  TreasuryRecommendationForm,
  TreasuryRecommendationTable,
  type BufferPolicy,
  type TreasuryRecommendation,
} from "./TreasuryRebalancingControls";

afterEach(cleanup);

const NOW = new Date("2026-08-18T12:00:00Z");

const policy: BufferPolicy = {
  id: "policy-1",
  corridor: "SOUTH_AFRICA_ZAR",
  currency: "ZAR",
  approvedDailyOutflow: "1000000.00",
  minimumBufferPct: "0.20",
  targetBufferPct: "0.35",
  maxRecommendationPctOfTarget: "2.00",
  effectiveFrom: new Date("2026-08-01T00:00:00Z"),
  effectiveTo: null,
  approvedBy: "treasury-approver",
};

function recommendation(overrides: Partial<TreasuryRecommendation> = {}): TreasuryRecommendation {
  return {
    id: "rec-1",
    corridor: "SOUTH_AFRICA_ZAR",
    currency: "ZAR",
    reconciledAvailableBalance: "150000.00",
    reconciledAt: new Date("2026-08-18T09:00:00Z"),
    balanceSourceReference: "custody-statement-2026-08-18",
    verifiedNearTermFundingGap: "400000.00",
    fundingGapSourceReference: "obligation-schedule-2026-08-18",
    minimumBufferAmount: "200000.00",
    targetBufferAmount: "350000.00",
    computedRecommendationAmount: "200000.00",
    status: "proposed",
    proposedBy: "treasury-proposer",
    proposedAt: new Date("2026-08-18T10:00:00Z"),
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    expiresAt: new Date("2026-08-19T10:00:00Z"),
    ...overrides,
  };
}

describe("treasury rebalancing role policy", () => {
  it("permits only treasury operators and administrators to propose", () => {
    expect(canProposeRebalancing("treasury_operator")).toBe(true);
    expect(canProposeRebalancing("admin")).toBe(true);
    expect(canProposeRebalancing("compliance_officer")).toBe(false);
    expect(canProposeRebalancing("auditor")).toBe(false);
    expect(canProposeRebalancing(undefined)).toBe(false);
  });

  it("blocks a proposer from deciding their own recommendation", () => {
    const rec = recommendation();
    expect(canDecideRecommendation("treasury_operator", rec, "treasury-proposer", NOW)).toBe(false);
    expect(canDecideRecommendation("treasury_operator", rec, "treasury-second-operator", NOW)).toBe(true);
  });

  it("blocks a decision on an expired or already-decided recommendation", () => {
    const expired = recommendation({ expiresAt: new Date("2026-08-18T11:00:00Z") });
    expect(canDecideRecommendation("treasury_operator", expired, "treasury-second-operator", NOW)).toBe(false);

    const decided = recommendation({ status: "approved", decidedBy: "treasury-second-operator" });
    expect(canDecideRecommendation("treasury_operator", decided, "treasury-third-operator", NOW)).toBe(false);
  });
});

describe("treasury rebalancing console rendering", () => {
  it("shows the reconciled inputs, computed amount, and both source references", () => {
    render(
      <TreasuryRecommendationTable
        recommendations={[recommendation()]}
        loading={false}
        role="auditor"
        currentSubject="auditor-subject"
        pending={false}
        decide={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.getByText("150000.00")).toBeTruthy();
    expect(screen.getByText("400000.00")).toBeTruthy();
    expect(screen.getByText("custody-statement-2026-08-18")).toBeTruthy();
    expect(screen.getByText(/Proposed by treasury-proposer/)).toBeTruthy();
  });

  it("states in every row that no transfer is initiated", () => {
    render(
      <TreasuryRecommendationTable
        recommendations={[recommendation()]}
        loading={false}
        role="treasury_operator"
        currentSubject="treasury-second-operator"
        pending={false}
        decide={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.getByText(/No transfer, payment, or settlement instruction is initiated/)).toBeTruthy();
  });

  it("offers the decision form only to an independent treasury operator", () => {
    const { unmount } = render(
      <TreasuryRecommendationTable
        recommendations={[recommendation()]}
        loading={false}
        role="treasury_operator"
        currentSubject="treasury-second-operator"
        pending={false}
        decide={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("treasury-decision-form-rec-1")).toBeTruthy();
    unmount();

    render(
      <TreasuryRecommendationTable
        recommendations={[recommendation()]}
        loading={false}
        role="treasury_operator"
        currentSubject="treasury-proposer"
        pending={false}
        decide={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId("treasury-decision-form-rec-1")).toBeNull();
    expect(screen.getByTestId("treasury-self-approval-blocked-rec-1")).toBeTruthy();
  });

  it("shows auditors the ledger without any decision control", () => {
    render(
      <TreasuryRecommendationTable
        recommendations={[recommendation()]}
        loading={false}
        role="auditor"
        currentSubject="auditor-subject"
        pending={false}
        decide={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId("treasury-decision-form-rec-1")).toBeNull();
    expect(screen.queryByRole("button", { name: /record decision/i })).toBeNull();
  });

  it("states plainly when no recommendation or policy exists", () => {
    const { unmount } = render(
      <TreasuryRecommendationTable
        recommendations={[]}
        loading={false}
        role="treasury_operator"
        currentSubject="treasury-second-operator"
        pending={false}
        decide={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("treasury-recommendations-empty")).toBeTruthy();
    expect(screen.getByText(/No amount is computed from an assumed balance/)).toBeTruthy();
    unmount();

    render(<TreasuryBufferPolicyTable policies={[]} loading={false} />);
    expect(screen.getByText("No approved buffer policy")).toBeTruthy();
  });

  it("withholds the proposal form until an approved policy exists", () => {
    const { unmount } = render(<TreasuryRecommendationForm policies={[]} pending={false} submit={() => undefined} />);
    expect(screen.getByTestId("treasury-proposal-unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    render(<TreasuryRecommendationForm policies={[policy]} pending={false} submit={() => undefined} />);
    expect(screen.getByTestId("treasury-proposal-form")).toBeTruthy();
    expect(screen.getByText(/Submitting a proposal never moves funds/)).toBeTruthy();
  });

  it("renders the approved policy thresholds it will apply", () => {
    render(<TreasuryBufferPolicyTable policies={[policy]} loading={false} />);
    expect(screen.getByText("SOUTH AFRICA ZAR")).toBeTruthy();
    expect(screen.getByText("1000000.00 ZAR")).toBeTruthy();
    expect(screen.getByText("0.20 / 0.35")).toBeTruthy();
    expect(screen.getByText("2.00 of target")).toBeTruthy();
  });
});
