
use opentelemetry::global;
use opentelemetry::{trace::TracerProvider, KeyValue};
use opentelemetry_otlp::SpanExporter;
use opentelemetry_sdk::{trace::SdkTracerProvider, Resource};
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init() -> SdkTracerProvider {
    let service_name = std::env::var("OTEL_SERVICE_NAME")
        .unwrap_or_else(|_| "ledger-gateway".to_string());
    let environment = std::env::var("OTEL_ENVIRONMENT")
        .unwrap_or_else(|_| "local".to_string());
    let resource = Resource::builder()
        .with_service_name(service_name)
        .with_attributes([
            KeyValue::new("service.namespace", "umojaflowos"),
            KeyValue::new("deployment.environment", environment),
        ])
        .build();
    let exporter = SpanExporter::builder()
        .with_tonic()
        .build()
        .expect("build OTLP trace exporter");
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build();
    let tracer = provider.tracer("umojaflowos.ledger-gateway");
    global::set_tracer_provider(provider.clone());
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .with(OpenTelemetryLayer::new(tracer))
        .init();
    provider
}
