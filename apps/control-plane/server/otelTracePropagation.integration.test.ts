import { context, propagation, trace, type Context } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { describe, expect, it, beforeAll } from "vitest";
import {
  extractDaprTrace,
  extractKafkaTrace,
  extractTemporalTrace,
  hasValidActiveSpan,
  injectDaprTrace,
  injectKafkaTrace,
  injectTemporalTrace,
} from "./otelTracePropagation";

beforeAll(() => {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

const parent = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1,
  isRemote: false,
};

const parentContext = trace.setSpan(context.active(), trace.wrapSpanContext(parent));

function withParent<T>(fn: (activeContext: Context) => T): T {
  return fn(parentContext);
}

function assertExtracted(carrier: Record<string, string>, extractor: (value: Record<string, string>) => ReturnType<typeof context.active>) {
  const extracted = extractor(carrier);
  const spanContext = trace.getSpanContext(extracted);
  expect(spanContext?.traceId).toBe(parent.traceId);
  expect(spanContext?.spanId).toBe(parent.spanId);
  expect(spanContext?.traceFlags).toBe(parent.traceFlags);
}

describe("OpenTelemetry cross-middleware propagation", () => {
  it("propagates W3C trace context through Kafka headers", () => {
    const original = { "content-type": "application/json" };
    const headers = withParent(activeContext => injectKafkaTrace(original, activeContext));
    expect(original).toEqual({ "content-type": "application/json" });
    expect(headers.traceparent).toBe(`00-${parent.traceId}-${parent.spanId}-01`);
    assertExtracted(headers, extractKafkaTrace);
  });

  it("propagates W3C trace context through Temporal headers", () => {
    const headers = withParent(activeContext => injectTemporalTrace({ workflow: "payment-reconciliation" }, activeContext));
    expect(headers.workflow).toBe("payment-reconciliation");
    expect(headers.traceparent).toContain(parent.traceId);
    assertExtracted(headers, extractTemporalTrace);
  });

  it("propagates W3C trace context through Dapr sidecar headers", () => {
    const headers = withParent(activeContext => injectDaprTrace({ "dapr-api-token": "redacted-test-token" }, activeContext));
    expect(headers["dapr-api-token"]).toBe("redacted-test-token");
    expect(headers.traceparent).toContain(parent.spanId);
    assertExtracted(headers, extractDaprTrace);
  });

  it("rejects malformed or incomplete trace context without creating a valid span", () => {
    const malformed = extractDaprTrace({ traceparent: "not-a-w3c-trace" });
    expect(hasValidActiveSpan(malformed)).toBe(false);
    const incomplete = extractKafkaTrace({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7" });
    expect(hasValidActiveSpan(incomplete)).toBe(false);
  });
});
