import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const partnersQuery = vi.fn();
const workspaceQuery = vi.fn();
const updateArchetype = vi.fn();
const recordEvidence = vi.fn();
const decideG2 = vi.fn();
const createOnboarding = vi.fn();
const decideLegal = vi.fn();
const decideTechnical = vi.fn();
const decidePilot = vi.fn();
const beginRecert = vi.fn();

const basePartner = {
  id: "cp-1",
  legalName: "Nairobi Corridor Correspondent Bank Ltd",
  jurisdiction: "KE",
  bankArchetype: null,
  evidenceCount: "0",
  createdAt: new Date("2026-08-28T00:00:00Z"),
};

const baseWorkspace = {
  counterparty: { id: "cp-1", legalName: "Nairobi Corridor Correspondent Bank Ltd", counterpartyType: "correspondent_bank", jurisdiction: "KE", bankArchetype: null, createdAt: new Date("2026-08-28T00:00:00Z") },
  evidenceItems: [],
  authorizations: [],
  onboarding: undefined,
  cryptoPostureDecisions: [],
  activity: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { bankingPartners: { invalidate: vi.fn() }, bankingPartnerWorkspace: { invalidate: vi.fn() }, counterpartyOnboardings: { invalidate: vi.fn() } } }),
    postgres: {
      bankingPartners: { useQuery: () => partnersQuery() },
      bankingPartnerWorkspace: { useQuery: () => workspaceQuery() },
      updateCounterpartyBankArchetype: { useMutation: () => ({ isPending: false, mutate: updateArchetype, error: null }) },
      recordBankEvidenceItem: { useMutation: () => ({ isPending: false, mutate: recordEvidence, error: null }) },
      decideCryptoPostureGate: { useMutation: () => ({ isPending: false, mutate: decideG2, error: null }) },
      createCounterpartyOnboarding: { useMutation: () => ({ isPending: false, mutate: createOnboarding, error: null }) },
      decideCounterpartyOnboardingGate: { useMutation: () => ({ isPending: false, mutate: decideLegal, error: null }) },
      decideTechnicalOnboardingGate: { useMutation: () => ({ isPending: false, mutate: decideTechnical, error: null }) },
      decideTreasuryPilotOnboardingGate: { useMutation: () => ({ isPending: false, mutate: decidePilot, error: null }) },
      beginCounterpartyRecertification: { useMutation: () => ({ isPending: false, mutate: beginRecert, error: null }) },
    },
  },
}));

import { BankingPartnerWorkspace } from "./BankingPartnerWorkspace";

describe("banking partner workspace", () => {
  afterEach(cleanup);

  it("withholds the workspace from a role with no access", () => {
    partnersQuery.mockReturnValue({ data: [], isLoading: false });
    render(<BankingPartnerWorkspace role="provider_contact" />);
    expect(screen.getByText(/no access to banking partner records/i)).toBeTruthy();
  });

  it("filters the partner list by search text", () => {
    partnersQuery.mockReturnValue({ data: [basePartner, { ...basePartner, id: "cp-2", legalName: "Other Bank", jurisdiction: "ZA" }], isLoading: false });
    render(<BankingPartnerWorkspace role="admin" />);
    fireEvent.change(screen.getByLabelText(/search banking partners/i), { target: { value: "Other" } });
    expect(screen.queryByText("Nairobi Corridor Correspondent Bank Ltd")).toBeNull();
    expect(screen.getByText("Other Bank")).toBeTruthy();
  });

  it("opens a partner workspace showing OM §6.6 gate status on Overview", () => {
    partnersQuery.mockReturnValue({ data: [basePartner], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<BankingPartnerWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(screen.getByRole("heading", { name: "Nairobi Corridor Correspondent Bank Ltd" })).toBeTruthy();
    expect(screen.getByText(/G2 Crypto \/ VASP posture/)).toBeTruthy();
    expect(screen.getByText(/Not evaluated/)).toBeTruthy();
  });

  it("saves the archetype from the Archetype & Licensing tab", async () => {
    const user = userEvent.setup();
    partnersQuery.mockReturnValue({ data: [basePartner], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<BankingPartnerWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /archetype & licensing/i }));
    fireEvent.change(screen.getByLabelText(/archetype \(om/i), { target: { value: "correspondent_bank" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(updateArchetype).toHaveBeenCalledWith({ counterpartyId: "cp-1", archetype: "correspondent_bank" });
  });

  it("records an evidence item from the Evidence Pack tab", async () => {
    const user = userEvent.setup();
    partnersQuery.mockReturnValue({ data: [basePartner], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<BankingPartnerWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /evidence pack/i }));
    fireEvent.change(screen.getByLabelText(/evidence url/i), { target: { value: "https://example.com/licence.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: /^record evidence$/i }));
    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ counterpartyId: "cp-1", evidenceType: "banking_licence", evidenceUri: "https://example.com/licence.pdf" }));
  });

  it("requires a rationale before recording a Gate G2 decision, once an onboarding lifecycle exists", async () => {
    const user = userEvent.setup();
    partnersQuery.mockReturnValue({ data: [basePartner], isLoading: false });
    workspaceQuery.mockReturnValue({
      data: {
        ...baseWorkspace,
        onboarding: { id: "onboarding-1", counterpartyId: "cp-1", legalName: "Nairobi Corridor Correspondent Bank Ltd", counterpartyType: "correspondent_bank", jurisdiction: "KE", countryOverlays: ["KENYA_KES"], stage: "technical_readiness", cycleNumber: 1, legalEvidenceUri: "https://example.com/legal.pdf", technicalEvidenceUri: null, pilotEvidenceUri: null, recertificationDueAt: null, currentReason: null, decisions: [] },
      },
      isLoading: false,
    });
    render(<BankingPartnerWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /gates & decisions/i }));
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(decideG2).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/decision rationale/i), { target: { value: "VASP-flow acceptance policy reviewed and Travel-Rule readiness confirmed." } });
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(decideG2).toHaveBeenCalledWith({ onboardingId: "onboarding-1", decision: "approved", rationale: "VASP-flow acceptance policy reviewed and Travel-Rule readiness confirmed." });
  });
});
