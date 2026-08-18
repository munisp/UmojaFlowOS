import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  KycAnalysisJobTable,
  KycEvidenceLedger,
  KycEvidenceNotice,
  ReviewerDecisionForm,
  ReviewerDecisionHistory,
} from "./KycEvidenceControls";

afterEach(cleanup);

const EVIDENCE_KINDS = [
  "ocr",
  "document_structure",
  "visual_consistency",
  "presentation_attack_risk",
  "engine_unavailable",
] as const;

/**
 * Builds one persisted evidence row per supported kind. The fixture mirrors the
 * shape the canonical PostgreSQL query returns; it is test input for rendering
 * only and is never written to a database.
 */
function evidenceRows() {
  return EVIDENCE_KINDS.map((kind, index) => ({
    id: `evidence-${index}`,
    caseKind: index % 2 === 0 ? "kyc" : "kyb",
    documentClass: "identity_document",
    kind,
    disposition: kind === "engine_unavailable" ? "unavailable" : "review_required",
    engineName: kind === "ocr" ? "paddleocr" : "ollama",
    engineVersion: "2.7.0",
    modelTag: kind === "visual_consistency" ? "qwen3-vl:8b" : null,
    modelDigest: kind === "visual_consistency" ? "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28" : null,
    signals: [`${kind}_signal_detail`],
    limitations: [`${kind}_limitation_detail`],
    createdAt: new Date("2026-08-18T10:00:00Z"),
  }));
}

describe("KYC/KYB evidence ledger rendering", () => {
  it("renders every supported evidence kind with its disposition", () => {
    render(<KycEvidenceLedger evidence={evidenceRows()} loading={false} />);
    for (const kind of EVIDENCE_KINDS) {
      expect(screen.getByText(kind.replaceAll("_", " "))).toBeTruthy();
    }
    expect(screen.getAllByText("review required").length).toBe(4);
    expect(screen.getByText("unavailable")).toBeTruthy();
  });

  it("renders persisted signals and limitations for each kind", () => {
    render(<KycEvidenceLedger evidence={evidenceRows()} loading={false} />);
    for (const kind of EVIDENCE_KINDS) {
      expect(screen.getByText(new RegExp(`${kind}_signal_detail`))).toBeTruthy();
      expect(screen.getByText(new RegExp(`${kind}_limitation_detail`))).toBeTruthy();
    }
  });

  it("shows engine and model provenance, and states plainly when no model was used", () => {
    render(<KycEvidenceLedger evidence={evidenceRows()} loading={false} />);
    expect(screen.getByText(/qwen3-vl:8b/)).toBeTruthy();
    expect(screen.getByText(/901cae732162/)).toBeTruthy();
    expect(screen.getAllByText("no model").length).toBe(4);
    expect(screen.getByText(/paddleocr/)).toBeTruthy();
  });

  it("distinguishes an empty ledger from a loading ledger without implying a result", () => {
    const { unmount } = render(<KycEvidenceLedger evidence={[]} loading />);
    expect(screen.getByText(/Loading persisted evidence/)).toBeTruthy();
    unmount();

    render(<KycEvidenceLedger evidence={[]} loading={false} />);
    expect(screen.getByText("No persisted analysis evidence")).toBeTruthy();
    // An empty ledger must not be phrased as an approval or a clean result.
    expect(screen.queryByText(/approved/i)).toBeNull();
    expect(screen.queryByText(/passed/i)).toBeNull();
  });

  it("states the document-gated unavailable notice without claiming a disposition", () => {
    render(<KycEvidenceNotice />);
    expect(screen.getByText("Visual analysis is document-gated")).toBeTruthy();
    expect(screen.getByText(/never treated as an approval or rejection/)).toBeTruthy();
  });

  it("renders reviewer decisions with actor, rationale, and timestamp", () => {
    render(
      <ReviewerDecisionHistory
        loading={false}
        decisions={[
          {
            id: "decision-1",
            caseKind: "kyc",
            documentClass: "identity_document",
            disposition: "needs_information",
            rationale: "Source imagery legibility was insufficient for review.",
            decidedBy: "compliance-officer-subject",
            decidedAt: new Date("2026-08-18T11:00:00Z"),
          },
        ]}
      />,
    );
    expect(screen.getByText("needs information")).toBeTruthy();
    expect(screen.getByText(/Source imagery legibility/)).toBeTruthy();
    expect(screen.getByText(/compliance-officer-subject/)).toBeTruthy();
  });

  it("offers no reviewer action when no consent-backed job exists", () => {
    render(<ReviewerDecisionForm jobs={[]} pending={false} submit={() => undefined} />);
    expect(screen.getByText(/requires a persisted, consent-backed analysis job/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("states plainly when no analysis job has been submitted", () => {
    render(<KycAnalysisJobTable jobs={[]} loading={false} />);
    expect(screen.getByText("No authorised analysis jobs")).toBeTruthy();
    expect(screen.getByText(/will not manufacture an identity/)).toBeTruthy();
  });
});
