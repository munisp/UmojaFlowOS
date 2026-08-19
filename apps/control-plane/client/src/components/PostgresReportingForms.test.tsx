import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresCustomerOnboardingForm } from "./PostgresCustomerOnboardingForm";
import { PostgresReportDraftForm } from "./PostgresReportDraftForm";
import { PostgresReportTransitionForm } from "./PostgresReportTransitionForm";

/**
 * The last three console forms that had no DOM coverage. Each writes canonical
 * records, so the properties that matter are that they submit exactly what the
 * operator selected, that they cannot be submitted without their required
 * evidence, and that they promise nothing beyond a record.
 */

function formOf(buttonName: RegExp) {
  return screen.getByRole("button", { name: buttonName }).closest("form") as HTMLFormElement;
}

function setField(form: HTMLFormElement, name: string, value: string) {
  const field = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
  return field;
}

describe("canonical customer onboarding form", () => {
  afterEach(() => cleanup());

  it("states that recording a customer creates no payment and no KYC disposition", () => {
    render(<PostgresCustomerOnboardingForm pending={false} submit={vi.fn()} />);
    expect(screen.getByText(/creates no payment instruction and no automatic KYC\/KYB disposition/i)).toBeTruthy();
  });

  it("trims submitted values so a whitespace-padded identifier cannot create a near-duplicate", () => {
    const submit = vi.fn();
    render(<PostgresCustomerOnboardingForm pending={false} submit={submit} />);
    const form = formOf(/Record canonical customer/i);

    setField(form, "legalName", "  Corridor Importer Ltd  ");
    setField(form, "registrationIdentifier", "  RC-1029384  ");
    fireEvent.submit(form);

    expect(submit).toHaveBeenCalledWith({
      legalName: "Corridor Importer Ltd",
      registrationIdentifier: "RC-1029384",
    });
  });

  it("requires both a legal name and a registration identifier", () => {
    render(<PostgresCustomerOnboardingForm pending={false} submit={vi.fn()} />);
    const form = formOf(/Record canonical customer/i);

    for (const name of ["legalName", "registrationIdentifier"]) {
      const field = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
      expect(field.required).toBe(true);
      expect(field.minLength).toBe(2);
    }
  });

  it("disables submission while a write is in flight", () => {
    render(<PostgresCustomerOnboardingForm pending submit={vi.fn()} />);
    expect((screen.getByRole("button", { name: /Recording/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("regulatory report draft form", () => {
  afterEach(() => cleanup());

  it("submits the selected regulator and corridor with a parsed reporting period", () => {
    const submit = vi.fn();
    render(<PostgresReportDraftForm pending={false} submit={submit} />);

    fireEvent.change(screen.getByDisplayValue("CBN"), { target: { value: "CBK" } });
    fireEvent.change(screen.getByDisplayValue("Nigeria (NGN)"), { target: { value: "KENYA_KES" } });

    const form = formOf(/Create PostgreSQL draft/i);
    setField(form, "legalEntityId", "7f1c2a3b-4d5e-4f60-8a71-9b2c3d4e5f60");
    setField(form, "reportType", "cross_border_settlement_return");
    setField(form, "periodStart", "2026-07-01");
    setField(form, "periodEnd", "2026-07-31");
    fireEvent.submit(form);

    expect(submit).toHaveBeenCalledTimes(1);
    const payload = submit.mock.calls[0][0];
    expect(payload.regulator).toBe("CBK");
    expect(payload.corridor).toBe("KENYA_KES");
    expect(payload.legalEntityId).toBe("7f1c2a3b-4d5e-4f60-8a71-9b2c3d4e5f60");
    expect(payload.periodStart instanceof Date).toBe(true);
    expect(payload.periodEnd instanceof Date).toBe(true);
    expect(payload.periodStart.getTime()).toBeLessThan(payload.periodEnd.getTime());
  });

  it("constrains the legal-entity field to a UUID shape so a free-text entity cannot be drafted against", () => {
    render(<PostgresReportDraftForm pending={false} submit={vi.fn()} />);
    const field = formOf(/Create PostgreSQL draft/i).querySelector('[name="legalEntityId"]') as HTMLInputElement;

    expect(field.required).toBe(true);
    expect(field.pattern).toBe("[0-9a-fA-F-]{36}");
  });

  it("offers exactly the three corridor regulators", () => {
    render(<PostgresReportDraftForm pending={false} submit={vi.fn()} />);
    const regulator = screen.getByDisplayValue("CBN") as HTMLSelectElement;
    expect(Array.from(regulator.options).map(option => option.value)).toEqual(["CBN", "CBK", "SARB"]);
  });
});

describe("regulatory report transition form", () => {
  afterEach(() => cleanup());

  const ROWS = [{ id: "2b8c1d0e-3f4a-4b5c-8d6e-7f8a9b0c1d2e", regulator: "SARB", reportType: "exchange_control_return" }];

  it("submits the selected state with its reason and optional evidence", () => {
    const submit = vi.fn();
    render(<PostgresReportTransitionForm rows={ROWS} pending={false} submit={submit} />);

    fireEvent.change(screen.getByDisplayValue("under review"), { target: { value: "approved" } });
    const form = formOf(/Record workflow state/i);
    setField(form, "statusReason", "Independent compliance approval recorded.");
    setField(form, "artifactUri", "https://storage.example/reports/sarb-2026-07.pdf");
    setField(form, "evidenceManifest", '{"ledger_export":"2026-07"}');
    fireEvent.submit(form);

    expect(submit).toHaveBeenCalledWith({
      reportId: ROWS[0].id,
      status: "approved",
      statusReason: "Independent compliance approval recorded.",
      artifactUri: "https://storage.example/reports/sarb-2026-07.pdf",
      evidenceManifest: { ledger_export: "2026-07" },
      submissionReference: undefined,
    });
  });

  it("refuses a malformed evidence manifest rather than submitting a partial transition", () => {
    const submit = vi.fn();
    render(<PostgresReportTransitionForm rows={ROWS} pending={false} submit={submit} />);

    const form = formOf(/Record workflow state/i);
    setField(form, "statusReason", "Attempting a transition with broken evidence.");
    setField(form, "evidenceManifest", "{not valid json");
    fireEvent.submit(form);

    expect(submit).not.toHaveBeenCalled();
  });

  it("requires a substantive reason for every state change", () => {
    render(<PostgresReportTransitionForm rows={ROWS} pending={false} submit={vi.fn()} />);
    const reason = formOf(/Record workflow state/i).querySelector('[name="statusReason"]') as HTMLInputElement;

    expect(reason.required).toBe(true);
    expect(reason.minLength).toBe(8);
  });

  it("omits an empty submission reference rather than sending a blank string", () => {
    const submit = vi.fn();
    render(<PostgresReportTransitionForm rows={ROWS} pending={false} submit={submit} />);

    const form = formOf(/Record workflow state/i);
    setField(form, "statusReason", "Returned for correction by the reviewer.");
    fireEvent.submit(form);

    const payload = submit.mock.calls[0][0];
    expect(payload.submissionReference).toBeUndefined();
    expect(payload.artifactUri).toBeUndefined();
    expect(payload.evidenceManifest).toBeUndefined();
  });
});
