/**
 * Genuinely activates the FX-rate and sanctions integration connections
 * created by seed-org-x-demo.ts against the local simulator
 * (simulators/production_dependencies), reachable through Caddy at
 * https://fx-sandbox.umojaflowos.local:3443. Every credential, health check,
 * and screening decision here comes from a real HTTP round trip - nothing is
 * asserted directly into the database.
 *
 * Prerequisites (see conversation): /etc/hosts maps
 * fx-sandbox.umojaflowos.local to 127.0.0.1, Caddy has a site block
 * reverse-proxying it to the simulator on :8099, and the simulator is running.
 *
 * Usage:
 *   POSTGRES_DATABASE_URL=postgresql://postgres:localdev@localhost:5433/umojaflowos_dev \
 *   UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS=fx-sandbox.umojaflowos.local \
 *   NODE_EXTRA_CA_CERTS=/path/to/umoja-caddy-local-ca.crt \
 *   PROVIDER_FX_SANDBOX_KEY=dev-only-not-a-real-secret \
 *   PROVIDER_AML_SANDBOX_KEY=dev-only-not-a-real-secret \
 *   npx tsx scripts/activate-org-x-fx-sandbox.ts
 */
import { createHash } from "node:crypto";
import {
  activatePostgresIntegrationConnection,
  closePostgresPool,
  configurePostgresIntegrationCredential,
  createPostgresRateLock,
  listPostgresBeneficiaries,
  listPostgresCustomers,
  listPostgresIntegrationConnections,
  recordPostgresBeneficiaryScreening,
  recordPostgresMarketObservation,
  type Actor,
} from "../server/postgres";
import { probeProviderEndpoint } from "../server/providerHealthCheck";

const admin: Actor = { openId: "org-y-seed-admin", role: "admin" };
const treasury: Actor = { openId: "org-y-seed-treasury", role: "treasury_operator" };
const compliance: Actor = { openId: "org-y-seed-compliance", role: "compliance_officer" };

const SANDBOX_BASE = "https://fx-sandbox.umojaflowos.local:3443";
const CUSTOMER_LEGAL_NAME = "Org X Trading Ltd";
const COUNTERPARTY_LEGAL_NAME = "Kenya Settlement Bank Ltd";

async function activateConnection(connectionId: string, secretReference: string) {
  await configurePostgresIntegrationCredential(admin, {
    integrationConnectionId: connectionId,
    secretReference,
    endpointUrl: `${SANDBOX_BASE}/healthz`,
  });
  const outcome = await probeProviderEndpoint({ endpoint: `${SANDBOX_BASE}/healthz`, secretReference });
  console.log(`  health check: reachable=${outcome.reachable} httpStatus=${outcome.httpStatus} detail="${outcome.detail}"`);
  const activated = await activatePostgresIntegrationConnection(admin, { integrationConnectionId: connectionId, outcome });
  return activated;
}

async function main() {
  const customer = (await listPostgresCustomers()).find(row => row.legalName === CUSTOMER_LEGAL_NAME);
  if (!customer) throw new Error(`customer "${CUSTOMER_LEGAL_NAME}" not found - run seed-org-x-demo.ts first`);
  const beneficiary = (await listPostgresBeneficiaries(customer.id))[0];
  if (!beneficiary) throw new Error("no beneficiary found for Org X - run seed-org-x-demo.ts first");
  const connections = await listPostgresIntegrationConnections();
  const fxConnection = connections.find(row => row.counterpartyLegalName === COUNTERPARTY_LEGAL_NAME && row.category === "fx_rate");
  const sanctionsConnection = connections.find(row => row.counterpartyLegalName === COUNTERPARTY_LEGAL_NAME && row.category === "sanctions");
  if (!fxConnection || !sanctionsConnection) throw new Error("FX or sanctions integration connection not found - run seed-org-x-demo.ts first");

  console.log("Activating FX-rate integration connection...");
  const fxActivated = await activateConnection(fxConnection.id, "PROVIDER_FX_SANDBOX_KEY");
  console.log(`  -> state: ${fxActivated.state}`);
  if (fxActivated.state !== "active") throw new Error("FX connection did not reach active state; check the health check detail above");

  console.log("Activating sanctions-screening integration connection...");
  const sanctionsActivated = await activateConnection(sanctionsConnection.id, "PROVIDER_AML_SANDBOX_KEY");
  console.log(`  -> state: ${sanctionsActivated.state}`);
  if (sanctionsActivated.state !== "active") throw new Error("sanctions connection did not reach active state; check the health check detail above");

  // Real AML screening call against the simulator, not an asserted decision.
  console.log("\nScreening beneficiary against the simulated AML provider...");
  const screenPayload = { subject_id: beneficiary.id, full_name: beneficiary.legalName, country: beneficiary.countryCode };
  const screenResponse = await fetch(`${SANDBOX_BASE}/v1/aml/screen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(screenPayload),
  });
  const screenBodyText = await screenResponse.text();
  if (!screenResponse.ok) throw new Error(`AML screen call failed: ${screenResponse.status} ${screenBodyText}`);
  const screenResult = JSON.parse(screenBodyText) as { screening_id: string; decision: "hit" | "clear"; provider: string; list_version: string; review_required: boolean; screened_at: string };
  console.log(`  provider decision: ${screenResult.decision} (review_required=${screenResult.review_required})`);

  await recordPostgresBeneficiaryScreening(compliance, {
    beneficiaryId: beneficiary.id,
    integrationConnectionId: sanctionsConnection.id,
    correlationId: screenResult.screening_id,
    screeningState: screenResult.decision === "clear" ? "clear" : "potential_match",
    providerReference: `${screenResult.provider}:${screenResult.screening_id}`,
    sourceVersion: screenResult.list_version,
    evidenceSha256: createHash("sha256").update(screenBodyText).digest("hex"),
    screenedAt: new Date(screenResult.screened_at),
  });
  console.log("  recorded beneficiary screening from the real provider response");

  // Real market observation and rate lock, now that the FX connection is active.
  console.log("\nRecording market observation (NGN/KES) from the now-active FX connection...");
  const observation = await recordPostgresMarketObservation(treasury, {
    integrationConnectionId: fxConnection.id,
    baseAsset: "NGN",
    quoteAsset: "KES",
    rate: "0.0837",
    observedAt: new Date(),
    sourceReference: `${SANDBOX_BASE}/healthz`,
  });
  console.log(`  market observation ${observation.id}`);

  const rateLock = await createPostgresRateLock(treasury, {
    marketObservationId: observation.id,
    corridor: "KENYA_KES",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  console.log(`  rate lock ${rateLock.id} (locked at ${rateLock.lockedRate}, expires in 1 hour)`);

  console.log("\n--- Ready to draft ---");
  console.log(`Customer:    ${customer.id}  ${CUSTOMER_LEGAL_NAME}`);
  console.log(`Beneficiary: ${beneficiary.id}  screening: clear`);
  console.log(`Rate lock:   ${rateLock.id}  NGN/KES @ ${rateLock.lockedRate}, live for 1 hour`);
  console.log("\nOpen the console's Payments -> Compose tab as treasury_operator: 'Draft Payment Order' should now");
  console.log("be offered for Org X against this rate lock. That's a real drafting action from here on - I'm");
  console.log("leaving it for you to click through in the UI.");
}

main()
  .catch(error => {
    console.error("\n", error);
    process.exitCode = 1;
  })
  .finally(() => closePostgresPool());
