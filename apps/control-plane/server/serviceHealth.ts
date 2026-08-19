/**
 * Service health and metrics collection.
 *
 * This reuses the bridge's endpoint resolution deliberately: the dashboard must
 * obey exactly the same rules as every other cross-service call, so a service
 * that is not configured shows as not configured rather than as unhealthy, and
 * an endpoint that fails the transport rules is never contacted.
 *
 * Two properties matter more than anything else here:
 *
 *  - **An unreachable service is never rendered as healthy.** Every failure
 *    mode produces an explicit status with a stated reason.
 *  - **No metric is invented.** If a service does not report a counter, the
 *    counter is absent. The dashboard distinguishes "zero" from "unknown",
 *    because a fabricated zero is indistinguishable from a quiet system and
 *    would be actively misleading during an incident.
 */

import { z } from "zod";
import { resolveServiceEndpoint, ServiceBridgeConfigurationError, type ServiceName } from "./serviceBridge";

/** Services that expose a health and metrics interface. */
export const MONITORED_SERVICES: readonly ServiceName[] = [
  "payment-engine",
  "risk-compliance-core",
  "reporting-analytics",
  "ledger-gateway",
] as const;

/** The language each service is implemented in, shown on the dashboard. */
export const SERVICE_LANGUAGE: Record<ServiceName, "go" | "rust" | "python"> = {
  "payment-engine": "go",
  "risk-compliance-core": "rust",
  "ledger-gateway": "rust",
  "reporting-analytics": "python",
};

const HEALTH_TIMEOUT_MS = 3_000;

/**
 * Metrics are accepted as an open record of numeric counters plus the service's
 * own identity fields. Pinning an exact shape per service would mean the
 * dashboard breaks whenever a service adds a counter; instead, unknown numeric
 * counters are displayed generically and non-numeric values are discarded.
 */
const metricsSchema = z
  .object({
    service: z.string().min(1),
    language: z.enum(["go", "rust", "python"]),
    uptime_seconds: z.number().int().nonnegative(),
    observed_at: z.string().min(1),
  })
  .passthrough();

export type ServiceStatus =
  | {
      service: ServiceName;
      language: "go" | "rust" | "python";
      status: "not_configured";
      reason: string;
    }
  | {
      service: ServiceName;
      language: "go" | "rust" | "python";
      status: "unreachable";
      reason: string;
      latencyMs: number | null;
    }
  | {
      service: ServiceName;
      language: "go" | "rust" | "python";
      status: "healthy";
      latencyMs: number;
      uptimeSeconds: number;
      observedAt: string;
      /** Counters the service reported. Absent counters are simply not present. */
      counters: Record<string, number>;
      /** Posture strings such as provider_execution, reported verbatim. */
      posture: Record<string, string>;
    };

type CollectOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Collects one service's status. Never throws: an operator opening a status
 * dashboard during an incident must not be shown an error page because one
 * service is down.
 */
export async function collectServiceStatus(
  service: ServiceName,
  options: CollectOptions = {},
): Promise<ServiceStatus> {
  const language = SERVICE_LANGUAGE[service];

  let endpoint: string | null;
  try {
    endpoint = resolveServiceEndpoint(service, options.env);
  } catch (error) {
    // A misconfigured endpoint is an operator error and must be visible as
    // such, not folded into "not configured".
    return {
      service,
      language,
      status: "unreachable",
      reason:
        error instanceof ServiceBridgeConfigurationError
          ? error.message
          : "invalid endpoint configuration",
      latencyMs: null,
    };
  }

  if (endpoint === null) {
    return {
      service,
      language,
      status: "not_configured",
      reason: "no endpoint is configured for this service, so it is disabled",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(`${endpoint}/v1/metrics`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        service,
        language,
        status: "unreachable",
        reason: `service returned HTTP ${response.status}`,
        latencyMs,
      };
    }

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      return {
        service,
        language,
        status: "unreachable",
        reason: "service returned a non-JSON body",
        latencyMs,
      };
    }

    const parsed = metricsSchema.safeParse(decoded);
    if (!parsed.success) {
      // A service whose metrics do not parse is not healthy in any useful
      // sense: the dashboard cannot say anything true about it.
      return {
        service,
        language,
        status: "unreachable",
        reason: `metrics did not match the expected shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        latencyMs,
      };
    }

    // A service that reports a language other than the one it is implemented in
    // means the endpoint points at the wrong process.
    if (parsed.data.language !== language) {
      return {
        service,
        language,
        status: "unreachable",
        reason: `endpoint reports itself as ${parsed.data.language}, but ${service} is implemented in ${language}; the endpoint is misconfigured`,
        latencyMs,
      };
    }

    const counters: Record<string, number> = {};
    const posture: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (key === "service" || key === "language" || key === "observed_at") continue;
      if (typeof value === "number" && Number.isFinite(value)) counters[key] = value;
      else if (typeof value === "string") posture[key] = value;
      // Anything else is discarded rather than coerced.
    }

    return {
      service,
      language,
      status: "healthy",
      latencyMs,
      uptimeSeconds: parsed.data.uptime_seconds,
      observedAt: parsed.data.observed_at,
      counters,
      posture,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      service,
      language,
      status: "unreachable",
      reason: aborted
        ? `service did not respond within ${timeoutMs}ms`
        : `service could not be reached: ${error instanceof Error ? error.message : "unknown"}`,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collects every monitored service concurrently. One slow service must not
 * delay the whole dashboard beyond a single timeout.
 */
export async function collectAllServiceStatuses(options: CollectOptions = {}): Promise<{
  observedAt: string;
  services: ServiceStatus[];
}> {
  const services = await Promise.all(
    MONITORED_SERVICES.map(service => collectServiceStatus(service, options)),
  );
  return { observedAt: new Date().toISOString(), services };
}
