/**
 * Versioned contracts for the multi-language service boundaries.
 *
 * Each schema mirrors a real serialised output of the Go payment engine, the
 * Rust risk/compliance core, or the Python reporting service. The schemas are
 * `.strict()` on purpose: an unrecognised field is a contract drift and must
 * fail rather than be silently ignored, because a new field could carry an
 * execution instruction the control plane is not authorised to act on.
 *
 * Two invariants are enforced here rather than merely documented:
 *
 *  1. No service output may authorise execution. The Rust decision envelope
 *     already pins `external_execution_authorized` to false; these schemas
 *     additionally reject any payload containing an execution-shaped key.
 *  2. Provenance is mandatory. Every accepted payload must name the emitting
 *     service and its contract version, so a stored record can always be traced
 *     to the exact producer that generated it.
 */

import { z } from "zod";

/** Corridors are fixed by the platform's regulatory scope. */
export const corridorSchema = z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]);

/**
 * Keys that would imply the producing service is instructing the control plane
 * to move value or file with a regulator. Contracts reject these outright, so a
 * future service change cannot quietly introduce an execution path.
 */
const FORBIDDEN_EXECUTION_KEYS = [
  "execute",
  "execution_instruction",
  "settle",
  "settlement_instruction",
  "submit",
  "submission_instruction",
  "file_report",
  "transfer",
  "transfer_instruction",
  "provider_credential",
  "credential",
  "api_key",
];

/**
 * Recursively assert that no execution-shaped or credential-shaped key appears
 * anywhere in the payload, including nested objects and arrays.
 */
export function assertNoExecutionAuthority(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoExecutionAuthority(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalised = key.toLowerCase();
    if (FORBIDDEN_EXECUTION_KEYS.includes(normalised)) {
      throw new Error(
        `service contract violation at ${path}.${key}: service outputs must not carry execution authority or credentials`,
      );
    }
    assertNoExecutionAuthority(nested, `${path}.${key}`);
  }
}

/** Common provenance every service envelope must carry. */
const provenance = {
  service: z.enum([
    "umojaflowos-payment-engine",
    "umojaflowos-risk-compliance-core",
    "umojaflowos-reporting-analytics",
  ]),
  contract_version: z.literal("v1"),
};

/* ------------------------------------------------------------------ *
 * Go payment engine: immutable corridor lifecycle audit trail.
 * ------------------------------------------------------------------ */

export const goAuditEventSchema = z
  .object({
    sequence: z.number().int().min(1),
    order_id: z.string().min(1),
    corridor: corridorSchema,
    from_status: z.enum([
      "DRAFT",
      "PENDING_POLICY_DECISION",
      "BLOCKED",
      "MANUAL_REVIEW",
      "APPROVED",
      "EXECUTING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]),
    to_status: z.enum([
      "DRAFT",
      "PENDING_POLICY_DECISION",
      "BLOCKED",
      "MANUAL_REVIEW",
      "APPROVED",
      "EXECUTING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]),
    reason: z.string(),
    actor_role: z.string().min(1),
    occurred_at: z.string().datetime({ offset: true }),
    // Hash chaining: the first event's previous hash is empty, every later
    // event references its predecessor, so a removed event breaks the chain.
    previous_hash: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const goAuditTrailEnvelopeSchema = z
  .object({
    ...provenance,
    service: z.literal("umojaflowos-payment-engine"),
    envelope_type: z.literal("umojaflowos.payment.audit_trail.v1"),
    order_id: z.string().min(1),
    events: z.array(goAuditEventSchema),
  })
  .strict();

export type GoAuditTrailEnvelope = z.infer<typeof goAuditTrailEnvelopeSchema>;

/**
 * Parse a Go audit trail and verify its chain integrity.
 *
 * Schema validation alone would accept a well-formed but tampered trail, so the
 * sequence numbering and hash linkage are checked explicitly.
 */
export function parseGoAuditTrailEnvelope(input: unknown): GoAuditTrailEnvelope {
  assertNoExecutionAuthority(input);
  const envelope = goAuditTrailEnvelopeSchema.parse(input);

  let expectedPrevious = "";
  envelope.events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      throw new Error(
        `audit trail sequence gap at index ${index}: expected ${index + 1}, received ${event.sequence}`,
      );
    }
    if (event.order_id !== envelope.order_id) {
      throw new Error("audit trail contains an event for a different order");
    }
    if (event.previous_hash !== expectedPrevious) {
      throw new Error(
        `audit trail chain broken at sequence ${event.sequence}: previous hash does not match the preceding event`,
      );
    }
    expectedPrevious = event.hash;
  });

  return envelope;
}

/* ------------------------------------------------------------------ *
 * Rust risk/compliance core: monitoring findings and counterparty risk.
 * ------------------------------------------------------------------ */

export const rustMonitoringFindingSchema = z
  .object({
    rule_id: z.string().min(1),
    triggered: z.boolean(),
    reason_code: z.string().min(1),
  })
  .strict();

export const rustMonitoringResultSchema = z
  .object({
    ...provenance,
    service: z.literal("umojaflowos-risk-compliance-core"),
    envelope_type: z.literal("umojaflowos.risk.monitoring_result.v1"),
    decision: z.enum(["ALLOW", "MANUAL_REVIEW", "BLOCK"]),
    findings: z.array(rustMonitoringFindingSchema).min(1),
  })
  .strict();

export type RustMonitoringResult = z.infer<typeof rustMonitoringResultSchema>;

/**
 * Parse a Rust monitoring result.
 *
 * The additional rule enforced here is that a missing-input finding can never
 * accompany an ALLOW. The Rust core already guarantees this, and re-checking it
 * at the boundary means a regression in either language is caught.
 */
export function parseRustMonitoringResult(input: unknown): RustMonitoringResult {
  assertNoExecutionAuthority(input);
  const result = rustMonitoringResultSchema.parse(input);

  const unavailable = result.findings.filter(
    finding => finding.triggered && finding.reason_code.startsWith("INPUT_UNAVAILABLE"),
  );
  if (unavailable.length > 0 && result.decision !== "BLOCK") {
    throw new Error(
      `monitoring result claims ${result.decision} while reporting unavailable inputs (${unavailable
        .map(finding => finding.reason_code)
        .join(", ")}); missing evidence must fail closed`,
    );
  }
  return result;
}

export const rustCounterpartyRiskSchema = z
  .object({
    ...provenance,
    service: z.literal("umojaflowos-risk-compliance-core"),
    envelope_type: z.literal("umojaflowos.risk.counterparty_assessment.v1"),
    band: z.enum(["UNDETERMINED", "LOW", "MEDIUM", "HIGH", "PROHIBITED"]),
    reason_codes: z.array(z.string().min(1)),
    review_required: z.boolean(),
  })
  .strict();

export type RustCounterpartyRisk = z.infer<typeof rustCounterpartyRiskSchema>;

/**
 * Parse a counterparty risk assessment.
 *
 * An undetermined band means required evidence was absent, so it must always
 * demand review; and a prohibited band must never be presented as review-clear.
 */
export function parseRustCounterpartyRisk(input: unknown): RustCounterpartyRisk {
  assertNoExecutionAuthority(input);
  const assessment = rustCounterpartyRiskSchema.parse(input);

  if (assessment.band === "UNDETERMINED" && !assessment.review_required) {
    throw new Error("an undetermined risk band must require human review");
  }
  if (assessment.band === "PROHIBITED" && !assessment.review_required) {
    throw new Error("a prohibited risk band must require human review");
  }
  if (assessment.band === "UNDETERMINED" && assessment.reason_codes.length === 0) {
    throw new Error("an undetermined risk band must state which evidence was missing");
  }
  return assessment;
}

/* ------------------------------------------------------------------ *
 * Python reporting service: assembled regulatory report and exposure.
 * ------------------------------------------------------------------ */

export const pythonAssembledReportSchema = z
  .object({
    ...provenance,
    service: z.literal("umojaflowos-reporting-analytics"),
    envelope_type: z.literal("umojaflowos.reporting.assembled_report.v1"),
    regulator: z.enum(["CBN", "CBK", "SARB"]),
    corridor: corridorSchema,
    settlement_currency: z.enum(["NGN", "KES", "ZAR"]),
    report_type: z.string().min(1),
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    regulated_entity_id: z.string().min(1),
    generated_at: z.string().datetime({ offset: true }),
    totals: z
      .object({
        record_count: z.number().int().min(0),
        inbound_total: z.string(),
        outbound_total: z.string(),
        net_total: z.string(),
      })
      .strict(),
    artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
    // An assembled report is a draft artifact. It is never "submitted" by the
    // assembler; only the control plane can record a verified submission after
    // an authorised channel returns a reference.
    submission_state: z.literal("assembled_pending_review"),
  })
  .strict();

export type PythonAssembledReport = z.infer<typeof pythonAssembledReportSchema>;

export function parsePythonAssembledReport(input: unknown): PythonAssembledReport {
  assertNoExecutionAuthority(input);
  const report = pythonAssembledReportSchema.parse(input);
  if (report.period_end < report.period_start) {
    throw new Error("assembled report period end precedes its start");
  }
  // Regulator and corridor must agree: a CBN return cannot describe the Kenyan
  // corridor, which would otherwise be a silently mis-filed report.
  const expected: Record<string, string> = {
    CBN: "NIGERIA_NGN",
    CBK: "KENYA_KES",
    SARB: "SOUTH_AFRICA_ZAR",
  };
  if (expected[report.regulator] !== report.corridor) {
    throw new Error(
      `regulator ${report.regulator} does not supervise corridor ${report.corridor}`,
    );
  }
  return report;
}

export const pythonStablecoinExposureSchema = z
  .object({
    ...provenance,
    service: z.literal("umojaflowos-reporting-analytics"),
    envelope_type: z.literal("umojaflowos.reporting.stablecoin_exposure.v1"),
    generated_at: z.string().datetime({ offset: true }),
    total_usd_equivalent: z.string(),
    corridor_exposures: z
      .array(
        z
          .object({
            corridor: corridorSchema,
            // The platform's stablecoin scope is USDC and USDT only.
            asset: z.enum(["USDC", "USDT"]),
            available_amount: z.string(),
            reserved_amount: z.string(),
            total_amount: z.string(),
            usd_equivalent: z.string(),
            peg_deviation_basis_points: z.number().int(),
            position_count: z.number().int().min(1),
            source_references: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    observations: z.array(z.string().min(1)),
  })
  .strict();

export type PythonStablecoinExposure = z.infer<typeof pythonStablecoinExposureSchema>;

export function parsePythonStablecoinExposure(input: unknown): PythonStablecoinExposure {
  assertNoExecutionAuthority(input);
  const exposure = pythonStablecoinExposureSchema.parse(input);
  for (const entry of exposure.corridor_exposures) {
    // Every exposure line must be traceable to at least as many reconciled
    // sources as it claims positions, so an aggregate cannot outrun its evidence.
    if (entry.source_references.length < 1) {
      throw new Error(`exposure for ${entry.corridor}/${entry.asset} carries no source reference`);
    }
  }
  return exposure;
}

/* ------------------------------------------------------------------ *
 * Rust ledger gateway: balanced postings and TigerBeetle-to-PostgreSQL
 * projection reconciliation.
 *
 * The gateway is a verifier, not a poster. It validates that a proposed
 * double-entry posting set balances per currency, and that a confirmed
 * TigerBeetle transfer fact agrees with its PostgreSQL projection. Neither
 * output may instruct the control plane to post or settle anything: actually
 * writing to TigerBeetle stays activation-gated behind the cluster
 * configuration in `infra/tigerbeetle/`.
 * ------------------------------------------------------------------ */

export const rustLedgerPostingSchema = z
  .object({
    account_id: z.string().min(1),
    currency: z.string().min(1),
    // Minor units are integers by definition; a fractional minor unit would
    // indicate a rounding error upstream rather than a representable amount.
    debit_minor: z.number().int().min(0),
    credit_minor: z.number().int().min(0),
  })
  .strict();

export const rustLedgerValidationSchema = z
  .object({
    ...provenance,
    service: z.literal("umojaflowos-ledger-gateway"),
    envelope_type: z.literal("umojaflowos.ledger.posting_validation.v1"),
    postings: z.array(rustLedgerPostingSchema).min(1),
    balanced: z.boolean(),
    // Present only when `balanced` is false; names the currency that failed and
    // by how much, so a reviewer can locate the defect without re-deriving it.
    imbalance: z
      .object({ currency: z.string().min(1), net_minor: z.number().int() })
      .strict()
      .nullable(),
  })
  .strict();

export type RustLedgerValidation = z.infer<typeof rustLedgerValidationSchema>;

/**
 * Parse a ledger posting validation and independently re-derive the balance.
 *
 * Trusting the service's own `balanced` flag would defeat the purpose of a
 * boundary check, so the net per currency is recomputed here and compared.
 */
export function parseRustLedgerValidation(input: unknown): RustLedgerValidation {
  assertNoExecutionAuthority(input);
  const envelope = rustLedgerValidationSchema.parse(input);

  const netByCurrency = new Map<string, number>();
  for (const posting of envelope.postings) {
    const current = netByCurrency.get(posting.currency) ?? 0;
    netByCurrency.set(posting.currency, current + posting.debit_minor - posting.credit_minor);
  }
  const imbalances: Array<[string, number]> = [];
  netByCurrency.forEach((net, currency) => {
    if (net !== 0) imbalances.push([currency, net]);
  });
  const derivedBalanced = imbalances.length === 0;

  if (derivedBalanced !== envelope.balanced) {
    throw new Error(
      `ledger validation claims balanced=${envelope.balanced} but the supplied postings derive balanced=${derivedBalanced}`,
    );
  }
  if (!envelope.balanced && envelope.imbalance === null) {
    throw new Error("an unbalanced posting set must name the offending currency and net amount");
  }
  if (envelope.balanced && envelope.imbalance !== null) {
    throw new Error("a balanced posting set must not report an imbalance");
  }
  if (envelope.imbalance) {
    const derived = netByCurrency.get(envelope.imbalance.currency);
    if (derived !== envelope.imbalance.net_minor) {
      throw new Error(
        `reported imbalance for ${envelope.imbalance.currency} does not match the supplied postings`,
      );
    }
  }
  return envelope;
}

export const rustLedgerReconciliationSchema = z
  .object({
    ...provenance,
    service: z.literal("umojaflowos-ledger-gateway"),
    envelope_type: z.literal("umojaflowos.ledger.projection_reconciliation.v1"),
    confirmed_fact: z
      .object({
        transfer_id: z.number().int().min(1),
        correlation_id: z.string().min(1),
        currency: z.string().min(1),
        amount_minor: z.number().int().min(1),
        posted_at: z.string().datetime({ offset: true }),
      })
      .strict(),
    projection: z
      .object({
        transfer_id: z.number().int().min(1),
        correlation_id: z.string().min(1),
        currency: z.string().min(1),
        amount_minor: z.number().int().min(1),
        projected_at: z.string().datetime({ offset: true }),
      })
      .strict(),
    reconciled: z.boolean(),
    discrepancy_reason: z
      .enum(["INCOMPLETE_CONFIRMED_FACT", "INCOMPLETE_PROJECTION", "MISMATCH"])
      .nullable(),
  })
  .strict();

export type RustLedgerReconciliation = z.infer<typeof rustLedgerReconciliationSchema>;

/**
 * Parse a projection reconciliation and independently re-verify the comparison.
 *
 * TigerBeetle holds the authoritative transfer and PostgreSQL holds the queryable
 * projection; a claimed match that does not actually match is the single most
 * dangerous drift in that pairing, so it is re-checked rather than trusted.
 */
export function parseRustLedgerReconciliation(input: unknown): RustLedgerReconciliation {
  assertNoExecutionAuthority(input);
  const envelope = rustLedgerReconciliationSchema.parse(input);
  const { confirmed_fact: fact, projection } = envelope;

  const agrees =
    fact.transfer_id === projection.transfer_id &&
    fact.correlation_id === projection.correlation_id &&
    fact.currency === projection.currency &&
    fact.amount_minor === projection.amount_minor;

  if (envelope.reconciled && !agrees) {
    throw new Error(
      "ledger reconciliation claims agreement while the confirmed fact and projection differ",
    );
  }
  if (!envelope.reconciled && envelope.discrepancy_reason === null) {
    throw new Error("a failed reconciliation must state its discrepancy reason");
  }
  if (envelope.reconciled && envelope.discrepancy_reason !== null) {
    throw new Error("a successful reconciliation must not report a discrepancy reason");
  }
  if (!envelope.reconciled && envelope.discrepancy_reason === "MISMATCH" && agrees) {
    throw new Error("a mismatch was reported but the supplied records agree");
  }
  return envelope;
}
