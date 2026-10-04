import { getPool, type Actor } from "./postgres";

/**
 * Trade Payment Control OS persistence (migration 0031).
 *
 * Previously orphaned schema: the seven trade_case* tables had no reader or
 * writer anywhere in the platform, so trade-case data could not be persisted
 * at all. This module is the canonical write/read path. It records trade
 * cases, evidence pointers, route readiness and approvals — it never
 * initiates external execution (the schema enforces
 * external_execution_initiated = FALSE on the rehearsal surfaces).
 */

const SHA256_RE = /^[0-9a-f]{64}$/;
const HTTPS_RE = /^https:\/\//;
const CURRENCIES = ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"] as const;
const CASE_REF_RE = /^TPC-[A-Z0-9][A-Z0-9-]{5,78}$/;

export const TRADE_EVIDENCE_KINDS = [
  "purchase_order", "commercial_invoice", "supplier_contract", "import_trade_document",
  "supplier_kyb", "beneficiary_instruction", "funding_source", "stablecoin_provenance",
  "travel_rule", "authorised_dealer_authority", "route_capacity_confirmation",
  "provider_authorisation", "external_reconciliation_reference",
] as const;

export const TRADE_STAKEHOLDER_ROLES = [
  "corporate_trade_sponsor", "procurement_owner", "trade_finance_operator",
  "supplier_representative", "authorised_dealer_liaison", "reconciliation_reviewer",
] as const;

export const TRADE_APPROVAL_ROLES = [
  "corporate_trade_sponsor", "procurement_owner", "trade_finance_operator",
  "compliance_officer", "treasury_operator", "reconciliation_reviewer",
] as const;

function assertEvidencePointer(uri: string, sha256: string) {
  if (!HTTPS_RE.test(uri)) throw new Error("evidence_uri must be an https:// URI");
  if (!SHA256_RE.test(sha256)) throw new Error("evidence_sha256 must be 64 lowercase hex chars");
}

export async function createTradeCase(actor: Actor, input: {
  caseReference: string;
  legalEntityId: string;
  customerId?: string | null;
  supplierBeneficiaryId?: string | null;
  corridor: string;
  purchaseCurrency: (typeof CURRENCIES)[number];
  purchaseAmount: string;
  intendedSettlementCurrency: (typeof CURRENCIES)[number];
  purposeSummary: string;
}) {
  if (!CASE_REF_RE.test(input.caseReference)) throw new Error("case_reference must match ^TPC-[A-Z0-9][A-Z0-9-]{5,78}$");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_cases
       (case_reference, legal_entity_id, customer_id, supplier_beneficiary_id, corridor,
        purchase_currency, purchase_amount, intended_settlement_currency, purpose_summary, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10) RETURNING id`,
    [
      input.caseReference, input.legalEntityId, input.customerId ?? null, input.supplierBeneficiaryId ?? null,
      input.corridor, input.purchaseCurrency, input.purchaseAmount, input.intendedSettlementCurrency,
      input.purposeSummary, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

export async function transitionTradeCase(actor: Actor, input: { tradeCaseId: string; targetStatus: string }) {
  const allowed = ["draft", "evidence_requested", "route_readiness", "pending_independent_approval",
    "approved_for_authorised_release", "blocked", "reconciliation_pending", "reconciled", "cancelled"];
  if (!allowed.includes(input.targetStatus)) throw new Error("invalid trade case status");
  const { rowCount } = await getPool().query(
    `UPDATE trade_cases SET status=$2, updated_at=now() WHERE id=$1 AND status <> 'cancelled'`,
    [input.tradeCaseId, input.targetStatus],
  );
  if (rowCount === 0) throw new Error("trade case not found or cancelled");
}

export async function assignTradeCaseStakeholder(actor: Actor, input: {
  tradeCaseId: string;
  stakeholderRole: (typeof TRADE_STAKEHOLDER_ROLES)[number];
  stakeholderSubject: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_case_stakeholders (trade_case_id, stakeholder_role, stakeholder_subject, assigned_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (trade_case_id, stakeholder_role, stakeholder_subject) DO UPDATE
       SET revoked_at=NULL, assigned_by=$4, assigned_at=now()
     RETURNING id`,
    [input.tradeCaseId, input.stakeholderRole, input.stakeholderSubject, actor.openId],
  );
  return { id: rows[0].id };
}

export async function revokeTradeCaseStakeholder(actor: Actor, stakeholderId: string) {
  const { rowCount } = await getPool().query(
    `UPDATE trade_case_stakeholders SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`,
    [stakeholderId],
  );
  if (rowCount === 0) throw new Error("stakeholder assignment not found or already revoked");
}

export async function submitTradeCaseEvidence(actor: Actor, input: {
  tradeCaseId: string;
  evidenceKind: (typeof TRADE_EVIDENCE_KINDS)[number];
  evidenceUri: string;
  evidenceSha256: string;
}) {
  assertEvidencePointer(input.evidenceUri, input.evidenceSha256);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_case_evidence (trade_case_id, evidence_kind, evidence_uri, evidence_sha256, submitted_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (trade_case_id, evidence_kind, evidence_sha256) DO NOTHING
     RETURNING id`,
    [input.tradeCaseId, input.evidenceKind, input.evidenceUri, input.evidenceSha256, actor.openId],
  );
  return { id: rows[0]?.id ?? null };
}

export async function reviewTradeCaseEvidence(actor: Actor, input: {
  evidenceId: string;
  decision: "accepted" | "rejected" | "replacement_requested";
  rationale?: string;
}) {
  const result = input.decision === "replacement_requested"
    ? await getPool().query(
        `UPDATE trade_case_evidence SET review_status='replacement_requested' WHERE id=$1 AND review_status='submitted'`,
        [input.evidenceId],
      )
    : await getPool().query(
        `UPDATE trade_case_evidence
            SET review_status=$2, reviewed_by=$3, reviewed_at=now(), review_rationale=$4
          WHERE id=$1 AND review_status IN ('submitted','replacement_requested')`,
        [input.evidenceId, input.decision, actor.openId, input.rationale ?? null],
      );
  if (result.rowCount === 0) throw new Error("evidence not found or already finally reviewed");
}

export async function configureTradeCaseRoute(actor: Actor, input: {
  tradeCaseId: string;
  counterpartyId: string;
  integrationConnectionId: string;
  routeKind: "authorised_dealer_fx" | "bank_supplier_settlement" | "stablecoin_conversion" | "supply_chain_finance";
  sourceCurrency: (typeof CURRENCIES)[number];
  targetCurrency: (typeof CURRENCIES)[number];
  routePolicyEvidenceUri: string;
  routePolicyEvidenceSha256: string;
}) {
  assertEvidencePointer(input.routePolicyEvidenceUri, input.routePolicyEvidenceSha256);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_case_routes
       (trade_case_id, counterparty_id, integration_connection_id, route_kind,
        source_currency, target_currency, route_policy_evidence_uri, route_policy_evidence_sha256, configured_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.tradeCaseId, input.counterpartyId, input.integrationConnectionId, input.routeKind,
      input.sourceCurrency, input.targetCurrency, input.routePolicyEvidenceUri,
      input.routePolicyEvidenceSha256, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

export async function transitionTradeCaseRoute(actor: Actor, input: {
  routeId: string;
  readinessState: "evidence_pending" | "pending_compliance_review" | "approved_for_authorised_release" | "blocked";
}) {
  const { rowCount } = await getPool().query(
    `UPDATE trade_case_routes SET readiness_state=$2 WHERE id=$1`,
    [input.routeId, input.readinessState],
  );
  if (rowCount === 0) throw new Error("trade case route not found");
}

export async function recordTradeCaseApproval(actor: Actor, input: {
  tradeCaseId: string;
  approvalRole: (typeof TRADE_APPROVAL_ROLES)[number];
  decision: "approved" | "blocked" | "needs_information";
  rationale: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_case_approvals (trade_case_id, approval_role, decision, rationale, decided_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (trade_case_id, approval_role, decided_by) DO UPDATE
       SET decision=$3, rationale=$4, decided_at=now()
     RETURNING id`,
    [input.tradeCaseId, input.approvalRole, input.decision, input.rationale, actor.openId],
  );
  return { id: rows[0].id };
}

export async function raiseTradeCaseException(actor: Actor, input: {
  tradeCaseId: string;
  exceptionKind: "documentary_gap" | "counterparty_scope" | "route_capacity" | "beneficiary_change" | "travel_rule_gap" | "stablecoin_provenance_gap" | "policy_conflict" | "other";
  rationale: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_case_exceptions (trade_case_id, exception_kind, rationale, raised_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.tradeCaseId, input.exceptionKind, input.rationale, actor.openId],
  );
  return { id: rows[0].id };
}

export async function resolveTradeCaseException(actor: Actor, input: {
  exceptionId: string;
  decision: "remediated" | "rejected";
  resolutionRationale: string;
}) {
  const { rowCount } = await getPool().query(
    `UPDATE trade_case_exceptions
        SET status=$2, resolved_by=$3, resolved_at=now(), resolution_rationale=$4
      WHERE id=$1 AND status='open'`,
    [input.exceptionId, input.decision, actor.openId, input.resolutionRationale],
  );
  if (rowCount === 0) throw new Error("exception not found or already resolved");
}

export async function recordTradeCaseReconciliation(actor: Actor, input: {
  tradeCaseId: string;
  referenceKind: "provider_confirmation" | "bank_reference" | "supplier_receipt" | "trade_finance_reference" | "stablecoin_attestation";
  referenceUri: string;
  referenceSha256: string;
  status: "recorded" | "consistent" | "discrepant";
}) {
  assertEvidencePointer(input.referenceUri, input.referenceSha256);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_case_reconciliations (trade_case_id, reference_kind, reference_uri, reference_sha256, status, reviewed_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (trade_case_id, reference_kind, reference_sha256) DO UPDATE
       SET status=$5, reviewed_by=$6, reviewed_at=now()
     RETURNING id`,
    [input.tradeCaseId, input.referenceKind, input.referenceUri, input.referenceSha256, input.status, actor.openId],
  );
  return { id: rows[0].id };
}

export async function listTradeCases(legalEntityId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, case_reference AS "caseReference", legal_entity_id AS "legalEntityId", corridor,
            purchase_currency AS "purchaseCurrency", purchase_amount AS "purchaseAmount",
            intended_settlement_currency AS "intendedSettlementCurrency", status,
            created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM trade_cases ${legalEntityId ? "WHERE legal_entity_id=$1" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    legalEntityId ? [legalEntityId] : [],
  );
  return rows;
}

export async function getTradeCaseWorkspace(tradeCaseId: string) {
  const pool = getPool();
  const [kase, stakeholders, evidence, routes, approvals, exceptions, reconciliations] = await Promise.all([
    pool.query(`SELECT id, case_reference AS "caseReference", legal_entity_id AS "legalEntityId",
                  customer_id AS "customerId", supplier_beneficiary_id AS "supplierBeneficiaryId", corridor,
                  purchase_currency AS "purchaseCurrency", purchase_amount AS "purchaseAmount",
                  intended_settlement_currency AS "intendedSettlementCurrency", purpose_summary AS "purposeSummary",
                  status, created_by AS "createdBy", created_at AS "createdAt"
             FROM trade_cases WHERE id=$1`, [tradeCaseId]),
    pool.query(`SELECT id, stakeholder_role AS "stakeholderRole", stakeholder_subject AS "stakeholderSubject",
                  assigned_by AS "assignedBy", assigned_at AS "assignedAt", revoked_at AS "revokedAt"
             FROM trade_case_stakeholders WHERE trade_case_id=$1 ORDER BY assigned_at DESC`, [tradeCaseId]),
    pool.query(`SELECT id, evidence_kind AS "evidenceKind", evidence_uri AS "evidenceUri",
                  evidence_sha256 AS "evidenceSha256", review_status AS "reviewStatus",
                  submitted_by AS "submittedBy", submitted_at AS "submittedAt"
             FROM trade_case_evidence WHERE trade_case_id=$1 ORDER BY submitted_at DESC`, [tradeCaseId]),
    pool.query(`SELECT id, counterparty_id AS "counterpartyId", integration_connection_id AS "integrationConnectionId",
                  route_kind AS "routeKind", source_currency AS "sourceCurrency", target_currency AS "targetCurrency",
                  readiness_state AS "readinessState", configured_by AS "configuredBy", configured_at AS "configuredAt"
             FROM trade_case_routes WHERE trade_case_id=$1 ORDER BY configured_at DESC`, [tradeCaseId]),
    pool.query(`SELECT id, approval_role AS "approvalRole", decision, rationale, decided_by AS "decidedBy", decided_at AS "decidedAt"
             FROM trade_case_approvals WHERE trade_case_id=$1 ORDER BY decided_at DESC`, [tradeCaseId]),
    pool.query(`SELECT id, exception_kind AS "exceptionKind", status, rationale, raised_by AS "raisedBy",
                  raised_at AS "raisedAt", resolved_by AS "resolvedBy", resolved_at AS "resolvedAt"
             FROM trade_case_exceptions WHERE trade_case_id=$1 ORDER BY raised_at DESC`, [tradeCaseId]),
    pool.query(`SELECT id, reference_kind AS "referenceKind", reference_uri AS "referenceUri",
                  reference_sha256 AS "referenceSha256", status, reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt"
             FROM trade_case_reconciliations WHERE trade_case_id=$1 ORDER BY reviewed_at DESC`, [tradeCaseId]),
  ]);
  if (kase.rows.length === 0) throw new Error("trade case not found");
  return {
    tradeCase: kase.rows[0],
    stakeholders: stakeholders.rows,
    evidence: evidence.rows,
    routes: routes.rows,
    approvals: approvals.rows,
    exceptions: exceptions.rows,
    reconciliations: reconciliations.rows,
  };
}
