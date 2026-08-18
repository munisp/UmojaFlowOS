import { describe, expect, it } from "vitest";
import { parseGoPaymentOrderValidatedEvent, parseNonExecutableComplianceEvent, parsePythonBronzeBatchManifest, parseRustNonExecutablePolicyDecisionEvent } from "./events";

const envelope = {
  eventId: "event-1",
  eventType: "compliance.policy.decision.v1",
  eventVersion: "v1",
  correlationId: "order-1",
  idempotencyKey: "key-1",
  occurredAtUtc: "2026-08-18T00:00:00.000Z",
};

describe("control-plane event contract", () => {
  it("accepts a non-executable policy event", () => {
    expect(parseNonExecutableComplianceEvent({ envelope, orderId: "order-1", outcome: "MANUAL_REVIEW", policyVersion: "v1", externalExecutionAuthorized: false }).outcome).toBe("MANUAL_REVIEW");
  });

  it("rejects an externally executable policy event", () => {
    expect(() => parseNonExecutableComplianceEvent({ envelope, orderId: "order-1", outcome: "ALLOW", policyVersion: "v1", externalExecutionAuthorized: true })).toThrow();
  });

  it("accepts the exact Go payment-order validated envelope without executing it", () => {
    expect(parseGoPaymentOrderValidatedEvent({ event_id: "go-event-1", event_type: "umojaflowos.payment.order.validated.v1", schema_version: "v1", occurred_at: "2026-08-18T00:00:00.000Z", correlation_id: "order-1", payload: { order_id: "order-1" } }).event_type).toBe("umojaflowos.payment.order.validated.v1");
  });

  it("accepts the exact Rust policy event only when external execution remains false", () => {
    expect(parseRustNonExecutablePolicyDecisionEvent({ event_id: "rust-event-1", correlation_id: "order-1", event_type: "umojaflowos.policy.decision.v1", schema_version: "v1", decision: "BLOCK", reason_codes: ["INPUT_UNAVAILABLE_EVENT_STREAM"], external_execution_authorized: false }).decision).toBe("BLOCK");
    expect(() => parseRustNonExecutablePolicyDecisionEvent({ event_id: "rust-event-1", correlation_id: "order-1", event_type: "umojaflowos.policy.decision.v1", schema_version: "v1", decision: "ALLOW", reason_codes: [], external_execution_authorized: true })).toThrow();
  });

  it("accepts the exact Python Bronze manifest and rejects an unverifiable checksum", () => {
    expect(parsePythonBronzeBatchManifest({ dataset: "regulatory_reports", layer: "bronze", schema_version: "v1", record_count: 0, payload_sha256: "0".repeat(64) }).dataset).toBe("regulatory_reports");
    expect(() => parsePythonBronzeBatchManifest({ dataset: "regulatory_reports", layer: "bronze", schema_version: "v1", record_count: 0, payload_sha256: "unverified" })).toThrow();
  });
});
