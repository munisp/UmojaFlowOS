import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnalysisJobSubmissionForm,
  type ActiveConsent,
  type AnalysisReadyDocument,
} from "./AnalysisJobSubmissionForm";

afterEach(cleanup);

const consent: ActiveConsent = {
  id: "22222222-2222-4222-8222-222222222222",
  scope: "kyc",
  subjectReference: "customer-reference-001",
  consentVersion: "2026.08",
  purpose: "Identity verification for corridor onboarding",
  grantedAt: new Date("2026-08-01T09:00:00Z"),
  expiresAt: null,
};

const document_: AnalysisReadyDocument = {
  id: "33333333-3333-4333-8333-333333333333",
  customerLegalName: "Example Holdings Limited",
  documentType: "identity_document",
  storageUrl: "https://storage.example/kyc/abc",
  mimeType: "image/jpeg",
  contentSha256: "a".repeat(64),
  reviewStatus: "submitted",
  uploadedAt: new Date("2026-08-02T09:00:00Z"),
};

describe("analysis-job submission", () => {
  it("is unavailable to a non-compliance reader", () => {
    render(<AnalysisJobSubmissionForm consents={[consent]} documents={[document_]} canSubmit={false} pending={false} submit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /submit for document analysis/i })).toBeNull();
    expect(screen.getByText(/restricted to compliance officers/i)).toBeTruthy();
  });

  it("fails closed with no active consent", () => {
    render(<AnalysisJobSubmissionForm consents={[]} documents={[document_]} canSubmit pending={false} submit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /submit for document analysis/i })).toBeNull();
    expect(screen.getByText(/No active consent/i)).toBeTruthy();
  });

  it("fails closed with no verified document", () => {
    render(<AnalysisJobSubmissionForm consents={[consent]} documents={[]} canSubmit pending={false} submit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /submit for document analysis/i })).toBeNull();
    expect(screen.getByText(/No verified document/i)).toBeTruthy();
  });

  it("submits only values taken from the selected canonical records", () => {
    const submit = vi.fn();
    render(<AnalysisJobSubmissionForm consents={[consent]} documents={[document_]} canSubmit pending={false} submit={submit} />);
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(submit).toHaveBeenCalledWith({
      consentId: consent.id,
      kycDocumentId: document_.id,
      caseKind: "kyc",
      documentClass: "identity_document",
      sourceSha256: document_.contentSha256,
      sourceUri: document_.storageUrl,
      mimeType: "image/jpeg",
    });
  });

  it("never offers a model tag, digest, or disposition field", () => {
    render(<AnalysisJobSubmissionForm consents={[consent]} documents={[document_]} canSubmit pending={false} submit={vi.fn()} />);
    // Provenance is server-derived, so the console must expose no way to assert it.
    for (const name of ["selectedModelTag", "selectedModelDigest", "selectedModelRole", "disposition"]) {
      expect(document.querySelector(`[name="${name}"]`)).toBeNull();
    }
    expect(document.body.textContent).toMatch(/selected by the server/i);
  });

  it("states that analysis produces review-required evidence only", () => {
    render(<AnalysisJobSubmissionForm consents={[consent]} documents={[document_]} canSubmit pending={false} submit={vi.fn()} />);
    expect(document.body.textContent).toMatch(/never an approval or rejection/i);
  });

  it("shows the verified digest and storage reference being submitted", () => {
    render(<AnalysisJobSubmissionForm consents={[consent]} documents={[document_]} canSubmit pending={false} submit={vi.fn()} />);
    expect(document.body.textContent).toContain(document_.contentSha256);
    expect(document.body.textContent).toContain(document_.storageUrl);
  });
});
