/**
 * Seeds a demo customer ("Org X") and a settlement counterparty through the
 * real onboarding/compliance code paths (createPostgresCustomer,
 * decideCustomerUseCaseGate, transitionPostgresCounterpartyAuthorization,
 * etc.) so the control-plane console has something real to click through.
 *
 * Deliberately does NOT attempt to activate an integration connection, record
 * a market observation, or clear beneficiary screening: those require a
 * genuinely reachable, allow-listed HTTPS provider endpoint per
 * normaliseProviderEndpoint/activatePostgresIntegrationConnection in
 * server/postgres.ts, which does not exist in this local environment. Faking
 * that state with a raw UPDATE would misrepresent it as verified when it
 * never was.
 *
 * Idempotent: safe to re-run, reuses existing rows by name instead of
 * duplicating them.
 *
 * Usage: POSTGRES_DATABASE_URL=postgresql://postgres:localdev@localhost:5433/umojaflowos_dev npx tsx scripts/seed-org-x-demo.ts
 */
import {
  closePostgresPool,
  createPostgresBeneficiary,
  createPostgresCounterparty,
  createPostgresCounterpartyAuthorization,
  createPostgresCustomer,
  createPostgresIntegrationConnection,
  listPostgresBeneficiaries,
  listPostgresCounterpartyAuthorizations,
  listPostgresCounterparties,
  listPostgresCustomers,
  listPostgresIntegrationConnections,
  transitionPostgresCounterpartyAuthorization,
  type Actor,
} from "../server/postgres";
import { decideCustomerUseCaseGate, getCustomerWorkspace, recordCustomerDestinationCounterparty, updatePostgresCustomerProfile } from "../server/customerUseCase";

const compliance: Actor = { openId: "org-y-seed-compliance", role: "compliance_officer" };
const admin: Actor = { openId: "org-y-seed-admin", role: "admin" };

const CUSTOMER_LEGAL_NAME = "Org X Trading Ltd";
const CUSTOMER_REGISTRATION_ID = "RC-ORGX-0001";
const COUNTERPARTY_LEGAL_NAME = "Kenya Settlement Bank Ltd";
const BENEFICIARY_LEGAL_NAME = "Nairobi Fresh Produce Exports Ltd";

async function main() {
  console.log(`Seeding against ${process.env.POSTGRES_DATABASE_URL ?? "(default local socket - umojaflowos_dev)"}\n`);

  // --- Customer: Org X, through Gate G1 approval ---
  let customer = (await listPostgresCustomers()).find(row => row.legalName === CUSTOMER_LEGAL_NAME);
  if (!customer) {
    customer = await createPostgresCustomer(compliance, { legalName: CUSTOMER_LEGAL_NAME, registrationIdentifier: CUSTOMER_REGISTRATION_ID });
    console.log(`Created customer ${customer.id} (${CUSTOMER_LEGAL_NAME})`);
  } else {
    console.log(`Reusing customer ${customer.id} (${CUSTOMER_LEGAL_NAME})`);
  }

  await updatePostgresCustomerProfile(compliance, {
    customerId: customer.id,
    archetype: "importer",
    tier: "mid",
    country: "NIGERIA_NGN",
    useCaseNarrative:
      "Org X imports finished goods from Kenyan suppliers and settles invoices monthly, converting NGN receipts to KES. Expected volume: 10-15 payments per month, USD 20k-80k equivalent each.",
  });
  console.log("Set customer profile: importer / mid-tier / Nigeria, use-case narrative recorded");

  let workspace = await getCustomerWorkspace(customer.id);
  if (!workspace) throw new Error("customer workspace was not found immediately after profile update");

  if (workspace.destinationCounterparties.length === 0) {
    await recordCustomerDestinationCounterparty(compliance, {
      customerId: customer.id,
      counterpartyName: BENEFICIARY_LEGAL_NAME,
      destinationJurisdiction: "Kenya",
      invoiceReference: "INV-2026-0417",
    });
    console.log(`Recorded destination counterparty (${BENEFICIARY_LEGAL_NAME})`);
    workspace = await getCustomerWorkspace(customer.id);
  } else {
    console.log("Destination counterparty already on file");
  }

  const latestGate = workspace?.useCaseGateDecisions[0];
  if (!latestGate || latestGate.decision !== "approved") {
    await decideCustomerUseCaseGate(compliance, {
      customerId: customer.id,
      decision: "approved",
      rationale: "Narrative and destination counterparty are on file for a routine cross-border trade payment; no adverse findings in this seed scenario.",
    });
    console.log("Gate G1 (use-case admissibility) approved for Org X");
  } else {
    console.log("Gate G1 already approved");
  }

  // --- Beneficiary: where Org X's payment actually lands ---
  let beneficiary = (await listPostgresBeneficiaries(customer.id))[0];
  if (!beneficiary) {
    beneficiary = await createPostgresBeneficiary(compliance, {
      customerId: customer.id,
      legalName: BENEFICIARY_LEGAL_NAME,
      countryCode: "KE",
      bankOrWalletReference: "KE-EQTL-0011-2200981234",
    });
    console.log(`Created beneficiary ${beneficiary.id} (${BENEFICIARY_LEGAL_NAME})`);
  } else {
    console.log(`Reusing beneficiary ${beneficiary.id} - screening state: ${beneficiary.screeningState}`);
  }

  // --- Counterparty: the regulated correspondent bank that would carry a payment leg ---
  let counterparty = (await listPostgresCounterparties()).find(row => row.legalName === COUNTERPARTY_LEGAL_NAME);
  if (!counterparty) {
    counterparty = await createPostgresCounterparty(admin, { legalName: COUNTERPARTY_LEGAL_NAME, counterpartyType: "correspondent_bank", jurisdiction: "KE" });
    console.log(`Created counterparty ${counterparty.id} (${COUNTERPARTY_LEGAL_NAME})`);
  } else {
    console.log(`Reusing counterparty ${counterparty.id} (${COUNTERPARTY_LEGAL_NAME})`);
  }

  let authorization = (await listPostgresCounterpartyAuthorizations()).find(row => row.counterpartyId === counterparty!.id);
  if (!authorization) {
    authorization = await createPostgresCounterpartyAuthorization(compliance, {
      counterpartyId: counterparty.id,
      regulator: "CBK",
      licenceReference: "CBK-PSP-2026-0042",
      scopeDescription: "Correspondent banking and payout services for KES-denominated inbound trade settlements.",
      evidenceUri: "https://org-y-internal.example/evidence/cbk-psp-2026-0042.pdf",
      validFrom: new Date(Date.now() - 30 * 86_400_000),
      status: "pending_review",
    });
    console.log(`Created counterparty authorization ${authorization.id} (pending_review)`);
  }
  if (authorization.status !== "verified") {
    authorization = await transitionPostgresCounterpartyAuthorization(admin, { authorizationId: authorization.id, status: "verified" });
    console.log("Verified counterparty authorization - this counterparty can now be used on a payment leg");
  } else {
    console.log("Counterparty authorization already verified");
  }

  // --- Integration connections: created, but deliberately left unconfigured (see header) ---
  const connections = await listPostgresIntegrationConnections();
  let fxConnection = connections.find(row => row.counterpartyId === counterparty!.id && row.category === "fx_rate");
  if (!fxConnection) {
    fxConnection = await createPostgresIntegrationConnection(admin, {
      counterpartyId: counterparty.id,
      category: "fx_rate",
      environment: "sandbox",
      documentationUrl: "https://org-y-internal.example/docs/kes-fx-feed",
    });
    console.log(`Created FX-rate integration connection ${fxConnection.id} (state: ${fxConnection.state})`);
  } else {
    console.log(`FX-rate integration connection already exists (state: ${fxConnection.state})`);
  }
  let sanctionsConnection = connections.find(row => row.counterpartyId === counterparty!.id && row.category === "sanctions");
  if (!sanctionsConnection) {
    sanctionsConnection = await createPostgresIntegrationConnection(admin, {
      counterpartyId: counterparty.id,
      category: "sanctions",
      environment: "sandbox",
      documentationUrl: "https://org-y-internal.example/docs/sanctions-screening",
    });
    console.log(`Created sanctions-screening integration connection ${sanctionsConnection.id} (state: ${sanctionsConnection.state})`);
  } else {
    console.log(`Sanctions-screening integration connection already exists (state: ${sanctionsConnection.state})`);
  }

  console.log("\n--- Summary ---");
  console.log(`Customer:      ${customer.id}  ${CUSTOMER_LEGAL_NAME}  (Gate G1 approved)`);
  console.log(`Beneficiary:   ${beneficiary.id}  ${BENEFICIARY_LEGAL_NAME}  (screening: ${beneficiary.screeningState})`);
  console.log(`Counterparty:  ${counterparty.id}  ${COUNTERPARTY_LEGAL_NAME}  (authorisation: verified)`);
  console.log(`FX connection: ${fxConnection.id}  (state: ${fxConnection.state} - not activatable locally, see header)`);
  console.log(`AML connection: ${sanctionsConnection.id}  (state: ${sanctionsConnection.state} - not activatable locally, see header)`);
  console.log("\nWhat this unblocks in the console: Org X's customer workspace, its approved use case, its");
  console.log("beneficiary, and a verified counterparty available for a payment leg.");
  console.log("What it does NOT unblock: recording a market observation, locking a rate, or drafting a payment");
  console.log("order - all three require an integration connection in state 'active', which this codebase only");
  console.log("grants after a real HTTPS health check against a DNS host explicitly listed in");
  console.log("UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS succeeds. There is no local/sandbox bypass for that by design.");
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePostgresPool());
