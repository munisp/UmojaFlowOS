import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const vendorsQuery = vi.fn();
const workspaceQuery = vi.fn();
const updateArchetype = vi.fn();
const recordEvidence = vi.fn();
const decideG1 = vi.fn();
const decideG2 = vi.fn();
const decideG3 = vi.fn();
const decideG4 = vi.fn();
const createOnboarding = vi.fn();

const baseVendor = {
  id: "cp-1",
  legalName: "Meridian Sanctions Screening Ltd",
  jurisdiction: "NG",
  counterpartyType: "sanctions_provider",
  complianceVendorArchetype: null,
  evidenceCount: "0",
  createdAt: new Date("2026-08-28T00:00:00Z"),
};

const baseWorkspace = {
  counterparty: { id: "cp-1", legalName: "Meridian Sanctions Screening Ltd", counterpartyType: "sanctions_provider", jurisdiction: "NG", complianceVendorArchetype: null, createdAt: new Date("2026-08-28T00:00:00Z") },
  evidenceItems: [],
  authorizations: [],
  onboarding: undefined,
  gateDecisions: [],
  activity: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { complianceVendors: { invalidate: vi.fn() }, complianceVendorWorkspace: { invalidate: vi.fn() }, counterpartyOnboardings: { invalidate: vi.fn() } } }),
    postgres: {
      complianceVendors: { useQuery: () => vendorsQuery() },
      complianceVendorWorkspace: { useQuery: () => workspaceQuery() },
      updateCounterpartyComplianceVendorArchetype: { useMutation: () => ({ isPending: false, mutate: updateArchetype, error: null }) },
      recordComplianceVendorEvidenceItem: { useMutation: () => ({ isPending: false, mutate: recordEvidence, error: null }) },
      createCounterpartyOnboarding: { useMutation: () => ({ isPending: false, mutate: createOnboarding, error: null }) },
      decideComplianceVendorSecurityPostureGate: { useMutation: () => ({ isPending: false, mutate: decideG1, error: null }) },
      decideComplianceVendorCoverageFeasibilityGate: { useMutation: () => ({ isPending: false, mutate: decideG2, error: null }) },
      decideComplianceVendorFalsePositiveCeilingGate: { useMutation: () => ({ isPending: false, mutate: decideG3, error: null }) },
      decideComplianceVendorAnnualReviewGate: { useMutation: () => ({ isPending: false, mutate: decideG4, error: null }) },
    },
  },
}));

import { ComplianceVendorWorkspace } from "./ComplianceVendorWorkspace";

describe("compliance vendor workspace", () => {
  afterEach(cleanup);

  it("withholds the workspace from a role with no access", () => {
    vendorsQuery.mockReturnValue({ data: [], isLoading: false });
    render(<ComplianceVendorWorkspace role="provider_contact" />);
    expect(screen.getByText(/no access to compliance vendor records/i)).toBeTruthy();
  });

  it("filters the vendor list by search text", () => {
    vendorsQuery.mockReturnValue({ data: [baseVendor, { ...baseVendor, id: "cp-2", legalName: "Other Analytics", jurisdiction: "KE" }], isLoading: false });
    render(<ComplianceVendorWorkspace role="admin" />);
    fireEvent.change(screen.getByLabelText(/search compliance vendors/i), { target: { value: "Other" } });
    expect(screen.queryByText("Meridian Sanctions Screening Ltd")).toBeNull();
    expect(screen.getByText("Other Analytics")).toBeTruthy();
  });

  it("opens a vendor workspace showing all four OM §9.6 gates as not evaluated", () => {
    vendorsQuery.mockReturnValue({ data: [baseVendor], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<ComplianceVendorWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(screen.getByRole("heading", { name: "Meridian Sanctions Screening Ltd" })).toBeTruthy();
    expect(screen.getByText(/G1 Security posture/)).toBeTruthy();
    expect(screen.getByText(/G4 Annual review/)).toBeTruthy();
    expect(screen.getAllByText(/Not evaluated/).length).toBe(4);
  });

  it("saves the archetype from the Archetype tab", async () => {
    const user = userEvent.setup();
    vendorsQuery.mockReturnValue({ data: [baseVendor], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<ComplianceVendorWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /^archetype$/i }));
    fireEvent.change(screen.getByLabelText(/archetype \(om/i), { target: { value: "sanctions_screening" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(updateArchetype).toHaveBeenCalledWith({ counterpartyId: "cp-1", archetype: "sanctions_screening" });
  });

  it("records an evidence item from the Evidence Pack tab", async () => {
    const user = userEvent.setup();
    vendorsQuery.mockReturnValue({ data: [baseVendor], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<ComplianceVendorWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /evidence pack/i }));
    fireEvent.change(screen.getByLabelText(/evidence url/i), { target: { value: "https://example.com/soc2.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: /^record evidence$/i }));
    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ counterpartyId: "cp-1", evidenceType: "soc2_or_iso27001_report", evidenceUri: "https://example.com/soc2.pdf" }));
  });

  it("requires an onboarding record before any gate can be decided, then routes G4 to the annual-review mutation", async () => {
    const user = userEvent.setup();
    vendorsQuery.mockReturnValue({ data: [baseVendor], isLoading: false });
    workspaceQuery.mockReturnValue({
      data: {
        ...baseWorkspace,
        onboarding: { id: "onboarding-1", counterpartyId: "cp-1", legalName: "Meridian Sanctions Screening Ltd", counterpartyType: "sanctions_provider", jurisdiction: "NG", countryOverlays: ["NIGERIA_NGN"], stage: "technical_readiness", cycleNumber: 1, legalEvidenceUri: "https://example.com/legal.pdf", technicalEvidenceUri: null, pilotEvidenceUri: null, recertificationDueAt: null, currentReason: null, decisions: [] },
      },
      isLoading: false,
    });
    render(<ComplianceVendorWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /gates & decisions/i }));
    const approveButtons = screen.getAllByRole("button", { name: /^approve$/i });
    fireEvent.click(approveButtons[3]);
    expect(decideG4).not.toHaveBeenCalled();
    const rationaleFields = screen.getAllByPlaceholderText(/decision rationale/i);
    fireEvent.change(rationaleFields[3], { target: { value: "Annual review passed with no sanctions exposure or coverage gap." } });
    fireEvent.click(approveButtons[3]);
    expect(decideG4).toHaveBeenCalledWith({ onboardingId: "onboarding-1", decision: "approved", rationale: "Annual review passed with no sanctions exposure or coverage gap." });
  });
});
