import { context, trace, type Context, type TextMapGetter, type TextMapSetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export type StringCarrier = Record<string, string>;

const setter: TextMapSetter<StringCarrier> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<StringCarrier> = {
  get(carrier, key) {
    return carrier[key];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

const w3cPropagator = new W3CTraceContextPropagator();

function inject(carrier: StringCarrier, activeContext: Context = context.active()): StringCarrier {
  const next = { ...carrier };
  w3cPropagator.inject(activeContext, next, setter);
  return next;
}

function extract(carrier: StringCarrier, baseContext: Context = context.active()): Context {
  return w3cPropagator.extract(baseContext, carrier, getter);
}

/** Inject W3C trace context into Kafka message headers without mutating caller state. */
export function injectKafkaTrace(headers: StringCarrier = {}, activeContext?: Context): StringCarrier {
  return inject(headers, activeContext);
}

/** Extract W3C trace context from Kafka message headers. */
export function extractKafkaTrace(headers: StringCarrier, baseContext?: Context): Context {
  return extract(headers, baseContext);
}

/** Inject W3C trace context into Temporal workflow/activity headers. */
export function injectTemporalTrace(headers: StringCarrier = {}, activeContext?: Context): StringCarrier {
  return inject(headers, activeContext);
}

/** Extract W3C trace context from Temporal workflow/activity headers. */
export function extractTemporalTrace(headers: StringCarrier, baseContext?: Context): Context {
  return extract(headers, baseContext);
}

/** Inject W3C trace context into Dapr sidecar HTTP headers. */
export function injectDaprTrace(headers: StringCarrier = {}, activeContext?: Context): StringCarrier {
  return inject(headers, activeContext);
}

/** Extract and validate W3C trace context from a Dapr sidecar request. */
export function extractDaprTrace(headers: StringCarrier, baseContext?: Context): Context {
  return extract(headers, baseContext);
}

export function hasValidActiveSpan(activeContext: Context = context.active()): boolean {
  const spanContext = trace.getSpanContext(activeContext);
  return Boolean(spanContext?.traceId && spanContext.spanId && spanContext.isRemote !== undefined);
}
