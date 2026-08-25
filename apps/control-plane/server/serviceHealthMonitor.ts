import { getPool } from "./postgres";
import { collectAllServiceStatuses } from "./serviceHealth";
import { recordServiceHealthSamples } from "./serviceHealthHistory";

const ADVISORY_LOCK_KEY = 8_702_041_913;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 3_600;

export type HealthMonitorResult = {
  status: "collected" | "leader_unavailable" | "failed";
  written: number;
  observedAt?: string;
  reason?: string;
};

type MonitorDependencies = {
  acquireLeader: () => Promise<(() => Promise<void>) | null>;
  collect: typeof collectAllServiceStatuses;
  record: typeof recordServiceHealthSamples;
  now: () => Date;
};

function strictEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("UMOJA_SERVICE_HEALTH_MONITOR_ENABLED must be true or false");
}

function configuredInterval(value: string | undefined): number {
  if (value === undefined || value === "") return 300;
  if (!/^[0-9]+$/.test(value)) throw new Error("UMOJA_SERVICE_HEALTH_MONITOR_INTERVAL_SECONDS must be an integer");
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`UMOJA_SERVICE_HEALTH_MONITOR_INTERVAL_SECONDS must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`);
  }
  return seconds;
}

async function acquirePostgresLeader(): Promise<(() => Promise<void>) | null> {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [ADVISORY_LOCK_KEY]);
    if (!result.rows[0]?.acquired) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  };
}

const defaultDependencies: MonitorDependencies = {
  acquireLeader: acquirePostgresLeader,
  collect: collectAllServiceStatuses,
  record: recordServiceHealthSamples,
  now: () => new Date(),
};

/**
 * Executes exactly one bounded service-health collection round.  A PostgreSQL
 * session advisory lock elects one replica per round.  A second replica records
 * nothing rather than producing misleading duplicate samples or double alerts.
 */
export async function runServiceHealthMonitorRound(dependencies: MonitorDependencies = defaultDependencies): Promise<HealthMonitorResult> {
  let release: (() => Promise<void>) | null = null;
  try {
    release = await dependencies.acquireLeader();
    if (!release) return { status: "leader_unavailable", written: 0 };
    const collected = await dependencies.collect();
    const written = await dependencies.record(collected.services, dependencies.now());
    return { status: "collected", written, observedAt: collected.observedAt };
  } catch (error) {
    return { status: "failed", written: 0, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

export type ServiceHealthMonitor = { stop: () => void };

/**
 * Starts an internal scheduler only when explicitly enabled.  External cron
 * invocation remains supported; this monitor gives production deployments a
 * second, leader-elected option without exposing a browser-accessible trigger.
 */
export function startServiceHealthMonitor(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: MonitorDependencies = defaultDependencies,
  log: Pick<Console, "info" | "error"> = console,
): ServiceHealthMonitor | null {
  if (!strictEnabled(environment.UMOJA_SERVICE_HEALTH_MONITOR_ENABLED)) return null;
  const intervalMilliseconds = configuredInterval(environment.UMOJA_SERVICE_HEALTH_MONITOR_INTERVAL_SECONDS) * 1_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = () => {
    if (!stopped) timer = setTimeout(run, intervalMilliseconds);
  };
  const run = async () => {
    const result = await runServiceHealthMonitorRound(dependencies);
    if (result.status === "collected") log.info(`service health monitor recorded ${result.written} samples`);
    if (result.status === "failed") log.error(`service health monitor failed: ${result.reason}`);
    scheduleNext();
  };
  void run();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export const healthMonitorConfiguration = { strictEnabled, configuredInterval };
