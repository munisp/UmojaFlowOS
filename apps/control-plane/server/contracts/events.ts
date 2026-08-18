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
