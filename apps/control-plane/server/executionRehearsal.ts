import { getPool, type Actor } from "./postgres";

/**
 * Execution rehearsal + stablecoin orchestration persistence
 * (migrations 0029/0030/0055).
 *
 * Previously orphaned schema. These surfaces record rehearsal outcomes,
 * route reviews, execution evidence pointers and settlement-attempt
 * idempotency facts. They never initiate external execution — the schema
 * enforces external_execution_initiated / external_execution_observed =
 * FALSE and terminal-decision immutability lives in 0056.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;
const HTTPS_RE = /^https:\/\//;

function assertEvidencePointer(uri: string, sha256: string, label = "evidence") {
  if (!HTTPS_RE.test(uri)) throw new Error(`${label}_uri must be an https:// URI`);
  if (!SHA256_RE.test(sha256)) throw new Error(`${label}_sha256 must be 64 lowercase hex chars`);
}

// -------------------------------------------- stablecoin orchestration routes

export async function configureStablecoinOrchestrationRoute(actor: Actor, input: {
  corridor: string;
  asset: "USDC" | "USDT";
  counterpartyId: string;
  integrationConnectionId: string;
  requiresTravelRule: boolean;
  beneficiaryEvidenceRequired: boolean;
  routePolicyEvidenceUri: string;
  routePolicyEvidenceSha256: string;
}) {
  assertEvidencePointer(input.routePolicyEvidenceUri, input.routePolicyEvidenceSha256, "route_policy_evidence");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stablecoin_orchestration_routes
       (corridor, asset, counterparty_id, integration_connection_id, requires_travel_rule,
        beneficiary_evidence_required, route_policy_evidence_uri, route_policy_evidence_sha256, configured_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (corridor, asset, counterparty_id, integration_connection_id) DO UPDATE
       SET requires_travel_rule=$5, beneficiary_evidence_required=$6,
           route_policy_evidence_uri=$7, route_policy_evidence_sha256=$8,
           configured_by=$9, configured_at=now()
     RETURNING id`,
    [
      input.corridor, input.asset, input.counterpartyId, input.integrationConnectionId,
      input.requiresTravelRule, input.beneficiaryEvidenceRequired,
      input.routePolicyEvidenceUri, input.routePolicyEvidenceSha256, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

export async function reviewStablecoinOrchestrationRoute(actor: Actor, input: {
  routeId: string;
  decision: "approved" | "blocked";
  rationale: string;
}) {
  if (!["admin", "compliance_officer"].includes(actor.role)) {
    throw new Error("route reviews require admin or compliance_officer role");
  }
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stablecoin_orchestration_route_reviews (route_id, decision, rationale, decided_by, decided_role)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.routeId, input.decision, input.rationale, actor.openId, actor.role],
  );
  return { id: rows[0].id };
}

export async function listStablecoinOrchestrationRoutes(corridor?: string) {
  const { rows } = await getPool().query(
    `SELECT r.id, r.corridor, r.asset, r.counterparty_id AS "counterpartyId",
            r.integration_connection_id AS "integrationConnectionId",
            r.requires_travel_rule AS "requiresTravelRule",
            r.beneficiary_evidence_required AS "beneficiaryEvidenceRequired",
            r.route_policy_evidence_uri AS "routePolicyEvidenceUri",
            r.configured_by AS "configuredBy", r.configured_at AS "configuredAt",
            (SELECT rv.decision FROM stablecoin_orchestration_route_reviews rv
              WHERE rv.route_id = r.id ORDER BY rv.decided_at DESC LIMIT 1) AS "latestReviewDecision"
       FROM stablecoin_orchestration_routes r
      ${corridor ? "WHERE r.corridor=$1" : ""}
      ORDER BY r.configured_at DESC LIMIT 500`,
    corridor ? [corridor] : [],
  );
  return rows;
}

// ------------------------------------------------- authorised execution tests

export async function recordAuthorisedExecutionTest(actor: Actor, input: {
  counterpartyId: string;
  corridor: string;
  testPlanEvidenceUri: string;
  authorisationEvidenceUri?: string | null;
  status: "documented" | "authorised" | "blocked" | "closed";
}) {
  if (!HTTPS_RE.test(input.testPlanEvidenceUri)) throw new Error("test_plan_evidence_uri must be an https:// URI");
  if (input.status === "authorised" && !input.authorisationEvidenceUri) {
    throw new Error("status 'authorised' requires authorisation_evidence_uri");
  }
  if (input.authorisationEvidenceUri && !HTTPS_RE.test(input.authorisationEvidenceUri)) {
    throw new Error("authorisation_evidence_uri must be an https:// URI");
  }
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO authorised_execution_tests
       (counterparty_id, corridor, test_plan_evidence_uri, authorisation_evidence_uri, status, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.counterpartyId, input.corridor, input.testPlanEvidenceUri, input.authorisationEvidenceUri ?? null, input.status, actor.openId],
  );
  return { id: rows[0].id };
}

// ------------------------------------------------- execution approval rehearsals

export async function recordExecutionApprovalRehearsal(actor: Actor, input: {
  paymentOrderId: string;
  counterpartyId: string;
  stablecoinRouteId?: string | null;
  outcome: "blocked" | "ready_for_authorised_execution";
  prerequisiteSnapshot: Record<string, unknown>;
  rationale: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO execution_approval_rehearsals
       (payment_order_id, counterparty_id, stablecoin_route_id, outcome,
        prerequisite_snapshot, rationale, evaluated_by, evaluated_role)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
    [
      input.paymentOrderId, input.counterpartyId, input.stablecoinRouteId ?? null,
      input.outcome, JSON.stringify(input.prerequisiteSnapshot), input.rationale,
      actor.openId, actor.role,
    ],
  );
  return { id: rows[0].id };
}

export async function listExecutionApprovalRehearsals(paymentOrderId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, payment_order_id AS "paymentOrderId", counterparty_id AS "counterpartyId",
            stablecoin_route_id AS "stablecoinRouteId", outcome, prerequisite_snapshot AS "prerequisiteSnapshot",
            rationale, evaluated_by AS "evaluatedBy", evaluated_role AS "evaluatedRole", evaluated_at AS "evaluatedAt"
       FROM execution_approval_rehearsals
      ${paymentOrderId ? "WHERE payment_order_id=$1" : ""}
      ORDER BY evaluated_at DESC LIMIT 500`,
    paymentOrderId ? [paymentOrderId] : [],
  );
  return rows;
}

// ---------------------------------------------------- stablecoin execution evidence

export async function recordStablecoinExecutionEvidence(actor: Actor, input: {
  paymentOrderId: string;
  routeId: string;
  evidenceKind: "travel_rule" | "beneficiary_verification" | "wallet_ownership";
  evidenceUri: string;
  evidenceSha256: string;
}) {
  assertEvidencePointer(input.evidenceUri, input.evidenceSha256);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stablecoin_execution_evidence
       (payment_order_id, route_id, evidence_kind, evidence_uri, evidence_sha256, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (payment_order_id, route_id, evidence_kind, evidence_sha256) DO NOTHING
     RETURNING id`,
    [input.paymentOrderId, input.routeId, input.evidenceKind, input.evidenceUri, input.evidenceSha256, actor.openId],
  );
  return { id: rows[0]?.id ?? null };
}

export async function listStablecoinExecutionEvidence(paymentOrderId: string) {
  const { rows } = await getPool().query(
    `SELECT id, route_id AS "routeId", evidence_kind AS "evidenceKind", evidence_uri AS "evidenceUri",
            evidence_sha256 AS "evidenceSha256", recorded_by AS "recordedBy", recorded_at AS "recordedAt"
       FROM stablecoin_execution_evidence WHERE payment_order_id=$1 ORDER BY recorded_at DESC`,
    [paymentOrderId],
  );
  return rows;
}

// --------------------------------------------- stablecoin settlement attempts (0055)

export async function recordStablecoinSettlementAttempt(actor: Actor, input: {
  paymentOrderId: string;
  paymentLegId: string;
  idempotencyKey: string;
  payloadSha256: string;
  direction: "onramp" | "offramp";
  asset: "USDC" | "USDT";
  fiatCurrency: "NGN" | "KES" | "ZAR" | "USD";
  amountMinor: string;
  providerReference?: string | null;
}) {
  if (!SHA256_RE.test(input.payloadSha256)) throw new Error("payload_sha256 must be 64 lowercase hex chars");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stablecoin_settlement_attempts
       (payment_order_id, payment_leg_id, idempotency_key, payload_sha256, direction, asset,
        fiat_currency, amount_minor, status, provider_reference, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,'prepared',$9,$10)
     ON CONFLICT (idempotency_key, direction) DO NOTHING
     RETURNING id`,
    [
      input.paymentOrderId, input.paymentLegId, input.idempotencyKey, input.payloadSha256,
      input.direction, input.asset, input.fiatCurrency, input.amountMinor,
      input.providerReference ?? null, actor.openId,
    ],
  );
  return { id: rows[0]?.id ?? null };
}

export async function listStablecoinSettlementAttempts(paymentOrderId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, payment_order_id AS "paymentOrderId", payment_leg_id AS "paymentLegId",
            idempotency_key AS "idempotencyKey", direction, asset, fiat_currency AS "fiatCurrency",
            amount_minor AS "amountMinor", status, provider_reference AS "providerReference",
            blockchain_transaction_hash AS "blockchainTransactionHash",
            failure_reason AS "failureReason", created_by AS "createdBy", created_at AS "createdAt"
       FROM stablecoin_settlement_attempts
      ${paymentOrderId ? "WHERE payment_order_id=$1" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    paymentOrderId ? [paymentOrderId] : [],
  );
  return rows;
}
