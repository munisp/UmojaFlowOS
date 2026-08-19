import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { providerContactAssignments: { invalidate: vi.fn() }, cbnLiaisonAssignments: { invalidate: vi.fn() } } }),
    postgres: {
      providerContactAssignments: { useQuery: () => ({ data: [], isLoading: false }) },
      cbnLiaisonAssignments: { useQuery: () => ({ data: [], isLoading: false }) },
      recordProviderContactEvidence: { useMutation: () => ({ isPending: false, mutate: vi.fn(), error: null }) },
      recordCbnLiaisonEvidence: { useMutation: () => ({ isPending: false, mutate: vi.fn(), error: null }) },
    },
  },
}));

import { StakeholderPortal } from "./StakeholderPortal";

describe("six-role stakeholder portals", () => {
  afterEach(cleanup);

  it.each([
    ["admin", /Control-plane stewardship/i],
    ["compliance_officer", /Human evidence and decision review/i],
    ["treasury_operator", /Liquidity and controlled-payment preparation/i],
    ["auditor", /Read-only assurance and traceability/i],
  ] as const)("renders the dedicated %s portal", (role, title) => {
    render(<StakeholderPortal role={role} onNavigate={vi.fn()} />);
    expect(screen.getByText(title)).toBeTruthy();
  });

  it("makes provider-contact evidence scope and non-execution boundary visible", () => {
    render(<StakeholderPortal role="provider_contact" onNavigate={vi.fn()} />);
    expect(screen.getByText(/Scoped external technical-evidence exchange/i)).toBeTruthy();
    expect(screen.getByText(/cannot reveal or set a secret value, activate a provider/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /payment/i })).toBeNull();
  });

  it("makes CBN liaison correspondence scope and non-submission boundary visible", () => {
    render(<StakeholderPortal role="cbn_liaison" onNavigate={vi.fn()} />);
    expect(screen.getByText(/Scoped CBN sandbox correspondence record/i)).toBeTruthy();
    expect(screen.getByText(/remains not submitted and cannot establish CBN acknowledgement/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
  });
});
