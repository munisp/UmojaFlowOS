import { Pool } from "pg";

const localDevelopmentConfig = {
  host: "/var/run/postgresql",
  database: "umojaflowos_dev",
  user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
};

let pool: Pool | undefined;

function getPool() {
  if (!pool) {
    pool = process.env.POSTGRES_DATABASE_URL
      ? new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL })
      : new Pool(localDevelopmentConfig);
  }
  return pool;
}

export async function getPostgresReadiness() {
  const client = await getPool().connect();
  try {
    const version = await client.query<{ version: string }>("SELECT version() AS version");
    const tableCount = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'");
    return {
      connected: true,
      database: client.database,
      tableCount: Number(tableCount.rows[0]?.count ?? 0),
      version: version.rows[0]?.version ?? "unknown",
    };
  } finally {
    client.release();
  }
}

const canonicalTables = [
  "activity_events", "alert_policies", "beneficiaries", "compliance_cases", "corridor_policies", "counterparties", "counterparty_authorizations", "customers", "integration_connections", "kyc_documents", "legal_entities", "liquidity_positions", "market_observations", "notification_deliveries", "payment_legs", "payment_orders", "policy_decisions", "rate_locks", "regulatory_deadlines", "regulatory_reports", "sar_str_filings", "scheduled_jobs", "user_role_assignments",
] as const;

export async function getPostgresCutoverReadiness() {
  const client = await getPool().connect();
  try {
    const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    const present = new Set(tables.rows.map(row => row.tablename));
    const missingTables = canonicalTables.filter(table => !present.has(table));
    return {
      ready: missingTables.length === 0,
      expectedTableCount: canonicalTables.length,
      presentTableCount: present.size,
      missingTables,
      activationBoundary: "PostgreSQL schema is locally validated; production cutover still requires a PostgreSQL deployment URI, a source snapshot, count-and-checksum reconciliation, and service health validation.",
    };
  } finally {
    client.release();
  }
}

export async function listPostgresCounterparties() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      legalName: string;
      counterpartyType: string;
      jurisdiction: string;
      createdAt: Date;
    }>("SELECT id, legal_name AS \"legalName\", counterparty_type AS \"counterpartyType\", jurisdiction, created_at AS \"createdAt\" FROM counterparties ORDER BY created_at DESC");
    return rows;
  } finally {
    client.release();
  }
}

export async function closePostgresPool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
