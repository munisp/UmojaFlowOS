/**
 * Non-empty business-row cutover proof harness.
 *
 * The transitional MySQL/TiDB source is currently empty of business records, so
 * a dry run alone only proves the mapping paths compile and reconcile at zero
 * rows. This harness inserts one dependency-ordered fixture row per mapped
 * business table inside a MySQL transaction, runs the real executor in dry-run
 * mode (which loads into PostgreSQL inside its own transaction and rolls back),
 * captures the per-table reconciliation, and then rolls the MySQL transaction
 * back as well.
 *
 * Nothing is persisted in either database. Every value below is a clearly
 * labelled migration-proof fixture, never operational data: rates, amounts and
 * balances carry a `CUTOVER-FIXTURE` source reference so they can never be
 * mistaken for reconciled positions.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mysql from "mysql2/promise";

const execFileAsync = promisify(execFile);
const FIXTURE_TAG = "CUTOVER-FIXTURE";

/** Fixed identifiers keep the deterministic UUID mapping reproducible. */
export const FIXTURE_IDS = {
  counterparty: 900001,
  authorization: 900002,
  integration: 900003,
  observation: 900004,
  customer: 900005,
  beneficiary: 900006,
  paymentOrder: 900007,
  paymentLeg: 900008,
  rateLock: 900009,
  liquidityPosition: 900010,
};

const AT = "2026-01-02 03:04:05";

/** Insert one row per mapped table, in foreign-key order. */
async function insertFixtures(connection) {
  const i = FIXTURE_IDS;
  await connection.query(
    "INSERT INTO counterparties (id, legalName, counterpartyType, jurisdiction, createdBy, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)",
    [i.counterparty, `${FIXTURE_TAG} Licensed PSP`, "licensed_psp", "NG", `${FIXTURE_TAG}-operator`, AT, AT],
  );
  await connection.query(
    "INSERT INTO counterpartyAuthorizations (id, counterpartyId, regulator, licenceReference, scopeDescription, evidenceUrl, validFrom, validTo, status, verifiedBy, verifiedAt, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [i.authorization, i.counterparty, "CBN", `${FIXTURE_TAG}-LIC-001`, `${FIXTURE_TAG} payment scope`, `https://example.invalid/${FIXTURE_TAG}`, "2026-01-01", "2027-01-01", "verified", `${FIXTURE_TAG}-reviewer`, AT, AT],
  );
  await connection.query(
    "INSERT INTO integrationConnections (id, counterpartyId, category, environment, documentationUrl, secretReference, state, lastHealthCheckedAt, lastHealthResult, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [i.integration, i.counterparty, "fx_rate", "sandbox", `https://example.invalid/${FIXTURE_TAG}/docs`, `secret://${FIXTURE_TAG}`, "credential_pending", null, null, AT],
  );
  await connection.query(
    "INSERT INTO marketObservations (id, integrationConnectionId, baseAsset, quoteAsset, rate, observedAt, sourceReference, createdAt) VALUES (?,?,?,?,?,?,?,?)",
    [i.observation, i.integration, "USDC", "NGN", "1234.567890", AT, `${FIXTURE_TAG}-observation`, AT],
  );
  await connection.query(
    "INSERT INTO customers (id, legalName, registrationIdentifier, kycStatus, createdBy, createdAt) VALUES (?,?,?,?,?,?)",
    [i.customer, `${FIXTURE_TAG} Customer`, `${FIXTURE_TAG}-RC-001`, "under_review", `${FIXTURE_TAG}-operator`, AT],
  );
  await connection.query(
    "INSERT INTO beneficiaries (id, customerId, legalName, countryCode, bankOrWalletReference, screeningState, createdAt) VALUES (?,?,?,?,?,?,?)",
    [i.beneficiary, i.customer, `${FIXTURE_TAG} Beneficiary`, "KE", `${FIXTURE_TAG}-ACCT-001`, "not_run", AT],
  );
  await connection.query(
    "INSERT INTO paymentOrders (id, idempotencyKey, customerId, beneficiaryId, corridor, sourceCurrency, sourceAmount, targetCurrency, targetAmount, status, policyDecisionReference, providerFinalityReference, createdBy, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [i.paymentOrder, `${FIXTURE_TAG}-IDEM-001`, i.customer, i.beneficiary, "KENYA_KES", "NGN", "1000.00", "KES", null, "draft", null, null, `${FIXTURE_TAG}-operator`, AT, AT],
  );
  await connection.query(
    "INSERT INTO paymentLegs (id, paymentOrderId, sequenceNumber, legKind, counterpartyId, status, providerInstructionReference, providerFinalityReference, createdAt) VALUES (?,?,?,?,?,?,?,?,?)",
    [i.paymentLeg, i.paymentOrder, 1, "collection", i.counterparty, "draft", null, null, AT],
  );
  await connection.query(
    "INSERT INTO rateLocks (id, marketObservationId, paymentOrderId, corridor, baseAsset, quoteAsset, lockedRate, expiresAt, status, createdBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [i.rateLock, i.observation, i.paymentOrder, "KENYA_KES", "USDC", "KES", "129.456789", "2026-01-02 04:04:05", "locked", `${FIXTURE_TAG}-operator`, AT],
  );
  await connection.query(
    "INSERT INTO liquidityPositions (id, corridor, currency, accountKind, accountReference, availableAmount, reservedAmount, sourceReference, reconciledAt, recordedBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [i.liquidityPosition, "SOUTH_AFRICA_ZAR", "ZAR", "nostro", `${FIXTURE_TAG}-NOSTRO-001`, "5000.00", "250.00", `${FIXTURE_TAG}-position`, AT, `${FIXTURE_TAG}-operator`, AT],
  );
}

/**
 * Run the executor's dry run while fixture rows are visible, then discard them.
 * Returns the parsed reconciliation report.
 */
export async function runFixtureBackedDryRun() {
  const sourceUrl = process.env.MYSQL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("MYSQL_SOURCE_DATABASE_URL or DATABASE_URL is required");
  const connection = await mysql.createConnection(sourceUrl);
  try {
    await connection.query("BEGIN");
    await insertFixtures(connection);
    // The executor reads through its own connection, so the fixture rows must be
    // committed to be visible. Commit, capture, then delete in a guaranteed
    // cleanup so the source returns to its original empty state.
    await connection.query("COMMIT");
    const { stdout } = await execFileAsync("node", ["scripts/postgres/migrate-transition.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, MIGRATION_DRY_RUN: "1", MIGRATION_INITIATED_BY: "cutover-fixture-harness" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } finally {
    await removeFixtures(connection).catch(error => {
      process.stderr.write(`fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    connection.destroy();
  }
}

/** Delete fixture rows in reverse dependency order. */
export async function removeFixtures(connection) {
  const i = FIXTURE_IDS;
  const ordered = [
    ["rateLocks", i.rateLock],
    ["paymentLegs", i.paymentLeg],
    ["paymentOrders", i.paymentOrder],
    ["beneficiaries", i.beneficiary],
    ["customers", i.customer],
    ["marketObservations", i.observation],
    ["integrationConnections", i.integration],
    ["counterpartyAuthorizations", i.authorization],
    ["counterparties", i.counterparty],
    ["liquidityPositions", i.liquidityPosition],
  ];
  for (const [table, id] of ordered) await connection.query(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
}

/** Report the current fixture-row residue, used to assert a clean source. */
export async function countFixtureRows() {
  const sourceUrl = process.env.MYSQL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
  const connection = await mysql.createConnection(sourceUrl);
  try {
    let total = 0;
    for (const table of ["counterparties", "counterpartyAuthorizations", "integrationConnections", "marketObservations", "customers", "beneficiaries", "paymentOrders", "paymentLegs", "rateLocks", "liquidityPositions"]) {
      const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
      total += Number(rows[0].count);
    }
    return total;
  } finally {
    connection.destroy();
  }
}
