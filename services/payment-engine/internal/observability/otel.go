package observability

import (
	"context"
	"net/http"
	"os"
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const defaultServiceName = "payment-engine"

// Init configures the process-wide W3C propagator and OTLP trace exporter.
// Export is best-effort and asynchronous; payment decisions never depend on
// telemetry availability. Shutdown must be deferred by the process owner.
func Init(ctx context.Context) (func(context.Context) error, error) {
	serviceName := os.Getenv("OTEL_SERVICE_NAME")
	if strings.TrimSpace(serviceName) == "" {
		serviceName = defaultServiceName
	}
	environment := os.Getenv("OTEL_ENVIRONMENT")
	if strings.TrimSpace(environment) == "" {
		environment = "local"
	}
	res, err := resource.New(ctx,
		resource.WithAttributes(
			// Keep the resource identity stable and never include customer or payment data.
			attributeString("service.name", serviceName),
			attributeString("service.namespace", "umojaflowos"),
			attributeString("deployment.environment", environment),
		),
	)
	if err != nil {
		return nil, err
	}
	exporter, err := otlptracegrpc.New(ctx)
	if err != nil {
		return nil, err
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))
	return provider.Shutdown, nil
}

// Handler instruments inbound HTTP requests and adds a bounded tenant.id
// attribute when supplied by an authenticated upstream. Authorization remains
// enforced by the application; telemetry never grants access.
func Handler(next http.Handler) http.Handler {
	return otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		span := trace.SpanFromContext(r.Context())
		if tenant := r.Header.Get("X-Tenant-ID"); tenant != "" {
			if len(tenant) > 128 {
				tenant = tenant[:128]
			}
			span.SetAttributes(attributeString("tenant.id", tenant))
		}
		next.ServeHTTP(w, r)
	}), "payment-engine")
}

// Small adapter keeps the public package surface limited to observability.
func attributeString(key, value string) attribute.KeyValue {
	return attribute.String(key, value)
}
