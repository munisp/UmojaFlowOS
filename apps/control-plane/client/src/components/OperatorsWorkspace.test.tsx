import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const operatorsQuery = vi.fn();
const changeRole = vi.fn();
const deactivate = vi.fn();

const baseOperators = [
  { keycloakUserId: "kc-1", subject: "kc_admin1", name: "Ada Admin", email: "ada@example.com", enabled: true, role: "admin", roleStatus: "assigned", assignedBy: "kc_admin0", assignedAt: new Date("2026-08-01T00:00:00Z") },
  { keycloakUserId: "kc-2", subject: "kc_compliance1", name: "Cece Compliance", email: "cece@example.com", enabled: true, role: "compliance_officer", roleStatus: "assigned", assignedBy: "kc_admin1", assignedAt: new Date("2026-08-10T00:00:00Z") },
  { keycloakUserId: "kc-3", subject: "kc_norole1", name: "Nate Norole", email: "nate@example.com", enabled: true, role: null, roleStatus: null, assignedBy: null, assignedAt: null },
];

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { operators: { invalidate: vi.fn() } } }),
    postgres: {
      operators: { useQuery: () => operatorsQuery() },
      changeOperatorRole: { useMutation: () => ({ isPending: false, mutate: changeRole, error: null }) },
      deactivateOperator: { useMutation: () => ({ isPending: false, mutate: deactivate, error: null }) },
    },
  },
}));

import { OperatorsWorkspace } from "./OperatorsWorkspace";

describe("operators workspace", () => {
  afterEach(cleanup);

  it("withholds the directory from a non-admin role", () => {
    operatorsQuery.mockReturnValue({ data: [], isLoading: false });
    render(<OperatorsWorkspace role="compliance_officer" currentSubject="kc_compliance1" />);
    expect(screen.getByText(/only administrators may view or manage/i)).toBeTruthy();
  });

  it("lists every account with its role, including roleless ones", () => {
    operatorsQuery.mockReturnValue({ data: baseOperators, isLoading: false });
    render(<OperatorsWorkspace role="admin" currentSubject="kc_admin1" />);
    expect(screen.getByText("Ada Admin")).toBeTruthy();
    expect(screen.getByText("Cece Compliance")).toBeTruthy();
    expect(screen.getByText("Nate Norole")).toBeTruthy();
    const noRoleRow = screen.getByText("Nate Norole").closest("tr")!;
    expect(within(noRoleRow).getByText("No role")).toBeTruthy();
  });

  it("filters the directory by role", () => {
    operatorsQuery.mockReturnValue({ data: baseOperators, isLoading: false });
    render(<OperatorsWorkspace role="admin" currentSubject="kc_admin1" />);
    fireEvent.change(screen.getByLabelText(/filter by role/i), { target: { value: "admin" } });
    expect(screen.getByText("Ada Admin")).toBeTruthy();
    expect(screen.queryByText("Cece Compliance")).toBeNull();
  });

  it("changes a compliance officer's role to treasury operator", () => {
    operatorsQuery.mockReturnValue({ data: baseOperators, isLoading: false });
    render(<OperatorsWorkspace role="admin" currentSubject="kc_admin1" />);
    const row = screen.getByText("Cece Compliance").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /change role/i }));
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "treasury_operator" } });
    fireEvent.click(within(row).getByRole("button", { name: /confirm/i }));
    expect(changeRole).toHaveBeenCalledWith({ subject: "kc_compliance1", role: "treasury_operator" });
  });

  it("does not offer a deactivate action for the signed-in admin's own row", () => {
    operatorsQuery.mockReturnValue({ data: baseOperators, isLoading: false });
    render(<OperatorsWorkspace role="admin" currentSubject="kc_admin1" />);
    const ownRow = screen.getByText("Ada Admin").closest("tr")!;
    expect(within(ownRow).queryByRole("button", { name: /deactivate/i })).toBeNull();
    expect(within(ownRow).getByText(/this is you/i)).toBeTruthy();
  });

  it("requires a reason before deactivating another operator", () => {
    operatorsQuery.mockReturnValue({ data: baseOperators, isLoading: false });
    render(<OperatorsWorkspace role="admin" currentSubject="kc_admin1" />);
    const row = screen.getByText("Cece Compliance").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /deactivate/i }));
    const confirmButton = within(row).getByRole("button", { name: /confirm deactivation/i }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(within(row).getByPlaceholderText(/reason for deactivation/i), { target: { value: "Left the compliance team; access no longer needed." } });
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    expect(deactivate).toHaveBeenCalledWith({ keycloakUserId: "kc-2", subject: "kc_compliance1", reason: "Left the compliance team; access no longer needed." });
  });
});
