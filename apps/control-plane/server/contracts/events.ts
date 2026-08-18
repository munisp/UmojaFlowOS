import { z } from "zod";

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  eventVersion: z.literal("v1"),
  correlationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  occurredAtUtc: z.string().datetime(),
});

export const compliancePolicyDecisionEventSchema = z.object({
  envelope: eventEnvelopeSchema,
  orderId: z.string().min(1),
  outcome: z.enum(["ALLOW", "MANUAL_REVIEW", "BLOCK"]),
  policyVersion: z.string().min(1),
  externalExecutionAuthorized: z.literal(false),
});

export type CompliancePolicyDecisionEvent = z.infer<typeof compliancePolicyDecisionEventSchema>;

export function parseNonExecutableComplianceEvent(input: unknown): CompliancePolicyDecisionEvent {
  return compliancePolicyDecisionEventSchema.parse(input);
}

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
