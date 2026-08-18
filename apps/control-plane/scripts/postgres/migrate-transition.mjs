import mysql from "mysql2/promise";
import pg from "pg";
import { checksum, mapRoles } from "./cutover-lib.mjs";

const sourceUrl = process.env.MYSQL_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("MYSQL_SOURCE_DATABASE_URL or DATABASE_URL is required");
const target = process.env.POSTGRES_DATABASE_URL
  ? new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL })
  : new pg.Client({ host: "/var/run/postgresql", database: "umojaflowos_dev", user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu" });
const source = await mysql.createConnection(sourceUrl);
const dryRun = process.env.MIGRATION_DRY_RUN === "1";
const approved = process.env.MIGRATION_EXECUTION_APPROVED === "1";
const initiatedBy = process.env.MIGRATION_INITIATED_BY;
if (!dryRun && (!approved || !initiatedBy)) throw new Error("Apply is blocked: set MIGRATION_EXECUTION_APPROVED=1 and MIGRATION_INITIATED_BY to an accountable operator subject");
const businessTables = ["counterparties", "counterpartyAuthorizations", "customers", "beneficiaries", "paymentOrders", "paymentLegs", "liquidityPositions", "marketObservations", "complianceCases", "regulatoryReports", "regulatoryDeadlines", "alertPolicies", "activityEvents"];

try {
  const [sourceUsers] = await source.query("SELECT openId, role FROM users ORDER BY openId");
  const mappedUsers = mapRoles(sourceUsers);
  const sourceCounts = {};
  for (const table of businessTables) {
    const [rows] = await source.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    sourceCounts[table] = Number(rows[0].count);
  }
  const snapshot = { userRoles: mappedUsers, businessTableCounts: sourceCounts };
  const sourceSnapshotSha256 = checksum(snapshot);
  const requiredSnapshot = process.env.MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256;
  if (!dryRun && requiredSnapshot !== sourceSnapshotSha256) throw new Error(`Apply is blocked: MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256 must exactly match the current read-only source snapshot (${sourceSnapshotSha256})`);
  if (Object.values(sourceCounts).some(count => count > 0)) throw new Error("Cutover blocked: approved table-level business-record mappings are required before non-empty transitional records can be migrated; no source business data was written");
  await target.connect();
  await target.query("BEGIN");
  let runId = null;
  if (!dryRun) {
    const sourceFingerprint = checksum({ host: new URL(sourceUrl).host, database: new URL(sourceUrl).pathname });
    const run = await target.query("INSERT INTO postgres_cutover_runs (source_snapshot_sha256, source_database_fingerprint, mode, initiated_by, status) VALUES ($1,$2,'apply',$3,'running') RETURNING id", [sourceSnapshotSha256, sourceFingerprint, initiatedBy]);
    runId = run.rows[0].id;
    for (const record of mappedUsers) {
      const existing = await target.query("SELECT 1 FROM user_role_assignments WHERE user_subject = $1 AND role = $2 AND revoked_at IS NULL", [record.userSubject, record.role]);
      if (!existing.rowCount) await target.query("INSERT INTO user_role_assignments (user_subject, role, assigned_by) VALUES ($1, $2, $3)", [record.userSubject, record.role, "transitional-mysql-cutover"]);
    }
  }
  const { rows: targetUsers } = await target.query("SELECT user_subject AS \"userSubject\", role FROM user_role_assignments WHERE revoked_at IS NULL ORDER BY user_subject");
  const sourceHash = checksum(mappedUsers);
  const targetHash = checksum(targetUsers.filter(record => mappedUsers.some(sourceRecord => sourceRecord.userSubject === record.userSubject && sourceRecord.role === record.role)));
  if (sourceHash !== targetHash) throw new Error(`Cutover reconciliation failed: source user-role checksum ${sourceHash} does not match destination checksum ${targetHash}`);
  if (!dryRun) {
    await target.query("INSERT INTO postgres_cutover_table_reconciliations (cutover_run_id, source_table, destination_table, source_count, destination_count, source_checksum, destination_checksum, status) VALUES ($1,'users','user_role_assignments',$2,$3,$4,$5,'verified')", [runId, mappedUsers.length, targetUsers.filter(record => mappedUsers.some(sourceRecord => sourceRecord.userSubject === record.userSubject && sourceRecord.role === record.role)).length, sourceHash, targetHash]);
    await target.query("UPDATE postgres_cutover_runs SET status='verified', completed_at=now() WHERE id=$1", [runId]);
  }
  await target.query(dryRun ? "ROLLBACK" : "COMMIT");
  process.stdout.write(`${JSON.stringify({ migrated: !dryRun, sourceSnapshotSha256, userRoleRecords: mappedUsers.length, sourceUserRoleChecksum: sourceHash, destinationUserRoleChecksum: targetHash, businessTableCounts: sourceCounts, businessDataBlocked: Object.values(sourceCounts).some(count => count > 0) }, null, 2)}\n`);
} catch (error) {
  await target.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  source.destroy();
  await target.end().catch(() => undefined);
}
