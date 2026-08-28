import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const issuersQuery = vi.fn();
const workspaceQuery = vi.fn();
const updateArchetype = vi.fn();
const recordEvidence = vi.fn();
const decideG1 = vi.fn();
const decideG2 = vi.fn();
const decideG3 = vi.fn();
const decideG4 = vi.fn();
const createOnboarding = vi.fn();

const baseIssuer = {
  id: "cp-1",
  legalName: "Continental Reserve Stablecoin Ltd",
  jurisdiction: "NG",
  stablecoinIssuerArchetype: null,
  evidenceCount: "0",
  createdAt: new Date("2026-08-28T00:00:00Z"),
};

const baseWorkspace = {
  counterparty: { id: "cp-1", legalName: "Continental Reserve Stablecoin Ltd", counterpartyType: "stablecoin_provider", jurisdiction: "NG", stablecoinIssuerArchetype: null, createdAt: new Date("2026-08-28T00:00:00Z") },
  evidenceItems: [],
  authorizations: [],
  onboarding: undefined,
  gateDecisions: [],
  activity: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { stablecoinIssuers: { invalidate: vi.fn() }, stablecoinIssuerWorkspace: { invalidate: vi.fn() }, counterpartyOnboardings: { invalidate: vi.fn() } } }),
    postgres: {
      stablecoinIssuers: { useQuery: () => issuersQuery() },
      stablecoinIssuerWorkspace: { useQuery: () => workspaceQuery() },
      updateCounterpartyStablecoinIssuerArchetype: { useMutation: () => ({ isPending: false, mutate: updateArchetype, error: null }) },
      recordStablecoinIssuerEvidenceItem: { useMutation: () => ({ isPending: false, mutate: recordEvidence, error: null }) },
      createCounterpartyOnboarding: { useMutation: () => ({ isPending: false, mutate: createOnboarding, error: null }) },
      decideStablecoinIssuerLicenceReservePostureGate: { useMutation: () => ({ isPending: false, mutate: decideG1, error: null }) },
      decideStablecoinIssuerMintRedeemGate: { useMutation: () => ({ isPending: false, mutate: decideG2, error: null }) },
      decideStablecoinIssuerChainReadinessGate: { useMutation: () => ({ isPending: false, mutate: decideG3, error: null }) },
      decideStablecoinIssuerOperatingPostureGate: { useMutation: () => ({ isPending: false, mutate: decideG4, error: null }) },
    },
  },
}));

import { StablecoinIssuerWorkspace } from "./StablecoinIssuerWorkspace";

describe("stablecoin issuer workspace", () => {
  afterEach(cleanup);

  it("withholds the workspace from a role with no access", () => {
    issuersQuery.mockReturnValue({ data: [], isLoading: false });
    render(<StablecoinIssuerWorkspace role="provider_contact" />);
    expect(screen.getByText(/no access to stablecoin issuer records/i)).toBeTruthy();
  });

  it("filters the issuer list by search text", () => {
    issuersQuery.mockReturnValue({ data: [baseIssuer, { ...baseIssuer, id: "cp-2", legalName: "Other Chain", jurisdiction: "KE" }], isLoading: false });
    render(<StablecoinIssuerWorkspace role="admin" />);
    fireEvent.change(screen.getByLabelText(/search stablecoin issuers/i), { target: { value: "Other" } });
    expect(screen.queryByText("Continental Reserve Stablecoin Ltd")).toBeNull();
    expect(screen.getByText("Other Chain")).toBeTruthy();
  });

  it("opens an issuer workspace showing all four OM §8.6 gates as not evaluated", () => {
    issuersQuery.mockReturnValue({ data: [baseIssuer], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<StablecoinIssuerWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(screen.getByRole("heading", { name: "Continental Reserve Stablecoin Ltd" })).toBeTruthy();
    expect(screen.getByText(/G1 Licence & reserve posture/)).toBeTruthy();
    expect(screen.getByText(/G3 Chain readiness/)).toBeTruthy();
    expect(screen.getAllByText(/Not evaluated/).length).toBe(4);
  });

  it("saves the archetype from the Archetype & Reserve Posture tab", async () => {
    const user = userEvent.setup();
    issuersQuery.mockReturnValue({ data: [baseIssuer], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<StablecoinIssuerWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /archetype & reserve posture/i }));
    fireEvent.change(screen.getByLabelText(/archetype \(om/i), { target: { value: "regulated_issuer" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(updateArchetype).toHaveBeenCalledWith({ counterpartyId: "cp-1", archetype: "regulated_issuer" });
  });

  it("records an evidence item from the Evidence Pack tab", async () => {
    const user = userEvent.setup();
    issuersQuery.mockReturnValue({ data: [baseIssuer], isLoading: false });
    workspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<StablecoinIssuerWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /evidence pack/i }));
    fireEvent.change(screen.getByLabelText(/evidence url/i), { target: { value: "https://example.com/reserve-attestation.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: /^record evidence$/i }));
    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ counterpartyId: "cp-1", evidenceType: "issuer_regulatory_licence", evidenceUri: "https://example.com/reserve-attestation.pdf" }));
  });

  it("requires an onboarding record before any gate can be decided, then routes G3 to the chain-readiness mutation", async () => {
    const user = userEvent.setup();
    issuersQuery.mockReturnValue({ data: [baseIssuer], isLoading: false });
    workspaceQuery.mockReturnValue({
      data: {
        ...baseWorkspace,
        onboarding: { id: "onboarding-1", counterpartyId: "cp-1", legalName: "Continental Reserve Stablecoin Ltd", counterpartyType: "stablecoin_provider", jurisdiction: "NG", countryOverlays: ["NIGERIA_NGN"], stage: "technical_readiness", cycleNumber: 1, legalEvidenceUri: "https://example.com/legal.pdf", technicalEvidenceUri: null, pilotEvidenceUri: null, recertificationDueAt: null, currentReason: null, decisions: [] },
      },
      isLoading: false,
    });
    render(<StablecoinIssuerWorkspace role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /gates & decisions/i }));
    const approveButtons = screen.getAllByRole("button", { name: /^approve$/i });
    fireEvent.click(approveButtons[2]);
    expect(decideG3).not.toHaveBeenCalled();
    const rationaleFields = screen.getAllByPlaceholderText(/decision rationale/i);
    fireEvent.change(rationaleFields[2], { target: { value: "Finality confirmed and gas strategy operational for this chain." } });
    fireEvent.click(approveButtons[2]);
    expect(decideG3).toHaveBeenCalledWith({ onboardingId: "onboarding-1", decision: "approved", rationale: "Finality confirmed and gas strategy operational for this chain." });
  });
});
