import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canConfigureCredentials, IntegrationCredentialForm, IntegrationCredentialTable, type CredentialRow } from "./IntegrationCredentialControls";

/**
 * The credential interface is the one surface where a careless design decision
 * would put a live provider secret in a browser, a request body, and a log. The
 * tests therefore assert what the interface *refuses* to offer as much as what
 * it does.
 */
function row(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "conn-1",
    counterpartyLegalName: "Example FX Provider",
    category: "fx_rate",
    environment: "sandbox",
    endpoint: "https://provider.example.com/v1/health",
    state: "unconfigured",
    credentialConfigured: false,
    secretReference: null,
    lastHealthCheckedAt: null,
    lastHealthResult: null,
    ...overrides,
  };
}

describe("credential configuration access", () => {
  afterEach(cleanup);

  it("is restricted to administrators", () => {
    expect(canConfigureCredentials("admin")).toBe(true);
    for (const role of ["compliance_officer", "treasury_operator", "auditor", undefined]) {
      expect(canConfigureCredentials(role)).toBe(false);
    }
  });
});

describe("credential configuration form", () => {
  afterEach(cleanup);

  it("offers no field that accepts the credential itself", () => {
    render(<IntegrationCredentialForm connections={[row()]} pending={false} submit={vi.fn()} />);
    // The interface asks for the *name* of a deployment secret. A password or
    // token field here would be the vulnerability, so its absence is the test.
    expect(screen.queryByLabelText(/api key|secret value|token|password/i)).toBeNull();
    expect(screen.getByLabelText(/deployment secret name/i)).toBeTruthy();
  });

  it("explains that the credential is never stored or transmitted here", () => {
    render(<IntegrationCredentialForm connections={[row()]} pending={false} submit={vi.fn()} />);
    expect(screen.getByText(/never stored in the database, transmitted to this browser/i)).toBeTruthy();
  });

  it("submits the reference and endpoint the operator supplied", () => {
    const submit = vi.fn();
    render(<IntegrationCredentialForm connections={[row()]} pending={false} submit={submit} />);
    fireEvent.change(screen.getByLabelText(/deployment secret name/i), { target: { value: "PROVIDER_FX_API_KEY" } });
    fireEvent.change(screen.getByLabelText(/provider health endpoint/i), { target: { value: "https://provider.example.com/v1/health" } });
    // The select is a listbox; setting it through the DOM is not meaningful, so
    // the connection is chosen by rendering a single configurable connection.
    const form = screen.getByRole("form", { name: /configure provider credential/i });
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ secretReference: "PROVIDER_FX_API_KEY", endpointUrl: "https://provider.example.com/v1/health" }),
    );
  });

  it("withholds the form when every connection is already live", () => {
    // Re-crediting a live integration is refused by the server, so offering the
    // control would only produce a guaranteed rejection.
    render(<IntegrationCredentialForm connections={[row({ state: "active", credentialConfigured: true })]} pending={false} submit={vi.fn()} />);
    expect(screen.getByTestId("credential-form-empty")).toBeTruthy();
  });

  it("shows the server's own refusal text in place", () => {
    render(<IntegrationCredentialForm connections={[row()]} pending={false} submit={vi.fn()} error="secret reference looks like a credential" />);
    const alert = screen.getByTestId("submit-error");
    expect(alert.textContent).toContain("secret reference looks like a credential");
    expect(alert.textContent).toMatch(/Nothing was recorded/);
  });

  it("indicates an in-flight submission", () => {
    render(<IntegrationCredentialForm connections={[row()]} pending submit={vi.fn()} />);
    expect(screen.getByTestId("submit-pending")).toBeTruthy();
  });
});

describe("credential state and activation", () => {
  afterEach(cleanup);

  it("offers no activation until a credential reference exists", () => {
    render(
      <IntegrationCredentialTable rows={[row()]} loading={false} canManage activatePending={false} suspendPending={false} activate={vi.fn()} suspend={vi.fn()} />,
    );
    expect(screen.getByText(/configure a credential first/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run health check/i })).toBeNull();
  });

  it("runs the health check for a credentialled connection", () => {
    const activate = vi.fn();
    render(
      <IntegrationCredentialTable
        rows={[row({ state: "credential_pending", credentialConfigured: true, secretReference: "PROVIDER_FX_API_KEY" })]}
        loading={false}
        canManage
        activatePending={false}
        suspendPending={false}
        activate={activate}
        suspend={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /run health check/i }));
    expect(activate).toHaveBeenCalledWith({ integrationConnectionId: "conn-1" });
  });

  it("shows the recorded failure detail verbatim", () => {
    render(
      <IntegrationCredentialTable
        rows={[row({
          state: "failed",
          credentialConfigured: true,
          secretReference: "PROVIDER_FX_API_KEY",
          lastHealthCheckedAt: new Date("2026-08-19T02:00:00Z"),
          lastHealthResult: { reachable: true, httpStatus: 401, detail: "provider returned HTTP 401" },
        })]}
        loading={false}
        canManage
        activatePending={false}
        suspendPending={false}
        activate={vi.fn()}
        suspend={vi.fn()}
      />,
    );
    // A failed check must state what the provider actually said, not a generic
    // "activation failed".
    expect(screen.getByText("provider returned HTTP 401")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("offers suspension rather than activation for a live connection", () => {
    const suspend = vi.fn();
    render(
      <IntegrationCredentialTable
        rows={[row({ state: "active", credentialConfigured: true, secretReference: "PROVIDER_FX_API_KEY" })]}
        loading={false}
        canManage
        activatePending={false}
        suspendPending={false}
        activate={vi.fn()}
        suspend={suspend}
      />,
    );
    expect(screen.queryByRole("button", { name: /run health check/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /suspend/i }));
    expect(suspend).toHaveBeenCalledWith(expect.objectContaining({ integrationConnectionId: "conn-1" }));
  });

  it("offers no control at all to a non-administrator", () => {
    render(
      <IntegrationCredentialTable
        rows={[row({ state: "credential_pending", credentialConfigured: true })]}
        loading={false}
        canManage={false}
        activatePending={false}
        suspendPending={false}
        activate={vi.fn()}
        suspend={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/administrator only/i)).toBeTruthy();
  });

  it("distinguishes a loading table from an empty one", () => {
    const { rerender } = render(
      <IntegrationCredentialTable rows={[]} loading canManage activatePending={false} suspendPending={false} activate={vi.fn()} suspend={vi.fn()} />,
    );
    expect(screen.getByTestId("credential-table-loading")).toBeTruthy();
    rerender(
      <IntegrationCredentialTable rows={[]} loading={false} canManage activatePending={false} suspendPending={false} activate={vi.fn()} suspend={vi.fn()} />,
    );
    expect(screen.getByTestId("credential-table-empty")).toBeTruthy();
  });
});
