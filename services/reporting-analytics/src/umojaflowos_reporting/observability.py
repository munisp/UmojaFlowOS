from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request, Response
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def configure(app: Any) -> None:
    resource = Resource.create({
        "service.name": os.getenv("OTEL_SERVICE_NAME", "reporting-analytics"),
        "service.namespace": "umojaflowos",
        "deployment.environment": os.getenv("OTEL_ENVIRONMENT", "local"),
    })
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz")
    HTTPXClientInstrumentor().instrument()
    tracer = trace.get_tracer("umojaflowos.reporting-analytics")

    @app.middleware("http")
    async def safe_request_attributes(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        span = trace.get_current_span()
        tenant = request.headers.get("x-tenant-id")
        if tenant:
            span.set_attribute("tenant.id", tenant[:128])
        span.set_attribute("umoja.request.path", request.url.path)
        with tracer.start_as_current_span("reporting.request.boundary") as child:
            child.set_attribute("http.method", request.method)
            child.set_attribute("url.path", request.url.path)
            return await call_next(request)

    app.state.otel_provider = provider
