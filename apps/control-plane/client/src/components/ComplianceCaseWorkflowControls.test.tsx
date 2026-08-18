import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allowedCaseTransitions,
  ComplianceCaseDispositionControls,
  VerificationConsentForm,
  type ComplianceCaseRow,
} from "./ComplianceCaseWorkflowControls";

afterEach(cleanup);

function caseRow(overrides: Partial<ComplianceCaseRow> = {}): ComplianceCaseRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    caseType: "transaction_monitoring",
    status: "under_review",
    severity: "high",
    sourceReference: "case://regression/source",
    openedAt: new Date("2026-08-01T10:00:00Z"),
    ...overrides,
  };
}

describe("compliance case disposition lifecycle", () => {
  it("mirrors the server lifecycle exactly", () => {
    expect(allowedCaseTransitions("open")).toEqual(["under_review", "closed"]);
    expect(allowedCaseTransitions("under_review")).toEqual(["cleared", "escalated", "reported", "closed"]);
    expect(allowedCaseTransitions("escalated")).toEqual(["reported", "cleared", "closed"]);
    expect(allowedCaseTransitions("cleared")).toEqual(["closed"]);
    expect(allowedCaseTransitions("reported")).toEqual(["closed"]);
    // A closed case is terminal, so no disposition is offered.
    expect(allowedCaseTransitions("closed")).toEqual([]);
  });

  it("offers no disposition form for a closed case and explains why", () => {
    render(<ComplianceCaseDispositionControls cases={[caseRow({ status: "closed" })]} canDispose pending={false} dispose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /record disposition/i })).toBeNull();
    expect(screen.getByText(/never reopened/i)).toBeTruthy();
  });

  it("hides the disposition form from a non-compliance reader", () => {
    render(<ComplianceCaseDispositionControls cases={[caseRow()]} canDispose={false} pending={false} dispose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /record disposition/i })).toBeNull();
    expect(screen.getByText(/restricted to compliance officers/i)).toBeTruthy();
  });

  it("offers a compliance officer only the valid next dispositions", () => {
    render(<ComplianceCaseDispositionControls cases={[caseRow({ status: "cleared" })]} canDispose pending={false} dispose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /record disposition/i })).toBeTruthy();
    // A cleared case can only be closed, so the select exposes exactly one option.
    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toBe("Closed");
    expect(allowedCaseTransitions("cleared")).toHaveLength(1);
  });

  it("requires an attributable rationale of meaningful length", () => {
    render(<ComplianceCaseDispositionControls cases={[caseRow()]} canDispose pending={false} dispose={vi.fn()} />);
    const rationale = document.querySelector('input[name="decisionReason"]') as HTMLInputElement;
    expect(rationale.required).toBe(true);
    expect(Number(rationale.minLength)).toBeGreaterThanOrEqual(20);
  });

  it("never renders an empty case list as a cleared state", () => {
    render(<ComplianceCaseDispositionControls cases={[]} canDispose pending={false} dispose={vi.fn()} />);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/No compliance cases/i);
    expect(text).not.toMatch(/\bcleared\b/i);
  });
});

describe("verification consent capture", () => {
  it("is unavailable to a non-compliance reader", () => {
    render(<VerificationConsentForm canCapture={false} pending={false} submit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /record verification consent/i })).toBeNull();
    expect(screen.getByText(/restricted to compliance officers/i)).toBeTruthy();
  });

  it("requires scope, notice version, subject, and a stated purpose", () => {
    render(<VerificationConsentForm canCapture pending={false} submit={vi.fn()} />);
    for (const name of ["subjectReference", "consentVersion", "purpose"]) {
      const field = document.querySelector(`input[name="${name}"]`) as HTMLInputElement;
      expect(field.required).toBe(true);
    }
    const purpose = document.querySelector('input[name="purpose"]') as HTMLInputElement;
    expect(Number(purpose.minLength)).toBeGreaterThanOrEqual(10);
  });

  it("states that consent precedes any analysis", () => {
    render(<VerificationConsentForm canCapture pending={false} submit={vi.fn()} />);
    expect(document.body.textContent).toMatch(/before any document is analysed/i);
  });
});
