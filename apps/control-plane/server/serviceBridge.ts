/**
 * Provider-independent bridge from the TypeScript control plane to the Go,
 * Rust, and Python service artifacts.
 *
 * Design rules, all enforced below rather than merely documented:
 *
 *  - **Disabled by default.** Each service has its own endpoint environment
 *    variable. If it is unset, the bridge reports `not_configured` and performs
 *    no network call. There is no default endpoint and no localhost fallback
 *    that could silently reach an unintended process.
 *  - **Private transport only.** A non-loopback endpoint must be HTTPS. A plain
 *    HTTP endpoint is accepted only on the loopback interface, matching the same
 *    rule the document-intelligence adapter applies to Ollama.
 *  - **Fail closed, never fabricate.** A timeout, a connection failure, a
 *    non-2xx status, unparseable JSON, or a contract violation all produce an
 *    `unavailable` outcome carrying the reason. The bridge never substitutes a
 *    default, a cached value, or a synthesised result.
 *  - **Contract-validated.** Every response passes through the versioned parser
 *    for its envelope type, so a drifted service cannot inject an unexpected
 *    field, a mismatched contract version, or an execution instruction.
 *  - **No execution authority.** The bridge exposes evaluation and assembly
 *    calls only. There is no method here that instructs any service to settle,
 *    transfer, or submit, and the contract layer rejects such payloads anyway.
 */

import { z } from "zod";
import {
  parseRustMonitoringResult,
  parseRustCounterpartyRisk,
  parsePythonAssembledReport,
  parsePythonStablecoinExposure,
  type RustMonitoringResult,
  type RustCounterpartyRisk,
  type PythonAssembledReport,
  type PythonStablecoinExposure,
} from "./contracts/services";
import { parseGoPaymentOrderValidatedEvent } from "./contracts/events";

export type ServiceName = "payment-engine" | "risk-compliance-core" | "reporting-analytics";

/** Environment variable that carries each service's base URL. */
const ENDPOINT_ENV: Record<ServiceName, string> = {
  "payment-engine": "UMOJA_PAYMENT_ENGINE_URL",
  "risk-compliance-core": "UMOJA_RISK_CORE_URL",
  "reporting-analytics": "UMOJA_REPORTING_URL",
};

/** Default request timeout. A hung service must not hang an operator request. */
const DEFAULT_TIMEOUT_MS = 5_000;

export type BridgeOutcome<T> =
  | { status: "ok"; service: ServiceName; result: T }
  | { status: "not_configured"; service: ServiceName; reason: string }
  | { status: "unavailable"; service: ServiceName; reason: string };

export class ServiceBridgeConfigurationError extends Error {}

/**
 * Resolve and validate a service endpoint.
 *
 * Returns null when the service is not configured, which is a legitimate state
 * rather than an error: provider-independent features must work with these
 * services switched off.
 */
export function resolveServiceEndpoint(
  service: ServiceName,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[ENDPOINT_ENV[service]];
  if (!raw || raw.trim() === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ServiceBridgeConfigurationError(
      `${ENDPOINT_ENV[service]} is not a valid absolute URL`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ServiceBridgeConfigurationError(
      `${ENDPOINT_ENV[service]} must use http on loopback or https elsewhere`,
    );
  }
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !loopback) {
    throw new ServiceBridgeConfigurationError(
      `${ENDPOINT_ENV[service]} uses plain HTTP to a non-loopback host; TLS is required off-host`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new ServiceBridgeConfigurationError(
      `${ENDPOINT_ENV[service]} must not embed credentials in the URL`,
    );
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

type CallOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Perform one contract-validated POST against a service.
 *
 * `validate` is the versioned contract parser. It runs on the decoded body, so
 * a service that returns a well-formed but non-conforming payload is treated as
 * unavailable rather than trusted.
 */
async function callService<T>(
  service: ServiceName,
  path: string,
  body: unknown,
  validate: (input: unknown) => T,
  options: CallOptions = {},
): Promise<BridgeOutcome<T>> {
  let endpoint: string | null;
  try {
    endpoint = resolveServiceEndpoint(service, options.env);
  } catch (error) {
    // A misconfigured endpoint is not the same as an absent one: it indicates an
    // operator error that must surface rather than be silently skipped.
    return {
      status: "unavailable",
      service,
      reason: error instanceof Error ? error.message : "invalid endpoint configuration",
    };
  }
  if (endpoint === null) {
    return {
      status: "not_configured",
      service,
      reason: `${ENDPOINT_ENV[service]} is not set; this service is disabled`,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        status: "unavailable",
        service,
        reason: `service returned HTTP ${response.status}`,
      };
    }

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      return { status: "unavailable", service, reason: "service returned a non-JSON body" };
    }

    try {
      return { status: "ok", service, result: validate(decoded) };
    } catch (error) {
      // Contract drift is a safety event, not a soft failure: the control plane
      // discards the payload entirely rather than using any part of it.
      return {
        status: "unavailable",
        service,
        reason: `contract violation: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      status: "unavailable",
      service,
      reason: aborted
        ? `service did not respond within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `service could not be reached: ${error instanceof Error ? error.message : "unknown"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Typed service calls.
 * ------------------------------------------------------------------ */

export const monitoringInputSchema = z
  .object({
    corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]),
    amount_minor_units: z.number().int().nullable(),
    reporting_threshold_minor_units: z.number().int().nullable(),
    customer_transactions_in_window: z.number().int().min(0).nullable(),
    max_transactions_per_window: z.number().int().min(0).nullable(),
    customer_value_in_window_minor_units: z.number().int().nullable(),
    max_value_per_window_minor_units: z.number().int().nullable(),
    counterparty_licence_verified: z.boolean().nullable(),
    beneficiary_jurisdiction_expected: z.boolean().nullable(),
  })
  .strict();

export type MonitoringInput = z.infer<typeof monitoringInputSchema>;

/** Evaluate transaction monitoring rules in the Rust risk core. */
export function evaluateMonitoringViaService(
  input: MonitoringInput,
  options?: CallOptions,
): Promise<BridgeOutcome<RustMonitoringResult>> {
  return callService(
    "risk-compliance-core",
    "/v1/monitoring/evaluate",
    monitoringInputSchema.parse(input),
    parseRustMonitoringResult,
    options,
  );
}

export const counterpartyRiskInputSchema = z
  .object({
    licence_status: z
      .enum(["VERIFIED", "PENDING_REVIEW", "EXPIRED", "SUSPENDED", "REJECTED"])
      .nullable(),
    licence_within_validity_window: z.boolean().nullable(),
    sanctions_clear: z.boolean().nullable(),
    adverse_findings_recorded: z.boolean().nullable(),
    days_since_last_review: z.number().int().min(0).nullable(),
    review_interval_days: z.number().int().min(1).nullable(),
  })
  .strict();

export type CounterpartyRiskInput = z.infer<typeof counterpartyRiskInputSchema>;

/** Assess counterparty risk in the Rust risk core. */
export function assessCounterpartyRiskViaService(
  input: CounterpartyRiskInput,
  options?: CallOptions,
): Promise<BridgeOutcome<RustCounterpartyRisk>> {
  return callService(
    "risk-compliance-core",
    "/v1/counterparty/assess",
    counterpartyRiskInputSchema.parse(input),
    parseRustCounterpartyRisk,
    options,
  );
}

/** Assemble a CBN, CBK, or SARB return in the Python reporting service. */
export function assembleReportViaService(
  input: unknown,
  options?: CallOptions,
): Promise<BridgeOutcome<PythonAssembledReport>> {
  return callService(
    "reporting-analytics",
    "/v1/reports/assemble",
    input,
    parsePythonAssembledReport,
    options,
  );
}

/** Compute USDC and USDT exposure in the Python reporting service. */
export function computeStablecoinExposureViaService(
  input: unknown,
  options?: CallOptions,
): Promise<BridgeOutcome<PythonStablecoinExposure>> {
  return callService(
    "reporting-analytics",
    "/v1/treasury/stablecoin-exposure",
    input,
    parsePythonStablecoinExposure,
    options,
  );
}

/** Validate a payment order in the Go payment engine. */
export function validatePaymentOrderViaService(
  input: unknown,
  options?: CallOptions,
): Promise<BridgeOutcome<unknown>> {
  return callService(
    "payment-engine",
    "/v1/orders/validate",
    input,
    parseGoPaymentOrderValidatedEvent,
    options,
  );
}

/**
 * Report which services are configured, without calling any of them.
 *
 * This backs the console's activation display: an operator can see at a glance
 * which multi-language capabilities are live and which are switched off.
 */
export function describeServiceConfiguration(env: NodeJS.ProcessEnv = process.env): Array<{
  service: ServiceName;
  configured: boolean;
  detail: string;
}> {
  return (Object.keys(ENDPOINT_ENV) as ServiceName[]).map(service => {
    try {
      const endpoint = resolveServiceEndpoint(service, env);
      return endpoint === null
        ? { service, configured: false, detail: `${ENDPOINT_ENV[service]} is not set` }
        : { service, configured: true, detail: `configured at ${endpoint}` };
    } catch (error) {
      return {
        service,
        configured: false,
        detail: error instanceof Error ? error.message : "invalid configuration",
      };
    }
  });
}
