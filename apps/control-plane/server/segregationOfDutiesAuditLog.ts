import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type SoDAuditLogEvent = {
  event: "sod_monitor_evaluation" | "sod_alert_delivery" | "sod_monitor_indeterminate";
  occurredAt: string;
  correlationId?: string;
  evaluationState?: "clean" | "exceptions_detected" | "indeterminate";
  exceptionCount?: number;
  exceptionDigest?: string | null;
  deliveryState?: "accepted" | "unavailable";
  reasonCode?: string;
};

function configuredPath(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.UMOJA_SOD_AUDIT_LOG_PATH?.trim();
  if (!value) return null;
  if (!isAbsolute(value)) throw new Error("UMOJA_SOD_AUDIT_LOG_PATH must be an absolute path");
  return value;
}

/**
 * Appends a JSONL event for independently administered log collection. The event
 * carries only correlation/digest/count metadata: evidence bodies, provider data,
 * credentials, and customer details are intentionally omitted.
 */
export function appendSegregationOfDutiesAuditLog(
  event: SoDAuditLogEvent,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const path = configuredPath(environment);
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o640 });
}

export const segregationOfDutiesAuditLogConfiguration = { configuredPath };
