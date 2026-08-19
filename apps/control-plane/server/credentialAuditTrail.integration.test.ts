import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  activatePostgresIntegrationConnection,
  closePostgresPool,
  configurePostgresIntegrationCredential,
  createPostgresCounterparty,
  createPostgresIntegrationConnection,
  listPostgresCredentialAuditTrail,
  suspendPostgresIntegrationConnection,
} from "./postgres";

/**
 * The audit trail exists to answer questions after the fact, so these
 * regressions ask exactly those questions: who changed the credential, what was
 * it changed from, did activation pass, and why not.
 */
const run = process.env.POSTGRES_INTEGRATION_TEST === "1" ? describe : describe.skip;

const admin = () => ({ openId: `admin-${randomUUID()}`, role: "admin" as const });

async function integrationFixture() {
  const actor = admin();
  const counterparty = await createPostgresCounterparty(actor, {
    legalName: `Regression ${randomUUID().slice(0, 8)} Provider`,
    counterpartyType: "fx_liquidity_provider",
    jurisdiction: "NG",
  });
  const connection = await createPostgresIntegrationConnection(actor, {
    counterpartyId: counterparty.id,
    category: "fx_rate",
    environment: "sandbox",
    documentationUrl: "https://provider.example.com/docs",
  });
  return { actor, connection };
}

run("credential audit trail", () => {
  afterAll(async () => { await closePostgresPool(); });

  it("records the previous and new secret reference for every credential change", async () => {
    const { actor, connection } = await integrationFixture();

    await configurePostgresIntegrationCredential(actor, {
      integrationConnectionId: connection.id,
      secretReference: "FX_PROVIDER_PRIMARY",
      endpointUrl: "https://provider.example.com/v1/health",
    });
    await configurePostgresIntegrationCredential(actor, {
      integrationConnectionId: connection.id,
      secretReference: "FX_PROVIDER_ROTATED",
      endpointUrl: "https://provider.example.com/v1/health",
    });

    const trail = await listPostgresCredentialAuditTrail({ integrationConnectionId: connection.id });
    const changes = trail.filter(entry => entry.action === "integration_connection.credential_configured");
    expect(changes).toHaveLength(2);

    // Newest first: the rotation, which must name what it replaced.
    expect(changes[0].secretReference).toBe("FX_PROVIDER_ROTATED");
    expect(changes[0].previousSecretReference).toBe("FX_PROVIDER_PRIMARY");
    // The first configuration replaced nothing, and says so rather than
    // inventing a predecessor.
    expect(changes[1].secretReference).toBe("FX_PROVIDER_PRIMARY");
    expect(changes[1].previousSecretReference).toBeNull();

    for (const entry of changes) {
      expect(entry.actorSubject).toBe(actor.openId);
      expect(entry.actorRole).toBe("admin");
      expect(entry.occurredAt).toBeInstanceOf(Date);
    }
  });

  it("records a refused activation with the observed reason, not merely a failure", async () => {
    const { actor, connection } = await integrationFixture();
    await configurePostgresIntegrationCredential(actor, {
      integrationConnectionId: connection.id,
      secretReference: "FX_PROVIDER_PRIMARY",
      endpointUrl: "https://provider.example.com/v1/health",
    });

    await activatePostgresIntegrationConnection(actor, {
      integrationConnectionId: connection.id,
      outcome: {
        reachable: true,
        httpStatus: 401,
        observedAt: new Date(),
        detail: "provider rejected the supplied credential",
        endpoint: "https://provider.example.com/v1/health",
      },
    });

    const trail = await listPostgresCredentialAuditTrail({ integrationConnectionId: connection.id });
    const refusal = trail.find(entry => entry.action === "integration_connection.activation_refused");
    expect(refusal).toBeDefined();
    expect(refusal?.healthCheckPassed).toBe(false);
    expect(refusal?.httpStatus).toBe(401);
    expect(refusal?.detail).toContain("rejected");
    expect(refusal?.state).toBe("failed");

    // No entry claims activation succeeded.
    expect(trail.some(entry => entry.action === "integration_connection.activated")).toBe(false);
  });

  it("records suspension with its stated reason and keeps the whole history ordered", async () => {
    const { actor, connection } = await integrationFixture();
    await configurePostgresIntegrationCredential(actor, {
      integrationConnectionId: connection.id,
      secretReference: "FX_PROVIDER_PRIMARY",
      endpointUrl: "https://provider.example.com/v1/health",
    });
    await activatePostgresIntegrationConnection(actor, {
      integrationConnectionId: connection.id,
      outcome: { reachable: false, httpStatus: null, observedAt: new Date(), detail: "endpoint unreachable", endpoint: "https://provider.example.com/v1/health" },
    });
    await suspendPostgresIntegrationConnection(actor, {
      integrationConnectionId: connection.id,
      reason: "provider contract under review by compliance",
    });

    const trail = await listPostgresCredentialAuditTrail({ integrationConnectionId: connection.id });
    expect(trail[0].action).toBe("integration_connection.suspended");
    expect(trail[0].reason).toContain("under review");

    const actions = trail.map(entry => entry.action);
    expect(actions).toEqual([
      "integration_connection.suspended",
      "integration_connection.activation_refused",
      "integration_connection.credential_configured",
      "integration_connection.created",
    ]);

    // Ordering is genuinely descending by time, not merely by insertion luck.
    const times = trail.map(entry => entry.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("carries no credential value anywhere in the recorded history", async () => {
    const { actor, connection } = await integrationFixture();
    await configurePostgresIntegrationCredential(actor, {
      integrationConnectionId: connection.id,
      secretReference: "FX_PROVIDER_PRIMARY",
      endpointUrl: "https://provider.example.com/v1/health",
    });

    const trail = await listPostgresCredentialAuditTrail({ integrationConnectionId: connection.id });
    const serialised = JSON.stringify(trail);
    // Credential shapes that must never appear in an audit record.
    for (const shape of ["sk_live", "Bearer ", "eyJ", "-----BEGIN"]) {
      expect(serialised).not.toContain(shape);
    }
    // What it does contain is the reference name, which is not a secret.
    expect(serialised).toContain("FX_PROVIDER_PRIMARY");
  });
});
