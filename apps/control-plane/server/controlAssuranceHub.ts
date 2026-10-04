import { getPool, type Actor } from "./postgres";

/**
 * Control Assurance Hub persistence (migration 0034).
 *
 * Previously orphaned schema. Provider-independent assurance facts, adapter
 * certification evidence and generated audit-packet references. All three
 * tables are append-only at the database level (trigger
 * prohibit_control_assurance_mutation), so this module exposes only INSERT
 * and SELECT paths. Nothing here activates, instructs, funds, transfers,
 * issues, settles, submits, or represents external authority — the schema
 * enforces external_execution_initiated = FALSE.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;
const HTTPS_RE = /^https:\/\//;

export const ASSURANCE_KINDS = [
  "control_coverage", "separation_of_duties", "evidence_freshness",
  "counterparty_route_readiness", "reconciliation_completeness",
  "stablecoin_policy_coverage", "adapter_certification",
] as const;

export const ADAPTER_KINDS = [
  "bank_treasury", "stablecoin_execution", "trade_finance",
  "spend_card", "payment_network", "reconciliation",
] as const;

export const PACKET_SCOPES = [
  "trade_case", "enterprise_module", "counterparty_adapter", "corridor", "stablecoin_treasury",
] as const;

function assertEvidencePointer(uri: string, sha256: string) {
  if (!HTTPS_RE.test(uri)) throw new Error("evidence_uri must be an https:// URI");
  if (!SHA256_RE.test(sha256)) throw new Error("evidence_sha256 must be 64 lowercase hex chars");
}

export async function recordControlAssuranceAssessment(actor: Actor, input: {
  assessmentKind: (typeof ASSURANCE_KINDS)[number];
  subjectType: string;
  subjectId: string;
  outcome: "covered" | "attention_required" | "blocked" | "unavailable";
  findingCodes: string[];
  evidenceUri: string;
  evidenceSha256: string;
}) {
  assertEvidencePointer(input.evidenceUri, input.evidenceSha256);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO control_assurance_assessments
       (assessment_kind, subject_type, subject_id, outcome, finding_codes,
        evidence_uri, evidence_sha256, assessed_by, assessed_role)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING id`,
    [
      input.assessmentKind, input.subjectType, input.subjectId, input.outcome,
      JSON.stringify(input.findingCodes), input.evidenceUri, input.evidenceSha256,
      actor.openId, actor.role,
    ],
  );
  return { id: rows[0].id };
}

export async function recordAdapterCertificationEvidence(actor: Actor, input: {
  counterpartyId: string;
  integrationConnectionId?: string | null;
  adapterKind: (typeof ADAPTER_KINDS)[number];
  certificationState: "documented" | "evidence_pending" | "ready_for_controlled_test" | "blocked" | "retired";
  corridor?: string | null;
  asset?: "USDC" | "USDT" | "NGN" | "KES" | "ZAR" | "USD" | null;
  evidenceUri: string;
  evidenceSha256: string;
  controlledTestReference?: string | null;
}) {
  assertEvidencePointer(input.evidenceUri, input.evidenceSha256);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO adapter_certification_evidence
       (counterparty_id, integration_connection_id, adapter_kind, certification_state, corridor, asset,
        evidence_uri, evidence_sha256, controlled_test_reference, certified_by, certified_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      input.counterpartyId, input.integrationConnectionId ?? null, input.adapterKind, input.certificationState,
      input.corridor ?? null, input.asset ?? null, input.evidenceUri, input.evidenceSha256,
      input.controlledTestReference ?? null, actor.openId, actor.role,
    ],
  );
  return { id: rows[0].id };
}

export async function recordControlAuditPacket(actor: Actor, input: {
  packetScope: (typeof PACKET_SCOPES)[number];
  scopeReference: string;
  packetUri: string;
  packetSha256: string;
  evidenceCount: number;
}) {
  assertEvidencePointer(input.packetUri, input.packetSha256);
  if (!Number.isInteger(input.evidenceCount) || input.evidenceCount < 0) throw new Error("evidence_count must be a non-negative integer");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO control_audit_packets
       (packet_scope, scope_reference, packet_uri, packet_sha256, evidence_count, generated_by, generated_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.packetScope, input.scopeReference, input.packetUri, input.packetSha256, input.evidenceCount, actor.openId, actor.role],
  );
  return { id: rows[0].id };
}

export async function listControlAssuranceAssessments(subjectType?: string, subjectId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, assessment_kind AS "assessmentKind", subject_type AS "subjectType", subject_id AS "subjectId",
            outcome, finding_codes AS "findingCodes", evidence_uri AS "evidenceUri",
            assessed_by AS "assessedBy", assessed_role AS "assessedRole", created_at AS "createdAt"
       FROM control_assurance_assessments
      ${subjectType ? "WHERE subject_type=$1" : ""} ${subjectType && subjectId ? "AND subject_id=$2" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    subjectType ? (subjectId ? [subjectType, subjectId] : [subjectType]) : [],
  );
  return rows;
}

export async function listAdapterCertificationEvidence(counterpartyId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, counterparty_id AS "counterpartyId", integration_connection_id AS "integrationConnectionId",
            adapter_kind AS "adapterKind", certification_state AS "certificationState", corridor, asset,
            evidence_uri AS "evidenceUri", controlled_test_reference AS "controlledTestReference",
            certified_by AS "certifiedBy", certified_role AS "certifiedRole", created_at AS "createdAt"
       FROM adapter_certification_evidence
      ${counterpartyId ? "WHERE counterparty_id=$1" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    counterpartyId ? [counterpartyId] : [],
  );
  return rows;
}

export async function listControlAuditPackets(packetScope?: string, scopeReference?: string) {
  const { rows } = await getPool().query(
    `SELECT id, packet_scope AS "packetScope", scope_reference AS "scopeReference", packet_uri AS "packetUri",
            packet_sha256 AS "packetSha256", evidence_count AS "evidenceCount",
            generated_by AS "generatedBy", generated_role AS "generatedRole", created_at AS "createdAt"
       FROM control_audit_packets
      ${packetScope ? "WHERE packet_scope=$1" : ""} ${packetScope && scopeReference ? "AND scope_reference=$2" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    packetScope ? (scopeReference ? [packetScope, scopeReference] : [packetScope]) : [],
  );
  return rows;
}
