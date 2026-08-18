import { z } from "zod";

export const goPaymentOrderValidatedEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.literal("umojaflowos.payment.order.validated.v1"),
  schema_version: z.literal("v1"),
  occurred_at: z.string().datetime(),
  correlation_id: z.string().min(1),
  payload: z.unknown(),
}).strict();

export const rustPolicyDecisionEventSchema = z.object({
  event_id: z.string().min(1),
  correlation_id: z.string().min(1),
  event_type: z.literal("umojaflowos.policy.decision.v1"),
  schema_version: z.literal("v1"),
  decision: z.enum(["ALLOW", "MANUAL_REVIEW", "BLOCK"]),
  reason_codes: z.array(z.string().min(1)),
  external_execution_authorized: z.literal(false),
}).strict();

export type GoPaymentOrderValidatedEvent = z.infer<typeof goPaymentOrderValidatedEventSchema>;
export type RustPolicyDecisionEvent = z.infer<typeof rustPolicyDecisionEventSchema>;

export function parseGoPaymentOrderValidatedEvent(input: unknown): GoPaymentOrderValidatedEvent {
  return goPaymentOrderValidatedEventSchema.parse(input);
}

export function parseRustNonExecutablePolicyDecisionEvent(input: unknown): RustPolicyDecisionEvent {
  return rustPolicyDecisionEventSchema.parse(input);
}

export const pythonBronzeBatchManifestSchema = z.object({
  dataset: z.string().min(1),
  layer: z.literal("bronze"),
  schema_version: z.literal("v1"),
  record_count: z.number().int().min(0),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type PythonBronzeBatchManifest = z.infer<typeof pythonBronzeBatchManifestSchema>;

export function parsePythonBronzeBatchManifest(input: unknown): PythonBronzeBatchManifest {
  return pythonBronzeBatchManifestSchema.parse(input);
}
