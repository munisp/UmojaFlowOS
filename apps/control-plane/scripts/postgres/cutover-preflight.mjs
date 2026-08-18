import mysql from "mysql2/promise";
import pg from "pg";
import { checksum, deterministicUuid, mapRoles } from "./cutover-lib.mjs";

const sourceUrl = process.env.MYSQL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
const targetUrl = process.env.POSTGRES_DATABASE_URL;

if (!sourceUrl) throw new Error("MYSQL_SOURCE_DATABASE_URL or DATABASE_URL is required for cutover preflight");

const source = await mysql.createConnection(sourceUrl);
const target = targetUrl
  ? new pg.Client({ connectionString: targetUrl })
  : new pg.Client({ host: "/var/run/postgresql", database: "umojaflowos_dev", user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu" });

const businessTables = [
  "counterparties", "counterpartyAuthorizations", "integrationConnections", "customers", "beneficiaries", "paymentOrders", "paymentLegs", "liquidityPositions", "marketObservations", "complianceCases", "regulatoryReports", "regulatoryDeadlines", "alertPolicies", "activityEvents",
];
const asIso = value => new Date(value).toISOString();
const supportedCounterpartyTypes = new Set(["licensed_psp", "correspondent_bank", "stablecoin_provider", "fx_liquidity_provider", "custody_provider", "kyc_provider", "sanctions_provider", "chain_analytics_provider", "notification_provider", "regulatory_submission_provider"]);

try {
  await target.connect();
  const [sourceRows] = await source.query(`SELECT table_name AS tableName, table_rows AS estimatedRows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${businessTables.map(() => "?").join(", ")})`, businessTables);
  const sourceCounts = {};
  for (const table of businessTables) {
    const [rows] = await source.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    sourceCounts[table] = Number(rows[0].count);
  }
  const [sourceUsers] = await source.query("SELECT openId, role FROM users ORDER BY openId");
  const [sourceCounterparties] = await source.query("SELECT id, legalName, counterpartyType, jurisdiction, createdAt FROM counterparties ORDER BY id");
  const [sourceCounterpartyAuthorizations] = await source.query("SELECT id, counterpartyId, regulator, licenceReference, scopeDescription, evidenceUrl, validFrom, validTo, status, verifiedBy, verifiedAt FROM counterpartyAuthorizations ORDER BY id");
  const [sourceIntegrationConnections] = await source.query("SELECT id, counterpartyId, category, environment, documentationUrl, secretReference, state, lastHealthCheckedAt, lastHealthResult, createdAt FROM integrationConnections ORDER BY id");
  const [sourceCustomers] = await source.query("SELECT id, legalName, registrationIdentifier, kycStatus, createdAt FROM customers ORDER BY id");
  const [sourceBeneficiaries] = await source.query("SELECT id, customerId, legalName, countryCode, bankOrWalletReference, screeningState, createdAt FROM beneficiaries ORDER BY id");
  const mappedUsers = mapRoles(sourceUsers);
  const counterparties = sourceCounterparties.map(row => ({ id: deterministicUuid("counterparties", row.id), legalName: row.legalName, counterpartyType: row.counterpartyType, jurisdiction: row.jurisdiction, createdAt: asIso(row.createdAt) })).sort((a, b) => a.id.localeCompare(b.id));
  const unsupportedCounterparty = counterparties.find(record => !supportedCounterpartyTypes.has(record.counterpartyType));
  if (unsupportedCounterparty) throw new Error(`Cutover blocked: counterparty ${unsupportedCounterparty.id} has unsupported type '${unsupportedCounterparty.counterpartyType}'`);
  const asDate = value => new Date(value).toISOString().slice(0, 10);
  const counterpartyAuthorizations = sourceCounterpartyAuthorizations.map(row => ({ id: deterministicUuid("counterpartyAuthorizations", row.id), counterpartyId: deterministicUuid("counterparties", row.counterpartyId), regulator: row.regulator, licenceReference: row.licenceReference, scopeDescription: row.scopeDescription, evidenceUri: row.evidenceUrl, validFrom: asDate(row.validFrom), validTo: row.validTo ? asDate(row.validTo) : null, status: row.status, verifiedBy: row.verifiedBy ?? null, verifiedAt: row.verifiedAt ? asIso(row.verifiedAt) : null })).sort((a, b) => a.id.localeCompare(b.id));
  const integrationConnections = sourceIntegrationConnections.map(row => ({ id: deterministicUuid("integrationConnections", row.id), counterpartyId: deterministicUuid("counterparties", row.counterpartyId), category: row.category, environment: row.environment, documentationUrl: row.documentationUrl, secretReference: row.secretReference ?? null, state: row.state, lastHealthCheckedAt: row.lastHealthCheckedAt ? asIso(row.lastHealthCheckedAt) : null, lastHealthResult: row.lastHealthResult ?? null, createdAt: asIso(row.createdAt) })).sort((a, b) => a.id.localeCompare(b.id));
  const customers = sourceCustomers.map(row => ({ id: deterministicUuid("customers", row.id), legalName: row.legalName, registrationIdentifier: row.registrationIdentifier, kycStatus: row.kycStatus, createdAt: asIso(row.createdAt) })).sort((a, b) => a.id.localeCompare(b.id));
  const beneficiaries = sourceBeneficiaries.map(row => ({ id: deterministicUuid("beneficiaries", row.id), customerId: deterministicUuid("customers", row.customerId), legalName: row.legalName, countryCode: row.countryCode, bankOrWalletReference: row.bankOrWalletReference, screeningState: row.screeningState, createdAt: asIso(row.createdAt) })).sort((a, b) => a.id.localeCompare(b.id));
  const sourceSnapshotSha256 = checksum({ userRoles: mappedUsers, businessTableCounts: sourceCounts, counterparties, counterpartyAuthorizations, integrationConnections, customers, beneficiaries });
  const { rows: targetTables } = await target.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const requiredTargetTables = ["counterparties", "customers", "payment_orders", "payment_legs", "compliance_cases", "regulatory_reports", "activity_events"];
  const missingTargetTables = requiredTargetTables.filter(name => !targetTables.some(row => row.tablename === name));
  if (missingTargetTables.length) throw new Error(`PostgreSQL canonical schema is incomplete: ${missingTargetTables.join(", ")}`);
  const nonEmptyBusinessTables = Object.entries(sourceCounts).filter(([, count]) => count > 0).map(([table]) => table);
  process.stdout.write(`${JSON.stringify({ ready: nonEmptyBusinessTables.length === 0, sourceCounts, sourceSnapshotSha256, mappedUserRoleCount: mappedUsers.length, nonEmptyBusinessTables, sourceTableMetadata: sourceRows, targetSchemaVerified: true, activationBoundary: nonEmptyBusinessTables.length ? "Business-data migration remains blocked until each non-empty table has an approved mapping and destination reconciliation contract." : "Only approved user-role assignments may be migrated after an accountable operator confirms this exact snapshot hash." }, null, 2)}\n`);
} finally {
  source.destroy();
  await target.end();
}
