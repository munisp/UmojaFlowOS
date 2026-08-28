import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const grantOperatingRole = vi.fn();
const assignExternalStakeholder = vi.fn();
const onboardOperator = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { operatorAccessRequests: { invalidate: vi.fn() }, customers: { invalidate: vi.fn() } } }),
    postgres: {
      operatorAccessRequests: {
        useQuery: () => ({
          data: [{ subject: "kc_pending-subject", name: "Jane Operator", email: "jane@example.com", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }],
          isLoading: false,
        }),
      },
      counterparties: { useQuery: () => ({ data: [{ id: "cp-1", legalName: "Boundary PSP", jurisdiction: "Nigeria" }] }) },
      cbnSandboxDossiers: { useQuery: () => ({ data: [{ id: "dossier-1", legalEntityName: "Applicant Ltd", productName: "Sandbox product" }] }) },
      grantOperatingRole: { useMutation: () => ({ isPending: false, mutate: grantOperatingRole }) },
      assignExternalStakeholder: { useMutation: () => ({ isPending: false, mutate: assignExternalStakeholder }) },
      operatorAccountCreationAvailable: { useQuery: () => ({ data: true }) },
      onboardOperator: { useMutation: () => ({ isPending: false, mutate: onboardOperator }) },
    },
  },
}));

import { OperatorOnboardingControls } from "./OperatorOnboardingControls";

describe("operator onboarding controls", () => {
  afterEach(cleanup);

  it("withholds the pending-access queue from a non-administrator", () => {
    render(<OperatorOnboardingControls role="auditor" />);
    expect(screen.getByText(/administrator action/i)).toBeTruthy();
    expect(screen.queryByText("Jane Operator")).toBeNull();
  });

  it("shows an administrator who is waiting and lets them grant a core operating role", () => {
    render(<OperatorOnboardingControls role="admin" />);
    expect(screen.getByText("Jane Operator")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /grant role/i }));
    fireEvent.click(screen.getByRole("button", { name: /^grant role$/i, hidden: false }));

    expect(grantOperatingRole).toHaveBeenCalledWith({ subject: "kc_pending-subject", role: "compliance_officer" });
    expect(assignExternalStakeholder).not.toHaveBeenCalled();
  });

  it("requires a scoped counterparty before granting the provider_contact role", () => {
    render(<OperatorOnboardingControls role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /grant role/i }));
    // The always-open onboarding panel above has its own "Operating role"
    // select, so the pending-request grant form's copy is the second one.
    const [, pendingGrantRoleSelect] = screen.getAllByLabelText(/operating role/i);
    fireEvent.change(pendingGrantRoleSelect, { target: { value: "provider_contact" } });

    expect(screen.getByLabelText(/scoped counterparty/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/scoped counterparty/i), { target: { value: "cp-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^grant role$/i, hidden: false }));

    expect(assignExternalStakeholder).toHaveBeenCalledWith({ role: "provider_contact", stakeholderSubject: "kc_pending-subject", counterpartyId: "cp-1" });
  });

  it("onboards a brand-new operator: creates the account, KYC customer, and grants the role in one step", () => {
    render(<OperatorOnboardingControls role="admin" />);

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: "New Operator" } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: "new.operator@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^onboard operator$/i }));

    expect(onboardOperator).toHaveBeenCalledWith({ name: "New Operator", email: "new.operator@example.com", role: "compliance_officer", counterpartyId: undefined, dossierId: undefined });
  });
});
