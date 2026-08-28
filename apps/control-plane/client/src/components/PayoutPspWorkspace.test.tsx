import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pspsQuery = vi.fn();
const workspaceQuery = vi.fn();
const updateArchetype = vi.fn();
const recordEvidence = vi.fn();
const decideG1 = vi.fn();
const decideG2 = vi.fn();
const decideG3 = vi.fn();
const decideG4 = vi.fn();
const createOnboarding = vi.fn();

const basePsp = {
  id: "cp-1",
  legalName: "Lagos Corridor Payout PSP Ltd",
  jurisdiction: "NG",
  pspArchetype: null,
  evidenceCount: "0",
  createdAt: new Date("2026-08-28T00:00:00Z"),
};

const baseWorkspace = {
  counterparty: { id: "cp-1", legalName: "Lagos Corridor Payout PSP Ltd", counterpartyType: "licensed_psp", jurisdiction: "NG", pspArchetype: null, createdAt: new Date("2026-08-28T00:00:00Z") },
  evidenceItems: [],
  authorizations: [],
  onboarding: undefined,
  gateDecisions: [],
  activity: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { payoutPsps: { invalidate: vi.fn() }, payoutPspWorkspace: { invalidate: vi.fn() }, counterpartyOnboardings: { invalidate: vi.fn() } } }),
    postgres: {
      payoutPsps: { useQuery: () => pspsQuery() },
      payoutPspWorkspace: { useQuery: () => workspaceQuery() },
      updateCounterpartyPspArchetype: { useMutation: () => ({ isPending: false, mutate: updateArchetype, error: null }) },
      recordPspEvidenceItem: { useMutation: () => ({ isPending: false, mutate: recordEvidence, error: null }) },
      createCounterpartyOnboarding: { useMutation: () => ({ isPending: false, mutate: createOnboarding, error: null }) },
      decidePspLicenceRailGate: { useMutation: () => ({ isPending: false, mutate: decideG1, error: null }) },
      decidePspSettlementCutoffGate: { useMutation: () => ({ isPending: false, mutate: decideG2, error: null }) },
      decidePspBoundedLiveGate: { useMutation: () => ({ isPending: false, mutate: decideG3, error: null }) },
      decidePspFailoverGate: { useMutation: () => ({ isPending: false, mutate: decideG4, error: null }) },
    },
  },
}));

import { PayoutPspWorkspace } from "./PayoutPspWorkspace";

describe("payout PSP workspace", () => {
  afterEach(cleanup);

  it("withholds the workspace from a role with no access", () => {
    pspsQuery.mockReturnValue({ data: [], isLoading: false });
    render(<PayoutPspWorkspace role="provider_contact" />);
    expect(screen.getByText(/no access to payout psp records/i)).toBeTruthy();
  });

  it("filters the PSP list by search text", () => {
    pspsQuery.mockReturnValue({ data: [basePsp, { ...basePsp, id: "cp-2", legalName: "Other Rail", jurisdiction: "KE" }], isLoading: false });
    render(<PayoutPspWorkspace role="admin" />);
    fireEvent.change(screen.getByLabelText(/search payout psps/i), { target: { value: "Other" } });
    expect(screen.queryByText("Lagos Corridor Payout PSP Ltd")).toBeNull();
    expect(screen.getByText("Other Rail")).toBeTruthy();
  });

  it("opens a PSP workspace showing all four OM §7.6 gates as not evaluated", () => {
    pspsQuery.mockReturnValue({ data: [basePsp], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<PayoutPspWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(screen.getByRole("heading", { name: "Lagos Corridor Payout PSP Ltd" })).toBeTruthy();
    expect(screen.getByText(/G1 Licence & rail coverage/)).toBeTruthy();
    expect(screen.getByText(/G4 Failover rail/)).toBeTruthy();
    expect(screen.getAllByText(/Not evaluated/).length).toBe(4);
  });

  it("saves the archetype from the Archetype & Coverage tab", async () => {
    const user = userEvent.setup();
    pspsQuery.mockReturnValue({ data: [basePsp], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<PayoutPspWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /archetype & coverage/i }));
    fireEvent.change(screen.getByLabelText(/archetype \(om/i), { target: { value: "mobile_money" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(updateArchetype).toHaveBeenCalledWith({ counterpartyId: "cp-1", archetype: "mobile_money" });
  });

  it("records an evidence item from the Evidence Pack tab", async () => {
    const user = userEvent.setup();
    pspsQuery.mockReturnValue({ data: [basePsp], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<PayoutPspWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /evidence pack/i }));
    fireEvent.change(screen.getByLabelText(/evidence url/i), { target: { value: "https://example.com/psp-licence.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: /^record evidence$/i }));
    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ counterpartyId: "cp-1", evidenceType: "psp_licence", evidenceUri: "https://example.com/psp-licence.pdf" }));
  });

  it("requires an onboarding record before any gate can be decided, then routes G2 to the settlement-cutoff mutation", async () => {
    const user = userEvent.setup();
    pspsQuery.mockReturnValue({ data: [basePsp], isLoading: false });
    workspaceQuery.mockReturnValue({
      data: {
        ...baseWorkspace,
        onboarding: { id: "onboarding-1", counterpartyId: "cp-1", legalName: "Lagos Corridor Payout PSP Ltd", counterpartyType: "licensed_psp", jurisdiction: "NG", countryOverlays: ["NIGERIA_NGN"], stage: "technical_readiness", cycleNumber: 1, legalEvidenceUri: "https://example.com/legal.pdf", technicalEvidenceUri: null, pilotEvidenceUri: null, recertificationDueAt: null, currentReason: null, decisions: [] },
      },
      isLoading: false,
    });
    render(<PayoutPspWorkspace role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /gates & decisions/i }));
    const approveButtons = screen.getAllByRole("button", { name: /^approve$/i });
    fireEvent.click(approveButtons[1]);
    expect(decideG2).not.toHaveBeenCalled();
    const rationaleFields = screen.getAllByPlaceholderText(/decision rationale/i);
    fireEvent.change(rationaleFields[1], { target: { value: "Cutoffs honoured and reconciliation within tolerance for this corridor." } });
    fireEvent.click(approveButtons[1]);
    expect(decideG2).toHaveBeenCalledWith({ onboardingId: "onboarding-1", decision: "approved", rationale: "Cutoffs honoured and reconciliation within tolerance for this corridor." });
  });
});
