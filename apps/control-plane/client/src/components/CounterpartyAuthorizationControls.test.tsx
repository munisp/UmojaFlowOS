import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CounterpartyAuthorizationTable } from "./CounterpartyAuthorizationControls";

const rows = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    legalName: "Corridor PSP Nigeria",
    regulator: "CBN",
    licenceReference: "CBN-LIC-0001",
    status: "verified",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
  },
];

describe("registry licence authorisation console rendering", () => {
  afterEach(() => cleanup());

  it("shows the persisted lifecycle state to every operator role", () => {
    render(<CounterpartyAuthorizationTable rows={rows} loading={false} />);

    expect(screen.getByText("Corridor PSP Nigeria")).toBeTruthy();
    expect(screen.getByText("CBN-LIC-0001")).toBeTruthy();
    const stateCell = screen.getByText("verified");
    expect(stateCell.className).toContain("uppercase");
  });

  it("exposes lifecycle controls only when the operator may manage authorisations", () => {
    // The status text itself is unchanged by role; only the lifecycle control is gated.
    const { unmount } = render(<CounterpartyAuthorizationTable rows={rows} loading={false} />);
    expect(screen.queryByLabelText("Set lifecycle for Corridor PSP Nigeria")).toBeNull();
    expect(screen.queryByText("Lifecycle")).toBeNull();
    unmount();

    const transition = vi.fn();
    render(<CounterpartyAuthorizationTable rows={rows} loading={false} canManage transition={transition} />);
    const control = screen.getByLabelText("Set lifecycle for Corridor PSP Nigeria") as HTMLSelectElement;
    expect(control.value).toBe("verified");
    expect(screen.getByText("Lifecycle")).toBeTruthy();
  });

  it("disables the lifecycle control while a transition is in flight", () => {
    render(<CounterpartyAuthorizationTable rows={rows} loading={false} canManage pending transition={() => undefined} />);
    expect((screen.getByLabelText("Set lifecycle for Corridor PSP Nigeria") as HTMLSelectElement).disabled).toBe(true);
  });

  it("states plainly when no licence evidence is recorded instead of implying coverage", () => {
    render(<CounterpartyAuthorizationTable rows={[]} loading={false} canManage />);
    expect(screen.getByText(/No licence authorisation evidence has been recorded/)).toBeTruthy();
  });
});
