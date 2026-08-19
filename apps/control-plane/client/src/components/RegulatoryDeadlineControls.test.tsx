import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegulatoryDeadlineForm, RegulatoryDeadlineTable } from "./RegulatoryDeadlineControls";

/**
 * A regulatory deadline drives reminders, so an unsourced or mis-attributed
 * obligation would produce operational noise that looks authoritative. These
 * regressions hold the console to the same source-reference requirement the
 * procedure enforces.
 */

describe("regulatory deadline register", () => {
  afterEach(() => cleanup());

  it("distinguishes loading from empty and states why an empty register is correct", () => {
    const { unmount } = render(<RegulatoryDeadlineTable rows={[]} loading />);
    expect(screen.getByText(/Loading regulatory deadline records/i)).toBeTruthy();
    unmount();

    render(<RegulatoryDeadlineTable rows={[]} loading={false} />);
    expect(screen.getByText(/No deadline record exists until a compliance officer enters the source-backed/i)).toBeTruthy();
  });

  it("renders a persisted obligation with its regulator, corridor, and state", () => {
    render(
      <RegulatoryDeadlineTable
        loading={false}
        rows={[
          {
            id: "0f9a1b2c-3d4e-4f50-8617-2839a4b5c6d7",
            regulator: "CBK",
            corridor: "KENYA_KES",
            title: "Quarterly cross-border settlement return",
            dueAt: new Date("2026-09-30T15:00:00.000Z"),
            status: "open",
            lastRemindedAt: null,
          },
        ]}
      />,
    );

    expect(screen.getByText("CBK")).toBeTruthy();
    expect(screen.getByText("KENYA KES")).toBeTruthy();
    expect(screen.getByText("Quarterly cross-border settlement return")).toBeTruthy();
    expect(screen.getByText("open").className).toContain("uppercase");
  });
});

describe("regulatory deadline entry form", () => {
  afterEach(() => cleanup());

  it("submits the chosen regulator and corridor rather than the initial defaults", () => {
    const submit = vi.fn();
    render(<RegulatoryDeadlineForm submit={submit} pending={false} />);

    fireEvent.change(screen.getByDisplayValue("CBN"), { target: { value: "SARB" } });
    fireEvent.change(screen.getByDisplayValue("Nigeria (NGN)"), { target: { value: "SOUTH_AFRICA_ZAR" } });

    const form = screen.getByRole("button", { name: /Record regulatory deadline/i }).closest("form");
    const title = form!.querySelector('input[name="title"]') as HTMLInputElement;
    const dueAt = form!.querySelector('input[name="dueAt"]') as HTMLInputElement;
    const source = form!.querySelector('input[name="sourceReference"]') as HTMLInputElement;

    fireEvent.change(title, { target: { value: "SARB exchange control quarterly return" } });
    fireEvent.change(dueAt, { target: { value: "2026-09-30T15:00" } });
    fireEvent.change(source, { target: { value: "https://www.resbank.co.za/regulatory-notice" } });
    fireEvent.submit(form!);

    expect(submit).toHaveBeenCalledTimes(1);
    const payload = submit.mock.calls[0][0];
    expect(payload.regulator).toBe("SARB");
    expect(payload.corridor).toBe("SOUTH_AFRICA_ZAR");
    expect(payload.sourceReference).toBe("https://www.resbank.co.za/regulatory-notice");
    expect(payload.dueAt instanceof Date).toBe(true);
  });

  it("requires a URL-typed source reference so an obligation cannot be entered unsourced", () => {
    render(<RegulatoryDeadlineForm submit={vi.fn()} pending={false} />);
    const form = screen.getByRole("button", { name: /Record regulatory deadline/i }).closest("form");
    const source = form!.querySelector('input[name="sourceReference"]') as HTMLInputElement;

    expect(source.required).toBe(true);
    expect(source.type).toBe("url");
  });

  it("offers exactly the three corridor regulators and no others", () => {
    render(<RegulatoryDeadlineForm submit={vi.fn()} pending={false} />);
    const regulator = screen.getByDisplayValue("CBN") as HTMLSelectElement;

    expect(Array.from(regulator.options).map(option => option.value)).toEqual(["CBN", "CBK", "SARB"]);
  });
});
