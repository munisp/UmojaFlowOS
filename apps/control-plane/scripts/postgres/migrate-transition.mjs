import crypto from "node:crypto";
import mysql from "mysql2/promise";
import pg from "pg";

const sourceUrl = process.env.MYSQL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("MYSQL_SOURCE_DATABASE_URL or DATABASE_URL is required");
const target = process.env.POSTGRES_DATABASE_URL
  ? new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL })
  : new pg.Client({ host: "/var/run/postgresql", database: "umojaflowos_dev", user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu" });
const source = await mysql.createConnection(sourceUrl);
const dryRun = process.env.MIGRATION_DRY_RUN === "1";
const roleMap = new Map([
  ["admin", "admin"],
  ["compliance_officer", "compliance_officer"],
  ["treasury_operator", "treasury_operator"],
  ["auditor", "auditor"],
]);
const businessTables = ["counterparties", "counterpartyAuthorizations", "customers", "beneficiaries", "paymentOrders", "paymentLegs", "liquidityPositions", "marketObservations", "complianceCases", "regulatoryReports", "regulatoryDeadlines", "alertPolicies", "activityEvents"];

function checksum(records) {
  return crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

try {
  const [sourceUsers] = await source.query("SELECT openId, role FROM users ORDER BY openId");
  const mappedUsers = sourceUsers.map(user => {
    const role = roleMap.get(user.role);
    if (!role) throw new Error(`Cutover blocked: transitional role '${user.role}' for '${user.openId}' has no approved PostgreSQL operating-role mapping`);
    return { userSubject: user.openId, role };
  });
  const sourceCounts = {};
  for (const table of businessTables) {
    const [rows] = await source.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    sourceCounts[table] = Number(rows[0].count);
  }
  if (Object.values(sourceCounts).some(count => count > 0)) throw new Error("Cutover blocked: approved table-level business-record mappings are required before non-empty transitional records can be migrated");
  await target.connect();
  await target.query("BEGIN");
  if (!dryRun) {
    for (const record of mappedUsers) {
      const existing = await target.query("SELECT 1 FROM user_role_assignments WHERE user_subject = $1 AND role = $2 AND revoked_at IS NULL", [record.userSubject, record.role]);
      if (!existing.rowCount) await target.query("INSERT INTO user_role_assignments (user_subject, role, assigned_by) VALUES ($1, $2, $3)", [record.userSubject, record.role, "transitional-mysql-cutover"]);
    }
  }
  const { rows: targetUsers } = await target.query("SELECT user_subject AS \"userSubject\", role FROM user_role_assignments WHERE revoked_at IS NULL ORDER BY user_subject");
  const sourceHash = checksum(mappedUsers);
  const targetHash = checksum(targetUsers.filter(record => mappedUsers.some(sourceRecord => sourceRecord.userSubject === record.userSubject && sourceRecord.role === record.role)));
  if (sourceHash !== targetHash) throw new Error(`Cutover reconciliation failed: source user-role checksum ${sourceHash} does not match destination checksum ${targetHash}`);
  await target.query(dryRun ? "ROLLBACK" : "COMMIT");
  process.stdout.write(`${JSON.stringify({ migrated: !dryRun, userRoleRecords: mappedUsers.length, sourceUserRoleChecksum: sourceHash, destinationUserRoleChecksum: targetHash, businessTableCounts: sourceCounts }, null, 2)}\n`);
} catch (error) {
  await target.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  source.destroy();
  await target.end().catch(() => undefined);
}
