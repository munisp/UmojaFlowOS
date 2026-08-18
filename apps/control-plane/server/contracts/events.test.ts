import { describe, expect, it } from "vitest";
import { parseNonExecutableComplianceEvent } from "./events";

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
});
