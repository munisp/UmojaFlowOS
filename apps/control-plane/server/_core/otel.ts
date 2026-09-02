import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";

const serviceName = process.env.OTEL_SERVICE_NAME || "control-plane";
const environment = process.env.OTEL_ENVIRONMENT || "local";

const sdk = new NodeSDK({
  serviceName,
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  autoDetectResources: true,
});

sdk.start();

const shutdown = async () => {
  await sdk.shutdown();
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

export { environment, serviceName };
