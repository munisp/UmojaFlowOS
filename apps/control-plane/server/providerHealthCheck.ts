import type { ProviderHealthCheckOutcome } from "./postgres";

/**
 * The provider health check.
 *
 * This performs a real network request to the configured provider endpoint and
 * reports what happened. It deliberately does not decide anything: it returns an
 * outcome, and the repository decides whether that outcome permits activation.
 * Keeping the probe and the decision apart is what makes the activation rule
 * testable without a provider, because the decision can be exercised against
 * every outcome shape while the probe is exercised against a real socket.
 *
 * The credential itself is resolved from the deployment environment at call
 * time using the stored reference. It is never read from the database, never
 * logged, and never returned.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

export type HealthCheckRequest = {
  endpoint: string;
  secretReference: string;
  timeoutMs?: number;
};

/**
 * Resolves the credential named by the reference from the process environment.
 * A reference that names nothing is a configuration error, and is reported as
 * such rather than being silently treated as an empty credential.
 */
export function resolveCredential(secretReference: string): string | null {
  const value = process.env[secretReference];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function outcome(
  endpoint: string,
  reachable: boolean,
  httpStatus: number | null,
  detail: string,
): ProviderHealthCheckOutcome {
  return { reachable, httpStatus, observedAt: new Date(), detail, endpoint };
}

/**
 * Issues the probe. Every failure mode produces an outcome with a stated
 * reason rather than an exception, because an unreachable provider is a normal
 * operational condition that must be recorded, not an error to swallow.
 */
export async function probeProviderEndpoint(request: HealthCheckRequest): Promise<ProviderHealthCheckOutcome> {
  const credential = resolveCredential(request.secretReference);
  if (credential === null) {
    return outcome(
      request.endpoint,
      false,
      null,
      `deployment secret ${request.secretReference} is not present in this environment, so no authenticated request could be made`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(request.endpoint, {
      method: "GET",
      headers: {
        // The credential is sent, never stored or echoed.
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
      },
      signal: controller.signal,
      redirect: "manual",
    });

    // A redirect during a health check usually means the endpoint is wrong, and
    // following it could send the credential somewhere unintended.
    if (response.status >= 300 && response.status < 400) {
      return outcome(request.endpoint, true, response.status, "provider redirected the health check; the endpoint is probably incorrect");
    }
    if (response.status === 401 || response.status === 403) {
      return outcome(request.endpoint, true, response.status, "provider rejected the supplied credential");
    }
    if (!response.ok) {
      return outcome(request.endpoint, true, response.status, `provider returned ${response.status}`);
    }
    return outcome(request.endpoint, true, response.status, `provider responded ${response.status}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason.includes("abort")) {
      return outcome(request.endpoint, false, null, `provider did not respond within ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    return outcome(request.endpoint, false, null, `provider endpoint unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
