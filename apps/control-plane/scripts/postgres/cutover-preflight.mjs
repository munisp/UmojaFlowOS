import crypto from "node:crypto";
import mysql from "mysql2/promise";
import pg from "pg";

const sourceUrl = process.env.MYSQL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
const targetUrl = process.env.POSTGRES_DATABASE_URL;

if (!sourceUrl) throw new Error("MYSQL_SOURCE_DATABASE_URL or DATABASE_URL is required for cutover preflight");

const source = await mysql.createConnection(sourceUrl);
const target = targetUrl
  ? new pg.Client({ connectionString: targetUrl })
  : new pg.Client({ host: "/var/run/postgresql", database: "umojaflowos_dev", user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu" });

const businessTables = [
  "counterparties", "counterpartyAuthorizations", "customers", "beneficiaries", "paymentOrders", "paymentLegs", "liquidityPositions", "marketObservations", "complianceCases", "regulatoryReports", "regulatoryDeadlines", "alertPolicies", "activityEvents",
];

try {
  await target.connect();
  const [sourceRows] = await source.query(`SELECT table_name AS tableName, table_rows AS estimatedRows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${businessTables.map(() => "?").join(", ")})`, businessTables);
  const sourceCounts = {};
  for (const table of businessTables) {
    const [rows] = await source.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    sourceCounts[table] = Number(rows[0].count);
  }
  const sourceHash = crypto.createHash("sha256").update(JSON.stringify(sourceCounts)).digest("hex");
  const { rows: targetTables } = await target.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const requiredTargetTables = ["counterparties", "customers", "payment_orders", "payment_legs", "compliance_cases", "regulatory_reports", "activity_events"];
  const missingTargetTables = requiredTargetTables.filter(name => !targetTables.some(row => row.tablename === name));
  if (missingTargetTables.length) throw new Error(`PostgreSQL canonical schema is incomplete: ${missingTargetTables.join(", ")}`);
  if (Object.values(sourceCounts).some(count => count > 0)) {
    throw new Error(`Cutover blocked: transitional MySQL contains business records. Produce an approved table-level mapping and destination count/checksum reconciliation before migrating. Source counts hash: ${sourceHash}`);
  }
  process.stdout.write(`${JSON.stringify({ ready: true, sourceCounts, sourceCountsHash: sourceHash, sourceTableMetadata: sourceRows, targetSchemaVerified: true }, null, 2)}\n`);
} finally {
  source.destroy();
  await target.end();
}
