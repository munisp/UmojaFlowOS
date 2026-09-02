import { createServer, type Server } from "node:http";
import { context, trace } from "@opentelemetry/api";
import { describe, expect, it, afterEach } from "vitest";
import { injectKafkaTrace, injectTemporalTrace, injectDaprTrace, extractDaprTrace } from "./otelTracePropagation";

const parent = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1, isRemote: false };
const parentContext = trace.setSpan(context.active(), trace.wrapSpanContext(parent));

let server: Server | undefined;
afterEach(() => server?.close());

describe("cross-service OTLP propagation contract", () => {
  it("preserves one trace across Kafka and Temporal envelopes", () => {
    const kafka = injectKafkaTrace({ event: "payment" }, parentContext);
    const temporal = injectTemporalTrace({ workflow: "settlement" }, extractDaprTrace(kafka));
    expect(temporal.traceparent).toBe(kafka.traceparent);
    expect(extractDaprTrace(temporal)).toBeDefined();
  });

  it("preserves W3C context through a local Dapr sidecar HTTP hop", async () => {
    server = createServer((request, response) => {
      expect(request.headers.traceparent).toBeDefined();
      response.writeHead(204).end();
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock sidecar did not bind");
    const carrier = injectDaprTrace({ "dapr-app-id": "ledger-gateway" }, parentContext);
    const result = await fetch(`http://127.0.0.1:${address.port}/v1.0/invoke/ledger-gateway/method/healthz`, { headers: carrier });
    expect(result.status).toBe(204);
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
