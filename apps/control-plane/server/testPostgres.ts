import type { ClientConfig, PoolConfig } from "pg";

export function postgresTestConnectionConfig(): PoolConfig & ClientConfig {
  const connectionString = process.env.POSTGRES_DATABASE_URL;
  if (connectionString) return { connectionString };
  return {
    host: "/var/run/postgresql",
    database: "umojaflowos_dev",
    user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
  };
}

export function postgresTestPsqlArguments(): string[] {
  const connectionString = process.env.POSTGRES_DATABASE_URL;
  if (connectionString) return [connectionString];
  return ["-h", "/var/run/postgresql", "-U", process.env.POSTGRES_LOCAL_USER ?? "ubuntu", "umojaflowos_dev"];
}

/**
 * Purging regression fixtures touches append-only evidence rows and therefore
 * must use an explicitly supplied schema-owner connection. It intentionally
 * never falls back to the application connection used by production code.
 */
export function postgresTestSchemaOwnerPsqlArguments(): string[] {
  const connectionString = process.env.POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL is required for schema-owner integration fixture cleanup",
    );
  }
  return [connectionString];
}
