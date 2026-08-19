import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CounterpartyOnboardingControls, type CounterpartyOnboardingRow } from "./CounterpartyOnboardingControls";

const counterparty = { id: "cp-1", legalName: "Boundary Payments Ltd", counterpartyType: "payment_service_provider", jurisdiction: "Nigeria" };

const legalRow: CounterpartyOnboardingRow = {
  id: "onboarding-1",
  counterpartyId: "cp-1",
  legalName: counterparty.legalName,
  counterpartyType: counterparty.counterpartyType,
  jurisdiction: counterparty.jurisdiction,
  countryOverlays: ["NIGERIA_NGN"],
  stage: "legal_onboarding",
  cycleNumber: 1,
  legalEvidenceUri: "https://evidence.example/legal",
  technicalEvidenceUri: null,
  pilotEvidenceUri: null,
  recertificationDueAt: null,
  currentReason: null,
  decisions: [],
};

const props = {
  counterparties: [counterparty],
  rows: [legalRow],
  loading: false,
  createPending: false,
  decisionPending: false,
  recertificationPending: false,
  error: null,
  create: vi.fn(),
  decideLegal: vi.fn(),
  decideTechnical: vi.fn(),
  decidePilot: vi.fn(),
  beginRecertification: vi.fn(),
};

describe("counterparty onboarding controls", () => {
  afterEach(cleanup);

  it("shows the administrator an evidence-led lifecycle without implying provider activation", () => {
    render(<CounterpartyOnboardingControls {...props} role="admin" />);

    expect(screen.getByText("Start governed onboarding")).toBeTruthy();
    expect(screen.getAllByText("Legal review")).toHaveLength(2);
    expect(screen.getByText(/never activates a provider/i)).toBeTruthy();
    expect(screen.queryByText(/activate provider/i)).toBeNull();
  });

  it("withholds lifecycle creation from compliance while allowing the legal decision form", () => {
    render(<CounterpartyOnboardingControls {...props} role="compliance_officer" />);

    expect(screen.getByText(/only administrators can start/i)).toBeTruthy();
    expect(screen.getByText("Legal review decision")).toBeTruthy();
    expect(screen.queryByText("Start governed onboarding")).toBeNull();
  });

  it("records a legal decision with evidence and rationale through the supplied role-gated handler", async () => {
    const decideLegal = vi.fn();
    render(<CounterpartyOnboardingControls {...props} role="compliance_officer" decideLegal={decideLegal} />);

    await userEvent.type(screen.getByLabelText("Evidence URL"), "https://evidence.example/legal-review");
    await userEvent.type(screen.getByLabelText("Decision rationale"), "Licence and regulatory overlay evidence have been reviewed.");
    await userEvent.click(screen.getByRole("button", { name: /record independent decision/i }));

    expect(decideLegal).toHaveBeenCalledWith({
      onboardingId: "onboarding-1",
      gate: "legal",
      decision: "approved",
      evidenceUri: "https://evidence.example/legal-review",
      rationale: "Licence and regulatory overlay evidence have been reviewed.",
    });
  });

  it("does not offer a legal decision form to a treasury operator", () => {
    render(<CounterpartyOnboardingControls {...props} role="treasury_operator" />);

    expect(screen.queryByText("Legal review decision")).toBeNull();
    expect(screen.getByText(/recorded decisions/i)).toBeTruthy();
  });
});
