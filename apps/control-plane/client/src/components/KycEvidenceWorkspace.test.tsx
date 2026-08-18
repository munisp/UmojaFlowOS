import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KycEvidenceWorkspace } from "./KycEvidenceWorkspace";

afterEach(cleanup);

const jobs = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    caseKind: "kyc",
    documentClass: "identity_document",
    sourceSha256: "a".repeat(64),
    state: "review_required",
    submittedBy: "compliance-subject",
    submittedAt: new Date("2026-08-18T09:00:00Z"),
  },
];

const evidence = [
  {
    id: "evidence-1",
    caseKind: "kyc",
    documentClass: "identity_document",
    kind: "presentation_attack_risk",
    disposition: "review_required",
    engineName: "ollama",
    engineVersion: "0.12.0",
    modelTag: "qwen3-vl:8b",
    modelDigest: "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28",
    signals: ["surface_glare_inconsistency"],
    limitations: ["single_frame_only"],
    createdAt: new Date("2026-08-18T09:30:00Z"),
  },
];

const decisions = [
  {
    id: "decision-1",
    caseKind: "kyc",
    documentClass: "identity_document",
    disposition: "needs_information",
    rationale: "Requested a second document capture under even lighting.",
    decidedBy: "compliance-subject",
    decidedAt: new Date("2026-08-18T10:00:00Z"),
  },
];

function renderFor(role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" | undefined) {
  return render(
    <KycEvidenceWorkspace
      role={role}
      jobs={jobs}
      evidence={evidence}
      decisions={decisions}
      loadingEvidence={false}
      loadingDecisions={false}
      pendingDecision={false}
      submitDecision={() => undefined}
    />,
  );
}

describe("KYC/KYB evidence workspace role visibility", () => {
  it("gives compliance officers the reviewer-decision form and full ledger", () => {
    renderFor("compliance_officer");
    expect(screen.getByTestId("kyc-reviewer-decision-form")).toBeTruthy();
    expect(screen.queryByTestId("kyc-reviewer-decision-readonly")).toBeNull();
    expect(screen.getByTestId("kyc-evidence-ledger")).toBeTruthy();
    expect(screen.getByTestId("kyc-reviewer-decision-history")).toBeTruthy();
    expect(screen.getByText("presentation attack risk")).toBeTruthy();
  });

  it("gives administrators the delegated reviewer surface", () => {
    renderFor("admin");
    expect(screen.getByTestId("kyc-reviewer-decision-form")).toBeTruthy();
    expect(screen.getByTestId("kyc-evidence-ledger")).toBeTruthy();
  });

  it("gives auditors the ledger and history but no decision control", () => {
    renderFor("auditor");
    expect(screen.queryByTestId("kyc-reviewer-decision-form")).toBeNull();
    expect(screen.getByTestId("kyc-reviewer-decision-readonly")).toBeTruthy();
    expect(screen.getByTestId("kyc-evidence-ledger")).toBeTruthy();
    expect(screen.getByTestId("kyc-reviewer-decision-history")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record reviewer decision/i })).toBeNull();
  });

  it("gives treasury operators read-only access with no decision control", () => {
    renderFor("treasury_operator");
    expect(screen.queryByTestId("kyc-reviewer-decision-form")).toBeNull();
    expect(screen.getByTestId("kyc-reviewer-decision-readonly")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record reviewer decision/i })).toBeNull();
  });

  it("shows no evidence at all to an unauthenticated visitor", () => {
    renderFor(undefined);
    expect(screen.getByTestId("kyc-evidence-unauthorised")).toBeTruthy();
    expect(screen.queryByTestId("kyc-evidence-workspace")).toBeNull();
    expect(screen.queryByTestId("kyc-evidence-ledger")).toBeNull();
    expect(screen.queryByTestId("kyc-reviewer-decision-history")).toBeNull();
    // No signal, model provenance, or disposition may leak into the notice.
    expect(screen.queryByText(/qwen3-vl:8b/)).toBeNull();
    expect(screen.queryByText(/surface_glare_inconsistency/)).toBeNull();
    expect(screen.queryByText(/needs information/)).toBeNull();
  });

  it("always presents the document-gated notice to authorised readers", () => {
    for (const role of ["admin", "compliance_officer", "treasury_operator", "auditor"] as const) {
      const { unmount } = renderFor(role);
      expect(screen.getByText("Visual analysis is document-gated")).toBeTruthy();
      expect(screen.getByText(/never treated as an approval or rejection/)).toBeTruthy();
      unmount();
    }
  });
});
