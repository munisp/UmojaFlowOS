import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KycEvidenceLedger } from "./KycEvidenceControls";

function evidenceRow(overrides: Partial<Parameters<typeof KycEvidenceLedger>[0]["evidence"][number]> = {}) {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    caseKind: "kyc",
    documentClass: "national_identity_card",
    kind: "engine_unavailable",
    disposition: "unavailable",
    engineName: "ollama",
    engineVersion: "unavailable",
    modelTag: null,
    modelDigest: null,
    signals: [],
    limitations: ["Private Ollama runtime was unreachable, so no analysis was performed."],
    createdAt: new Date("2026-08-18T12:00:00Z"),
    ...overrides,
  };
}

describe("unavailable analysis runtime surfacing", () => {
  // Each case renders the ledger independently, so the previous render must be
  // torn down or its banner would still be in the document.
  afterEach(() => cleanup());

  it("presents an unavailable runtime as a blocked review, not a result", () => {
    render(<KycEvidenceLedger evidence={[evidenceRow()]} loading={false} />);
    expect(screen.getByText(/analysis runtime unavailable/i)).toBeTruthy();
    expect(screen.getByText(/review blocked/i)).toBeTruthy();
    expect(screen.getByText(/no verification determination exists/i)).toBeTruthy();
    expect(screen.getByText(/remains pending human review/i)).toBeTruthy();
  });

  it("states the recorded limitation rather than implying a clean check", () => {
    render(<KycEvidenceLedger evidence={[evidenceRow()]} loading={false} />);
    // The limitation is shown in the ledger row; the banner repeats the blocked
    // state, so both occurrences are expected.
    expect(screen.getAllByText(/unreachable, so no analysis was performed/i).length).toBeGreaterThan(0);
    // No approval or pass language may appear for an unavailable runtime.
    expect(screen.queryByText(/\bapproved\b/i)).toBeNull();
    expect(screen.queryByText(/\bpassed\b/i)).toBeNull();
    expect(screen.queryByText(/\bverified\b/i)).toBeNull();
  });

  it("shows no blocked-review banner when every record carries real evidence", () => {
    render(
      <KycEvidenceLedger
        evidence={[
          evidenceRow({
            id: "22222222-2222-4222-8222-222222222222",
            kind: "ocr",
            disposition: "review_required",
            engineName: "paddleocr",
            engineVersion: "2.7.0",
            signals: [{ name: "text_regions", count: 8 }],
            limitations: ["Extraction only; no identity assertion."],
          }),
        ]}
        loading={false}
      />,
    );
    expect(screen.queryAllByText(/review blocked/i)).toHaveLength(0);
  });

  it("counts multiple unavailable records so the blocked scope is explicit", () => {
    render(
      <KycEvidenceLedger
        evidence={[
          evidenceRow({ id: "33333333-3333-4333-8333-333333333333" }),
          evidenceRow({ id: "44444444-4444-4444-8444-444444444444" }),
        ]}
        loading={false}
      />,
    );
    expect(screen.getByText(/2 evidence records report an unavailable analysis runtime/i)).toBeTruthy();
  });
});
