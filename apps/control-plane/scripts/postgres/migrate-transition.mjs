import mysql from "mysql2/promise";
import pg from "pg";
import { checksum, deterministicUuid, mapRoles } from "./cutover-lib.mjs";

const sourceUrl = process.env.MYSQL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("MYSQL_SOURCE_DATABASE_URL or DATABASE_URL is required");
const target = process.env.POSTGRES_DATABASE_URL ? new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL }) : new pg.Client({ host: "/var/run/postgresql", database: "umojaflowos_dev", user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu" });
const source = await mysql.createConnection(sourceUrl);
const dryRun = process.env.MIGRATION_DRY_RUN === "1";
const approved = process.env.MIGRATION_EXECUTION_APPROVED === "1";
const initiatedBy = process.env.MIGRATION_INITIATED_BY;
if (!dryRun && (!approved || !initiatedBy)) throw new Error("Apply is blocked: set MIGRATION_EXECUTION_APPROVED=1 and MIGRATION_INITIATED_BY to an accountable operator subject");

const businessTables = ["counterparties", "counterpartyAuthorizations", "customers", "beneficiaries", "paymentOrders", "paymentLegs", "liquidityPositions", "marketObservations", "complianceCases", "regulatoryReports", "regulatoryDeadlines", "alertPolicies", "activityEvents"];
const currentlyMappedBusinessTables = new Set(["counterparties", "counterpartyAuthorizations", "customers", "beneficiaries"]);
const supportedCounterpartyTypes = new Set(["licensed_psp", "correspondent_bank", "stablecoin_provider", "fx_liquidity_provider", "custody_provider", "kyc_provider", "sanctions_provider", "chain_analytics_provider", "notification_provider", "regulatory_submission_provider"]);
const asIso = value => new Date(value).toISOString();

function mapCounterparties(rows) {
  return rows.map(row => {
    if (!supportedCounterpartyTypes.has(row.counterpartyType)) throw new Error(`Cutover blocked: counterparty ${row.id} has unsupported type '${row.counterpartyType}'`);
    return { id: deterministicUuid("counterparties", row.id), legalName: row.legalName, counterpartyType: row.counterpartyType, jurisdiction: row.jurisdiction, createdAt: asIso(row.createdAt) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function mapCustomers(rows) {
  return rows.map(row => ({ id: deterministicUuid("customers", row.id), legalName: row.legalName, registrationIdentifier: row.registrationIdentifier, kycStatus: row.kycStatus, createdAt: asIso(row.createdAt) })).sort((a, b) => a.id.localeCompare(b.id));
}

function mapCounterpartyAuthorizations(rows) {
  const asDate = value => new Date(value).toISOString().slice(0, 10);
  return rows.map(row => ({ id: deterministicUuid("counterpartyAuthorizations", row.id), counterpartyId: deterministicUuid("counterparties", row.counterpartyId), regulator: row.regulator, licenceReference: row.licenceReference, scopeDescription: row.scopeDescription, evidenceUri: row.evidenceUrl, validFrom: asDate(row.validFrom), validTo: row.validTo ? asDate(row.validTo) : null, status: row.status, verifiedBy: row.verifiedBy ?? null, verifiedAt: row.verifiedAt ? asIso(row.verifiedAt) : null })).sort((a, b) => a.id.localeCompare(b.id));
}

function mapBeneficiaries(rows) {
  return rows.map(row => ({ id: deterministicUuid("beneficiaries", row.id), customerId: deterministicUuid("customers", row.customerId), legalName: row.legalName, countryCode: row.countryCode, bankOrWalletReference: row.bankOrWalletReference, screeningState: row.screeningState, createdAt: asIso(row.createdAt) })).sort((a, b) => a.id.localeCompare(b.id));
}

async function reconcileTable(targetClient, runId, sourceTable, destinationTable, sourceRecords, destinationRecords) {
  const sourceChecksum = checksum(sourceRecords), destinationChecksum = checksum(destinationRecords);
  if (sourceRecords.length !== destinationRecords.length || sourceChecksum !== destinationChecksum) throw new Error(`Cutover reconciliation failed for ${sourceTable}: source count/checksum does not match ${destinationTable}`);
  if (!dryRun) await targetClient.query("INSERT INTO postgres_cutover_table_reconciliations (cutover_run_id, source_table, destination_table, source_count, destination_count, source_checksum, destination_checksum, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'verified')", [runId, sourceTable, destinationTable, sourceRecords.length, destinationRecords.length, sourceChecksum, destinationChecksum]);
  return { sourceTable, destinationTable, sourceCount: sourceRecords.length, checksum: sourceChecksum };
}

async function migrateCounterparties(records, runId) {
  if (!dryRun) for (const record of records) await target.query("INSERT INTO counterparties (id, legal_name, counterparty_type, jurisdiction, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING", [record.id, record.legalName, record.counterpartyType, record.jurisdiction, record.createdAt]);
  const { rows } = await target.query("SELECT id, legal_name AS \"legalName\", counterparty_type AS \"counterpartyType\", jurisdiction, created_at AS \"createdAt\" FROM counterparties WHERE id = ANY($1::uuid[]) ORDER BY id", [records.map(record => record.id)]);
  return reconcileTable(target, runId, "counterparties", "counterparties", records, rows.map(row => ({ ...row, createdAt: asIso(row.createdAt) })));
}

async function migrateCustomers(records, runId) {
  if (!dryRun) for (const record of records) await target.query("INSERT INTO customers (id, legal_name, registration_identifier, kyc_status, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING", [record.id, record.legalName, record.registrationIdentifier, record.kycStatus, record.createdAt]);
  const { rows } = await target.query("SELECT id, legal_name AS \"legalName\", registration_identifier AS \"registrationIdentifier\", kyc_status AS \"kycStatus\", created_at AS \"createdAt\" FROM customers WHERE id = ANY($1::uuid[]) ORDER BY id", [records.map(record => record.id)]);
  return reconcileTable(target, runId, "customers", "customers", records, rows.map(row => ({ ...row, createdAt: asIso(row.createdAt) })));
}

async function migrateBeneficiaries(records, runId) {
  if (!dryRun) for (const record of records) await target.query("INSERT INTO beneficiaries (id, customer_id, legal_name, country_code, bank_or_wallet_reference, screening_state, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING", [record.id, record.customerId, record.legalName, record.countryCode, record.bankOrWalletReference, record.screeningState, record.createdAt]);
  const { rows } = await target.query("SELECT id, customer_id AS \"customerId\", legal_name AS \"legalName\", country_code AS \"countryCode\", bank_or_wallet_reference AS \"bankOrWalletReference\", screening_state AS \"screeningState\", created_at AS \"createdAt\" FROM beneficiaries WHERE id = ANY($1::uuid[]) ORDER BY id", [records.map(record => record.id)]);
  return reconcileTable(target, runId, "beneficiaries", "beneficiaries", records, rows.map(row => ({ ...row, createdAt: asIso(row.createdAt) })));
}

async function migrateCounterpartyAuthorizations(records, runId) {
  if (!dryRun) for (const record of records) await target.query("INSERT INTO counterparty_authorizations (id, counterparty_id, regulator, licence_reference, scope_description, evidence_uri, valid_from, valid_to, status, verified_by, verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING", [record.id, record.counterpartyId, record.regulator, record.licenceReference, record.scopeDescription, record.evidenceUri, record.validFrom, record.validTo, record.status, record.verifiedBy, record.verifiedAt]);
  const { rows } = await target.query("SELECT id, counterparty_id AS \"counterpartyId\", regulator, licence_reference AS \"licenceReference\", scope_description AS \"scopeDescription\", evidence_uri AS \"evidenceUri\", valid_from AS \"validFrom\", valid_to AS \"validTo\", status, verified_by AS \"verifiedBy\", verified_at AS \"verifiedAt\" FROM counterparty_authorizations WHERE id = ANY($1::uuid[]) ORDER BY id", [records.map(record => record.id)]);
  const asDate = value => new Date(value).toISOString().slice(0, 10);
  return reconcileTable(target, runId, "counterpartyAuthorizations", "counterparty_authorizations", records, rows.map(row => ({ ...row, validFrom: asDate(row.validFrom), validTo: row.validTo ? asDate(row.validTo) : null, verifiedAt: row.verifiedAt ? asIso(row.verifiedAt) : null })));
}

try {
  const [sourceUsers] = await source.query("SELECT openId, role FROM users ORDER BY openId");
  const [sourceCounterparties] = await source.query("SELECT id, legalName, counterpartyType, jurisdiction, createdAt FROM counterparties ORDER BY id");
  const [sourceCounterpartyAuthorizations] = await source.query("SELECT id, counterpartyId, regulator, licenceReference, scopeDescription, evidenceUrl, validFrom, validTo, status, verifiedBy, verifiedAt FROM counterpartyAuthorizations ORDER BY id");
  const [sourceCustomers] = await source.query("SELECT id, legalName, registrationIdentifier, kycStatus, createdAt FROM customers ORDER BY id");
  const [sourceBeneficiaries] = await source.query("SELECT id, customerId, legalName, countryCode, bankOrWalletReference, screeningState, createdAt FROM beneficiaries ORDER BY id");
  const mappedUsers = mapRoles(sourceUsers), counterparties = mapCounterparties(sourceCounterparties), counterpartyAuthorizations = mapCounterpartyAuthorizations(sourceCounterpartyAuthorizations), customers = mapCustomers(sourceCustomers), beneficiaries = mapBeneficiaries(sourceBeneficiaries);
  const sourceCounts = {};
  for (const table of businessTables) { const [rows] = await source.query(`SELECT COUNT(*) AS count FROM \`${table}\``); sourceCounts[table] = Number(rows[0].count); }
  const unsupportedNonEmptyTables = Object.entries(sourceCounts).filter(([table, count]) => count > 0 && !currentlyMappedBusinessTables.has(table)).map(([table]) => table);
  if (unsupportedNonEmptyTables.length) throw new Error(`Cutover blocked: approved extraction, mapping, loading, and reconciliation are not implemented for non-empty transitional tables: ${unsupportedNonEmptyTables.join(", ")}; no source business data was written`);
  const sourceSnapshotSha256 = checksum({ userRoles: mappedUsers, businessTableCounts: sourceCounts, counterparties, counterpartyAuthorizations, customers, beneficiaries });
  if (!dryRun && process.env.MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256 !== sourceSnapshotSha256) throw new Error(`Apply is blocked: MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256 must exactly match the current read-only source snapshot (${sourceSnapshotSha256})`);
  await target.connect(); await target.query("BEGIN");
  let runId = null;
  if (!dryRun) {
    const sourceFingerprint = checksum({ host: new URL(sourceUrl).host, database: new URL(sourceUrl).pathname });
    const run = await target.query("INSERT INTO postgres_cutover_runs (source_snapshot_sha256, source_database_fingerprint, mode, initiated_by, status) VALUES ($1,$2,'apply',$3,'running') RETURNING id", [sourceSnapshotSha256, sourceFingerprint, initiatedBy]);
    runId = run.rows[0].id;
    for (const record of mappedUsers) await target.query("INSERT INTO user_role_assignments (user_subject, role, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [record.userSubject, record.role, "transitional-mysql-cutover"]);
  }
  const { rows: targetUsers } = await target.query("SELECT user_subject AS \"userSubject\", role FROM user_role_assignments WHERE user_subject = ANY($1::text[]) AND revoked_at IS NULL ORDER BY user_subject, role", [mappedUsers.map(record => record.userSubject)]);
  const userReconciliation = await reconcileTable(target, runId, "users", "user_role_assignments", mappedUsers, targetUsers);
  const businessReconciliations = [await migrateCounterparties(counterparties, runId), await migrateCounterpartyAuthorizations(counterpartyAuthorizations, runId), await migrateCustomers(customers, runId), await migrateBeneficiaries(beneficiaries, runId)];
  if (!dryRun) await target.query("UPDATE postgres_cutover_runs SET status='verified', completed_at=now() WHERE id=$1", [runId]);
  await target.query(dryRun ? "ROLLBACK" : "COMMIT");
  process.stdout.write(`${JSON.stringify({ migrated: !dryRun, sourceSnapshotSha256, reconciliations: [userReconciliation, ...businessReconciliations], businessTableCounts: sourceCounts, unsupportedBusinessTablesBlocked: unsupportedNonEmptyTables }, null, 2)}\n`);
} catch (error) {
  await target.query("ROLLBACK").catch(() => undefined); throw error;
} finally { source.destroy(); await target.end().catch(() => undefined); }
