import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  activatePostgresIntegrationConnection,
  assertIsSecretReferenceNotSecret,
  closePostgresPool,
  configurePostgresIntegrationCredential,
  createPostgresCounterparty,
  createPostgresIntegrationConnection,
  listPostgresIntegrationCredentialStatus,
  normaliseProviderEndpoint,
  suspendPostgresIntegrationConnection,
  type ProviderHealthCheckOutcome,
} from "./postgres";

/**
 * Provider credential configuration and verified activation.
 *
 * The property under test is narrow and important: an integration reaches
 * `active` if and only if a real health check passed. Everything else here
 * exists to show that the ways one might get around that are closed.
 */
const admin = { openId: `admin-${randomUUID()}`, role: "admin" as const };

async function connection() {
  const counterparty = await createPostgresCounterparty(admin, {
    // Named to match the fixture-purge pattern. A generic name such as
    // "Provider x" survives the purge, which is exactly how these rows ended up
    // rendering in the console as if they were real provider connections.
    legalName: `Boundary Regression Provider ${randomUUID().slice(0, 8)}`,
    counterpartyType: "fx_liquidity_provider",
    jurisdiction: "NG",
  });
  return createPostgresIntegrationConnection(admin, {
    counterpartyId: counterparty.id,
    category: "fx_rate",
    environment: "sandbox",
    documentationUrl: "https://provider.example.com/docs",
  });
}

function outcome(overrides: Partial<ProviderHealthCheckOutcome> = {}): ProviderHealthCheckOutcome {
  return {
    reachable: true,
    httpStatus: 200,
    observedAt: new Date(),
    detail: "provider responded 200",
    endpoint: "https://provider.example.com/health",
    ...overrides,
  };
}

describe("provider credential configuration", () => {
  it("refuses a value that looks like a credential rather than a reference", () => {
    // The realistic mistake is pasting the key itself into the reference field.
    for (const pasted of [
      "sk_live_51H8xQ2eZvKYlo2C",
      "Bearer abcdefghijklmnop",
      "ey" + "J".repeat(20) + ".payload",
      "a".repeat(64),
      "-----BEGIN " + "PRIVATE KEY-----",
    ]) {
      expect(() => assertIsSecretReferenceNotSecret(pasted)).toThrow(/looks like a credential|deployment secret name/);
    }
  });

  it("accepts a deployment secret name", () => {
    expect(() => assertIsSecretReferenceNotSecret("PROVIDER_FX_API_KEY")).not.toThrow();
  });

  it("refuses an endpoint that embeds credentials or is not https", () => {
    expect(() => normaliseProviderEndpoint("https://user:pass@provider.example.com")).toThrow(/must not embed credentials/);
    expect(() => normaliseProviderEndpoint("http://provider.example.com")).toThrow(/must use https/);
    expect(() => normaliseProviderEndpoint("not-a-url")).toThrow(/absolute URL/);
  });

  it("stores only the reference and moves the integration to credential_pending", async () => {
    const created = await connection();
    const configured = await configurePostgresIntegrationCredential(admin, {
      integrationConnectionId: created.id,
      secretReference: "PROVIDER_FX_API_KEY",
      endpointUrl: "https://provider.example.com/v1/health",
    });
    expect(configured.state).toBe("credential_pending");

    const rows = await listPostgresIntegrationCredentialStatus();
    const row = rows.find((entry: { id: string }) => entry.id === created.id);
    expect(row?.credentialConfigured).toBe(true);
    expect(row?.secretReference).toBe("PROVIDER_FX_API_KEY");
    // Configuring a credential must not activate anything.
    expect(row?.state).toBe("credential_pending");
    expect(row?.lastHealthCheckedAt).toBeNull();
  });
});

describe("verified activation", () => {
  it("refuses activation before a credential reference exists", async () => {
    const created = await connection();
    await expect(
      activatePostgresIntegrationConnection(admin, { integrationConnectionId: created.id, outcome: outcome() }),
    ).rejects.toThrow(/configure a credential reference/);
  });

  it("activates only when the health check actually passed", async () => {
    const created = await connection();
    await configurePostgresIntegrationCredential(admin, {
      integrationConnectionId: created.id,
      secretReference: "PROVIDER_FX_API_KEY",
      endpointUrl: "https://provider.example.com/v1/health",
    });
    const activated = await activatePostgresIntegrationConnection(admin, {
      integrationConnectionId: created.id,
      outcome: outcome(),
    });
    expect(activated.state).toBe("active");
    expect(activated.healthCheckPassed).toBe(true);
  });

  it.each([
    ["unreachable provider", outcome({ reachable: false, httpStatus: null, detail: "unreachable" })],
    ["rejected credential", outcome({ httpStatus: 401, detail: "credential rejected" })],
    ["provider error", outcome({ httpStatus: 500, detail: "provider returned 500" })],
    ["redirect", outcome({ httpStatus: 302, detail: "redirected" })],
    ["no status despite claiming reachable", outcome({ httpStatus: null, detail: "no status" })],
  ])("records a failed activation for %s rather than activating", async (_label, failing) => {
    const created = await connection();
    await configurePostgresIntegrationCredential(admin, {
      integrationConnectionId: created.id,
      secretReference: "PROVIDER_FX_API_KEY",
      endpointUrl: "https://provider.example.com/v1/health",
    });
    const result = await activatePostgresIntegrationConnection(admin, {
      integrationConnectionId: created.id,
      outcome: failing,
    });
    // Explicitly failed, not left looking untried.
    expect(result.state).toBe("failed");
    expect(result.healthCheckPassed).toBe(false);

    const rows = await listPostgresIntegrationCredentialStatus();
    const row = rows.find((entry: { id: string }) => entry.id === created.id);
    expect(row?.state).toBe("failed");
    expect(row?.lastHealthResult).toMatchObject({ reachable: failing.reachable });
  });

  it("refuses to re-credential a live integration until it is suspended", async () => {
    const created = await connection();
    await configurePostgresIntegrationCredential(admin, {
      integrationConnectionId: created.id,
      secretReference: "PROVIDER_FX_API_KEY",
      endpointUrl: "https://provider.example.com/v1/health",
    });
    await activatePostgresIntegrationConnection(admin, { integrationConnectionId: created.id, outcome: outcome() });

    // Silently re-pointing a live integration would change which provider it
    // talks to without any visible state change.
    await expect(
      configurePostgresIntegrationCredential(admin, {
        integrationConnectionId: created.id,
        secretReference: "OTHER_PROVIDER_KEY",
        endpointUrl: "https://other.example.com/v1/health",
      }),
    ).rejects.toThrow(/suspend the integration/);

    await suspendPostgresIntegrationConnection(admin, { integrationConnectionId: created.id, reason: "rotating the provider credential" });
    const reconfigured = await configurePostgresIntegrationCredential(admin, {
      integrationConnectionId: created.id,
      secretReference: "OTHER_PROVIDER_KEY",
      endpointUrl: "https://other.example.com/v1/health",
    });
    // Re-credentialling drops it back to pending, so it must pass a fresh check.
    expect(reconfigured.state).toBe("credential_pending");
  });

  it("clears the previous health result when the credential changes", async () => {
    const created = await connection();
    await configurePostgresIntegrationCredential(admin, {
      integrationConnectionId: created.id,
      secretReference: "PROVIDER_FX_API_KEY",
      endpointUrl: "https://provider.example.com/v1/health",
    });
    await activatePostgresIntegrationConnection(admin, { integrationConnectionId: created.id, outcome: outcome() });
    await suspendPostgresIntegrationConnection(admin, { integrationConnectionId: created.id, reason: "rotating the provider credential" });
    await configurePostgresIntegrationCredential(admin, {
      integrationConnectionId: created.id,
      secretReference: "ROTATED_PROVIDER_KEY",
      endpointUrl: "https://provider.example.com/v1/health",
    });

    const rows = await listPostgresIntegrationCredentialStatus();
    const row = rows.find((entry: { id: string }) => entry.id === created.id);
    // A stale pass from the old credential must not vouch for the new one.
    expect(row?.lastHealthResult).toBeNull();
    expect(row?.lastHealthCheckedAt).toBeNull();
  });
});

afterAll(async () => {
  await closePostgresPool();
});
