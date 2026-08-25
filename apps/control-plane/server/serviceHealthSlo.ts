import { summariseServiceAvailability } from "./serviceHealthHistory";

export type ServiceHealthSloStatus = "insufficient_evidence" | "within_target" | "breach";

export type ServiceHealthSlo = {
  service: string;
  language: string;
  status: ServiceHealthSloStatus;
  targetAvailability: number;
  observedAvailability: number | null;
  samples: number;
  minimumSamples: number;
  medianLatencyMs: number | null;
  lastStatus: string;
  lastCollectedAt: Date;
  reason: string;
};

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`value must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

function boundedRatio(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < 0.9 || candidate > 1) throw new Error("availability target must be between 0.9 and 1");
  return candidate;
}

/**
 * Evaluates availability from persisted samples only.  The result is deliberately
 * not a production certification: a sparse or missing sample set is an explicit
 * insufficiency, not a green status.
 */
export async function evaluateServiceHealthSlo(input: {
  sinceMinutes?: number;
  targetAvailability?: number;
  minimumSamples?: number;
} = {}): Promise<ServiceHealthSlo[]> {
  const sinceMinutes = boundedInteger(input.sinceMinutes, 24 * 60, 60, 30 * 24 * 60);
  const targetAvailability = boundedRatio(input.targetAvailability, 0.995);
  const minimumSamples = boundedInteger(input.minimumSamples, 288, 1, 20_000);
  const summaries = await summariseServiceAvailability(sinceMinutes);
  return summaries.map(summary => {
    if (summary.samples < minimumSamples || summary.availability === null) {
      return {
        ...summary,
        status: "insufficient_evidence" as const,
        targetAvailability,
        observedAvailability: summary.availability,
        minimumSamples,
        reason: `observed ${summary.samples} samples; at least ${minimumSamples} are required before an SLO claim`,
      };
    }
    if (summary.availability < targetAvailability) {
      return {
        ...summary,
        status: "breach" as const,
        targetAvailability,
        observedAvailability: summary.availability,
        minimumSamples,
        reason: `observed availability ${(summary.availability * 100).toFixed(3)}% is below target ${(targetAvailability * 100).toFixed(3)}%`,
      };
    }
    return {
      ...summary,
      status: "within_target" as const,
      targetAvailability,
      observedAvailability: summary.availability,
      minimumSamples,
      reason: `observed availability ${(summary.availability * 100).toFixed(3)}% meets the configured target`,
    };
  });
}

export const serviceHealthSloValidation = { boundedInteger, boundedRatio };
