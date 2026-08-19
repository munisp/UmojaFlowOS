import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KycDocumentReviewTable } from "./KycDocumentReviewControls";

/**
 * Manual review is the only path by which a KYC document changes state; no model
 * output may do it. These regressions hold the console to that rule: the control
 * appears only for a reviewing role, only from a non-terminal state, and only
 * with an attributable rationale.
 */

const ROW = {
  id: "b71c0a94-2f3d-4a58-9c17-6e8d0f4a2b31",
  customerLegalName: "Corridor Importer Ltd",
  documentType: "identity_document",
  originalFilename: "passport.pdf",
  reviewStatus: "under_review",
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  uploadedAt: new Date("2026-08-01T09:00:00.000Z"),
};

describe("KYC document review workflow", () => {
  afterEach(() => cleanup());

  it("distinguishes a loading ledger from an empty one and restates the byte-free guarantee", () => {
    const { unmount } = render(
      <KycDocumentReviewTable rows={[]} loading canReview={false} pending={false} submit={vi.fn()} />,
    );
    expect(screen.getByText(/Loading canonical PostgreSQL KYC document review records/i)).toBeTruthy();
    unmount();

    render(<KycDocumentReviewTable rows={[]} loading={false} canReview={false} pending={false} submit={vi.fn()} />);
    expect(screen.getByText(/never contains document bytes/i)).toBeTruthy();
  });

  it("shows the record but no review control to a role that may not review", () => {
    render(<KycDocumentReviewTable rows={[ROW]} loading={false} canReview={false} pending={false} submit={vi.fn()} />);

    expect(screen.getByText(/Corridor Importer Ltd · identity document/)).toBeTruthy();
    expect(screen.queryByLabelText("Set review state for passport.pdf")).toBeNull();
    expect(screen.queryByLabelText("Review note for passport.pdf")).toBeNull();
  });

  it("keeps the record control disabled until both a state and a substantive rationale are given", () => {
    const submit = vi.fn();
    render(<KycDocumentReviewTable rows={[ROW]} loading={false} canReview pending={false} submit={submit} />);

    const record = screen.getByRole("button", { name: "Record" }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Set review state for passport.pdf"), { target: { value: "approved" } });
    expect(record.disabled).toBe(true);

    // A token rationale is not a rationale.
    fireEvent.change(screen.getByLabelText("Review note for passport.pdf"), { target: { value: "ok" } });
    expect(record.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Review note for passport.pdf"), {
      target: { value: "Identity document matched against the registry record." },
    });
    expect(record.disabled).toBe(false);

    fireEvent.submit(record.closest("form")!);
    expect(submit).toHaveBeenCalledWith({
      documentId: ROW.id,
      reviewStatus: "approved",
      reviewNote: "Identity document matched against the registry record.",
    });
  });

  it("offers only the transitions permitted from the current state", () => {
    render(<KycDocumentReviewTable rows={[ROW]} loading={false} canReview pending={false} submit={vi.fn()} />);
    const control = screen.getByLabelText("Set review state for passport.pdf") as HTMLSelectElement;

    expect(Array.from(control.options).map(option => option.value)).toEqual([
      "",
      "approved",
      "rejected",
      "expired",
    ]);
  });

  it("offers no control at all once a document is rejected", () => {
    render(
      <KycDocumentReviewTable
        rows={[{ ...ROW, reviewStatus: "rejected", reviewNote: "Document could not be verified.", reviewedBy: "officer-1", reviewedAt: new Date("2026-08-02T10:00:00.000Z") }]}
        loading={false}
        canReview
        pending={false}
        submit={vi.fn()}
      />,
    );

    // A rejected document is terminal, so no re-review affordance may exist.
    expect(screen.queryByLabelText("Set review state for passport.pdf")).toBeNull();
    expect(screen.getByText(/Latest review note: Document could not be verified./)).toBeTruthy();
    expect(screen.getByText(/Reviewed by officer-1/)).toBeTruthy();
  });
});
