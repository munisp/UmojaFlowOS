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
