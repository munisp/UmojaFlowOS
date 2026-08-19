import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SarStrFilingForm, SarStrFilingTable } from "./SarStrFilingControls";

/**
 * SAR/STR filing is the most consequential compliance surface in the console: a
 * filing asserts a suspicion to a regulator. These regressions hold the console
 * to the same fail-closed rules the procedures enforce, so a UI change cannot
 * quietly create an affordance the server would refuse, or worse, one it would
 * accept for the wrong reason.
 */

const CASES = [
  { id: "8f14e45f-ea1b-4d2e-9c1a-3b7f0d5a6c21", caseType: "transaction_monitoring", sourceReference: "case://cbn-001" },
];

const ROW = {
  id: "3d2f8a11-5c44-4b90-8e21-7a6b0c9d4e55",
  corridor: "SOUTH_AFRICA_ZAR",
  filingType: "str",
  filingAuthority: "Financial Intelligence Centre",
  sourceReference: "case://sarb-014",
  status: "pending_submission",
  submissionReference: null,
  createdAt: new Date("2026-08-01T09:00:00.000Z"),
};

describe("SAR/STR filing draft form", () => {
  afterEach(() => cleanup());

  it("offers no draft affordance at all when no compliance case exists", () => {
    const submit = vi.fn();
    render(<SarStrFilingForm cases={[]} pending={false} submit={submit} />);

    // A filing must reference a real case. With none available the form is
    // withheld entirely rather than rendered and rejected on submit.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/can only reference an existing canonical compliance case/i)).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits the selected corridor and classification rather than silent defaults", () => {
    const submit = vi.fn();
    render(<SarStrFilingForm cases={CASES} pending={false} submit={submit} />);

    fireEvent.change(screen.getByDisplayValue("Nigeria (NGN)"), { target: { value: "SOUTH_AFRICA_ZAR" } });
    fireEvent.change(screen.getByDisplayValue("SAR"), { target: { value: "str" } });
    fireEvent.change(screen.getByPlaceholderText(/Authoritative recipient name/i), {
      target: { value: "Financial Intelligence Centre" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Immutable case or filing evidence reference/i), {
      target: { value: "case://sarb-014" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /Create SAR\/STR draft/i }));

    expect(submit).toHaveBeenCalledWith({
      complianceCaseId: CASES[0].id,
      corridor: "SOUTH_AFRICA_ZAR",
      filingType: "str",
      filingAuthority: "Financial Intelligence Centre",
      sourceReference: "case://sarb-014",
    });
  });

  it("offers all three corridors and requires a source evidence reference", () => {
    render(<SarStrFilingForm cases={CASES} pending={false} submit={vi.fn()} />);

    for (const label of ["Nigeria (NGN)", "Kenya (KES)", "South Africa (ZAR)"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    const evidence = screen.getByPlaceholderText(/Immutable case or filing evidence reference/i) as HTMLInputElement;
    expect(evidence.required).toBe(true);
    expect(evidence.minLength).toBe(4);
  });
});

describe("SAR/STR filing register", () => {
  afterEach(() => cleanup());

  it("distinguishes a loading register from an empty one without implying a filing exists", () => {
    const { unmount } = render(
      <SarStrFilingTable rows={[]} loading canManage={false} pending={false} transition={vi.fn()} />,
    );
    expect(screen.getByText(/Loading canonical PostgreSQL SAR\/STR filing records/i)).toBeTruthy();
    unmount();

    render(<SarStrFilingTable rows={[]} loading={false} canManage={false} pending={false} transition={vi.fn()} />);
    expect(screen.getByText(/No SAR\/STR filing is recorded/i)).toBeTruthy();
    expect(screen.getByText(/official submission remains provider-gated/i)).toBeTruthy();
  });

  it("withholds the lifecycle control from a role that may not manage filings", () => {
    render(<SarStrFilingTable rows={[ROW]} loading={false} canManage={false} pending={false} transition={vi.fn()} />);

    // The record itself stays readable; only the action is gated.
    expect(screen.getByText("Financial Intelligence Centre")).toBeTruthy();
    expect(screen.queryByLabelText("Transition str filing")).toBeNull();
    expect(screen.queryByText("Lifecycle")).toBeNull();
  });

  it("refuses to mark a filing submitted without a verified submission reference", () => {
    const transition = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("   ");
    render(<SarStrFilingTable rows={[ROW]} loading={false} canManage pending={false} transition={transition} />);

    fireEvent.change(screen.getByLabelText("Transition str filing"), { target: { value: "submitted" } });

    // A blank reference is not evidence of a submission, so nothing is recorded.
    expect(prompt).toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it("records a submitted transition together with its official reference", () => {
    const transition = vi.fn();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("FIC-2026-000181");
    render(<SarStrFilingTable rows={[ROW]} loading={false} canManage pending={false} transition={transition} />);

    fireEvent.change(screen.getByLabelText("Transition str filing"), { target: { value: "submitted" } });

    expect(transition).toHaveBeenCalledWith({
      filingId: ROW.id,
      status: "submitted",
      submissionReference: "FIC-2026-000181",
    });
    prompt.mockRestore();
  });

  it("offers no transition out of a terminal state", () => {
    render(
      <SarStrFilingTable
        rows={[{ ...ROW, status: "submitted", submissionReference: "FIC-2026-000181" }]}
        loading={false}
        canManage
        pending={false}
        transition={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Transition str filing")).toBeNull();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("FIC-2026-000181")).toBeTruthy();
  });
});
