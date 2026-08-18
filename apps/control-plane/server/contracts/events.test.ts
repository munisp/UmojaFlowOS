import { describe, expect, it } from "vitest";
import { parseGoPaymentOrderValidatedEvent, parsePythonBronzeBatchManifest, parseRustNonExecutablePolicyDecisionEvent } from "./events";

describe("managed multi-language event contracts", () => {
  it("accepts the exact Go payment validation envelope", () => {
    expect(parseGoPaymentOrderValidatedEvent({ event_id: "go-event-1", event_type: "umojaflowos.payment.order.validated.v1", schema_version: "v1", occurred_at: "2026-08-18T00:00:00.000Z", correlation_id: "order-1", payload: { order_id: "order-1" } }).correlation_id).toBe("order-1");
  });

  it("rejects Rust policy events that request external execution", () => {
    expect(parseRustNonExecutablePolicyDecisionEvent({ event_id: "rust-event-1", correlation_id: "order-1", event_type: "umojaflowos.policy.decision.v1", schema_version: "v1", decision: "BLOCK", reason_codes: ["INPUT_UNAVAILABLE_EVENT_STREAM"], external_execution_authorized: false }).decision).toBe("BLOCK");
    expect(() => parseRustNonExecutablePolicyDecisionEvent({ event_id: "rust-event-1", correlation_id: "order-1", event_type: "umojaflowos.policy.decision.v1", schema_version: "v1", decision: "ALLOW", reason_codes: [], external_execution_authorized: true })).toThrow();
  });

  it("accepts the Python Bronze manifest only with a full SHA-256 digest", () => {
    expect(parsePythonBronzeBatchManifest({ dataset: "regulatory_reports", layer: "bronze", schema_version: "v1", record_count: 0, payload_sha256: "a".repeat(64) }).layer).toBe("bronze");
    expect(() => parsePythonBronzeBatchManifest({ dataset: "regulatory_reports", layer: "bronze", schema_version: "v1", record_count: 0, payload_sha256: "a".repeat(63) })).toThrow();
  });
});
