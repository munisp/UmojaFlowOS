import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const providersQuery = vi.fn();
const workspaceQuery = vi.fn();
const updateArchetype = vi.fn();
const recordEvidence = vi.fn();
const decideG2 = vi.fn();
const createOnboarding = vi.fn();
const decideLegal = vi.fn();
const decideTechnical = vi.fn();
const decidePilot = vi.fn();
const beginRecert = vi.fn();

const baseProvider = {
  id: "cp-1",
  legalName: "Boundary Regression Provider",
  jurisdiction: "NG",
  lpArchetype: null,
  evidenceCount: "0",
  createdAt: new Date("2026-08-28T00:00:00Z"),
};

const baseWorkspace = {
  counterparty: { id: "cp-1", legalName: "Boundary Regression Provider", counterpartyType: "fx_liquidity_provider", jurisdiction: "NG", lpArchetype: null, createdAt: new Date("2026-08-28T00:00:00Z") },
  evidenceItems: [],
  authorizations: [],
  onboarding: undefined,
  financialSoundnessDecisions: [],
  activity: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { liquidityProviders: { invalidate: vi.fn() }, liquidityProviderWorkspace: { invalidate: vi.fn() }, counterpartyOnboardings: { invalidate: vi.fn() } } }),
    postgres: {
      liquidityProviders: { useQuery: () => providersQuery() },
      liquidityProviderWorkspace: { useQuery: () => workspaceQuery() },
      updateCounterpartyLpArchetype: { useMutation: () => ({ isPending: false, mutate: updateArchetype, error: null }) },
      recordCounterpartyEvidenceItem: { useMutation: () => ({ isPending: false, mutate: recordEvidence, error: null }) },
      decideFinancialSoundnessGate: { useMutation: () => ({ isPending: false, mutate: decideG2, error: null }) },
      createCounterpartyOnboarding: { useMutation: () => ({ isPending: false, mutate: createOnboarding, error: null }) },
      decideCounterpartyOnboardingGate: { useMutation: () => ({ isPending: false, mutate: decideLegal, error: null }) },
      decideTechnicalOnboardingGate: { useMutation: () => ({ isPending: false, mutate: decideTechnical, error: null }) },
      decideTreasuryPilotOnboardingGate: { useMutation: () => ({ isPending: false, mutate: decidePilot, error: null }) },
      beginCounterpartyRecertification: { useMutation: () => ({ isPending: false, mutate: beginRecert, error: null }) },
    },
  },
}));

import { LiquidityProviderWorkspace } from "./LiquidityProviderWorkspace";

describe("liquidity provider workspace", () => {
  afterEach(cleanup);

  it("withholds the workspace from a role with no access", () => {
    providersQuery.mockReturnValue({ data: [], isLoading: false });
    render(<LiquidityProviderWorkspace role="provider_contact" />);
    expect(screen.getByText(/no access to liquidity provider records/i)).toBeTruthy();
  });

  it("filters the provider list by search text", () => {
    providersQuery.mockReturnValue({ data: [baseProvider, { ...baseProvider, id: "cp-2", legalName: "Other Desk", jurisdiction: "KE" }], isLoading: false });
    render(<LiquidityProviderWorkspace role="admin" />);
    fireEvent.change(screen.getByLabelText(/search liquidity providers/i), { target: { value: "Other" } });
    expect(screen.queryByText("Boundary Regression Provider")).toBeNull();
    expect(screen.getByText("Other Desk")).toBeTruthy();
  });

  it("opens a provider workspace showing OM §5.6 gate status on Overview", () => {
    providersQuery.mockReturnValue({ data: [baseProvider], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<LiquidityProviderWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(screen.getByRole("heading", { name: "Boundary Regression Provider" })).toBeTruthy();
    expect(screen.getByText(/G2 Financial soundness/)).toBeTruthy();
    expect(screen.getByText(/Not evaluated/)).toBeTruthy();
  });

  it("saves the archetype from the Archetype & Licensing tab", async () => {
    const user = userEvent.setup();
    providersQuery.mockReturnValue({ data: [baseProvider], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<LiquidityProviderWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /archetype & licensing/i }));
    fireEvent.change(screen.getByLabelText(/archetype \(om/i), { target: { value: "principal_market_maker" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(updateArchetype).toHaveBeenCalledWith({ counterpartyId: "cp-1", archetype: "principal_market_maker" });
  });

  it("records an evidence item from the Evidence Pack tab", async () => {
    const user = userEvent.setup();
    providersQuery.mockReturnValue({ data: [baseProvider], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<LiquidityProviderWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /evidence pack/i }));
    fireEvent.change(screen.getByLabelText(/evidence url/i), { target: { value: "https://example.com/licence.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: /^record evidence$/i }));
    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ counterpartyId: "cp-1", evidenceType: "mm_otc_licence", evidenceUri: "https://example.com/licence.pdf" }));
  });

  it("requires a rationale before recording a Gate G2 decision, once an onboarding lifecycle exists", async () => {
    const user = userEvent.setup();
    providersQuery.mockReturnValue({ data: [baseProvider], isLoading: false });
    workspaceQuery.mockReturnValue({
      data: {
        ...baseWorkspace,
        onboarding: { id: "onboarding-1", counterpartyId: "cp-1", legalName: "Boundary Regression Provider", counterpartyType: "fx_liquidity_provider", jurisdiction: "NG", countryOverlays: ["NIGERIA_NGN"], stage: "technical_readiness", cycleNumber: 1, legalEvidenceUri: "https://example.com/legal.pdf", technicalEvidenceUri: null, pilotEvidenceUri: null, recertificationDueAt: null, currentReason: null, decisions: [] },
      },
      isLoading: false,
    });
    render(<LiquidityProviderWorkspace role="treasury_operator" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /gates & decisions/i }));
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(decideG2).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/decision rationale/i), { target: { value: "Audited financials and insurance certificate reviewed and accepted." } });
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(decideG2).toHaveBeenCalledWith({ onboardingId: "onboarding-1", decision: "approved", rationale: "Audited financials and insurance certificate reviewed and accepted." });
  });
});
