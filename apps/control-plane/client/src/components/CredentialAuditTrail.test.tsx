import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialAuditTrail, type CredentialAuditRow } from "./IntegrationCredentialControls";

afterEach(cleanup);

const base: CredentialAuditRow = {
  id: "1",
  action: "integration_connection.created",
  actorSubject: "admin-1",
  actorRole: "admin",
  occurredAt: new Date("2026-08-18T10:00:00Z"),
  secretReference: null,
  previousSecretReference: null,
  endpoint: null,
  state: null,
  healthCheckPassed: null,
  httpStatus: null,
  detail: null,
  reason: null,
};

describe("credential audit trail", () => {
  it("distinguishes an unselected connection from a loading one and from an empty history", () => {
    render(<CredentialAuditTrail entries={[]} loading={false} connectionSelected={false} />);
    expect(screen.getByTestId("audit-trail-unselected")).toBeTruthy();
    cleanup();

    render(<CredentialAuditTrail entries={[]} loading connectionSelected />);
    expect(screen.getByTestId("audit-trail-loading")).toBeTruthy();
    cleanup();

    render(<CredentialAuditTrail entries={[]} loading={false} connectionSelected />);
    const empty = screen.getByTestId("audit-trail-empty");
    expect(empty.textContent).toContain("No credential activity");
  });

  it("states what a credential reference was changed from, not only what it became", () => {
    render(
      <CredentialAuditTrail
        connectionSelected
        loading={false}
        entries={[{
          ...base,
          id: "2",
          action: "integration_connection.credential_configured",
          secretReference: "FX_ROTATED",
          previousSecretReference: "FX_PRIMARY",
        }]}
      />,
    );
    const text = screen.getByTestId("audit-trail-list").textContent ?? "";
    expect(text).toContain("FX_PRIMARY");
    expect(text).toContain("FX_ROTATED");
    expect(text).toContain("changed from");
  });

  it("describes a first-time configuration without inventing a predecessor", () => {
    render(
      <CredentialAuditTrail
        connectionSelected
        loading={false}
        entries={[{ ...base, id: "3", action: "integration_connection.credential_configured", secretReference: "FX_PRIMARY" }]}
      />,
    );
    const text = screen.getByTestId("audit-trail-list").textContent ?? "";
    expect(text).toContain("set to FX_PRIMARY");
    expect(text).not.toContain("changed from");
  });

  it("shows a refused activation with the provider's stated reason", () => {
    render(
      <CredentialAuditTrail
        connectionSelected
        loading={false}
        entries={[{
          ...base,
          id: "4",
          action: "integration_connection.activation_refused",
          detail: "provider rejected the supplied credential",
          httpStatus: 401,
        }]}
      />,
    );
    const text = screen.getByTestId("audit-trail-list").textContent ?? "";
    expect(text).toContain("Activation refused");
    expect(text).toContain("rejected the supplied credential");
    expect(text).toContain("401");
  });

  it("attributes every entry to an actor and a time", () => {
    render(
      <CredentialAuditTrail
        connectionSelected
        loading={false}
        entries={[
          { ...base, id: "5", action: "integration_connection.suspended", reason: "contract under review", actorSubject: "admin-42" },
        ]}
      />,
    );
    const entry = screen.getByTestId("audit-trail-entry").textContent ?? "";
    expect(entry).toContain("admin-42");
    expect(entry).toContain("contract under review");
    // A rendered date, whatever the runner's locale.
    expect(entry).toMatch(/20\d\d/);
  });

  it("renders no credential value even if one were somehow present in a record", () => {
    render(
      <CredentialAuditTrail
        connectionSelected
        loading={false}
        entries={[{ ...base, id: "6", action: "integration_connection.credential_configured", secretReference: "FX_PRIMARY" }]}
      />,
    );
    const text = screen.getByTestId("audit-trail-list").textContent ?? "";
    for (const shape of ["sk_live", "Bearer ", "eyJ"]) {
      expect(text).not.toContain(shape);
    }
  });
});
