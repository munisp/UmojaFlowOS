import { getPool, type Actor } from "./postgres";

/**
 * Enterprise governance module persistence (migration 0033).
 *
 * Previously orphaned schema — multi-bank treasury, stablecoin treasury,
 * supply-chain finance and spend-card programme records had no write/read
 * path. This module persists governance facts and evidence pointers only;
 * every surface keeps the schema-level guarantees that no card is issued, no
 * credit decision is made, no funding/disbursal/custody operation is
 * initiated, and no external execution is asserted by recording governance.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;
const HTTPS_RE = /^https:\/\//;

function assertEvidencePointer(uri: string, sha256: string, label = "evidence") {
  if (!HTTPS_RE.test(uri)) throw new Error(`${label}_uri must be an https:// URI`);
  if (!SHA256_RE.test(sha256)) throw new Error(`${label}_sha256 must be 64 lowercase hex chars`);
}

export type GovernanceModuleKind = "multi_bank_treasury" | "stablecoin_treasury" | "supply_chain_finance" | "spend_card_programme";

// ------------------------------------------------------- governed accounts

export async function registerGovernedBankAccount(actor: Actor, input: {
  legalEntityId: string;
  counterpartyId: string;
  integrationConnectionId: string;
  countryCode: string;
  currency: string;
  accountReferenceHash: string;
  mandateEvidenceUri: string;
  mandateEvidenceSha256: string;
}) {
  assertEvidencePointer(input.mandateEvidenceUri, input.mandateEvidenceSha256, "mandate_evidence");
  if (!SHA256_RE.test(input.accountReferenceHash)) throw new Error("account_reference_hash must be 64 lowercase hex chars");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO governed_bank_accounts
       (legal_entity_id, counterparty_id, integration_connection_id, country_code, currency,
        account_reference_hash, mandate_evidence_uri, mandate_evidence_sha256, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.legalEntityId, input.counterpartyId, input.integrationConnectionId, input.countryCode,
      input.currency, input.accountReferenceHash, input.mandateEvidenceUri, input.mandateEvidenceSha256, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

// ------------------------------------------------------------- policies

export async function recordLiquidityGovernancePolicy(actor: Actor, input: {
  legalEntityId: string;
  countryCode: string;
  currency: string;
  concentrationLimitPercent: number;
  approvalThresholdAmount: string;
  policyEvidenceUri: string;
  policyEvidenceSha256: string;
}) {
  assertEvidencePointer(input.policyEvidenceUri, input.policyEvidenceSha256, "policy_evidence");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO liquidity_governance_policies
       (legal_entity_id, country_code, currency, concentration_limit_percent, approval_threshold_amount,
        policy_evidence_uri, policy_evidence_sha256, recorded_by)
     VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8) RETURNING id`,
    [
      input.legalEntityId, input.countryCode, input.currency, input.concentrationLimitPercent,
      input.approvalThresholdAmount, input.policyEvidenceUri, input.policyEvidenceSha256, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

// ------------------------------------------------- stablecoin treasury mandates

export async function recordStablecoinTreasuryMandate(actor: Actor, input: {
  legalEntityId: string;
  asset: "USDC" | "USDT";
  counterpartyId: string;
  integrationConnectionId: string;
  maximumExposure: string;
  requiresTravelRule: boolean;
  requiresBeneficiaryEvidence: boolean;
  mandateEvidenceUri: string;
  mandateEvidenceSha256: string;
}) {
  assertEvidencePointer(input.mandateEvidenceUri, input.mandateEvidenceSha256, "mandate_evidence");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stablecoin_treasury_mandates
       (legal_entity_id, asset, counterparty_id, integration_connection_id, maximum_exposure,
        requires_travel_rule, requires_beneficiary_evidence, mandate_evidence_uri, mandate_evidence_sha256,
        recorded_by)
     VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.legalEntityId, input.asset, input.counterpartyId, input.integrationConnectionId, input.maximumExposure,
      input.requiresTravelRule, input.requiresBeneficiaryEvidence, input.mandateEvidenceUri,
      input.mandateEvidenceSha256, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

// -------------------------------------------------- supply-chain finance

export async function registerSupplyChainFinanceProgramme(actor: Actor, input: {
  legalEntityId: string;
  funderCounterpartyId: string;
  integrationConnectionId: string;
  supplierBeneficiaryId: string;
  programmeReference: string;
  receivableEvidenceUri: string;
  receivableEvidenceSha256: string;
  programmePolicyUri: string;
  programmePolicySha256: string;
}) {
  assertEvidencePointer(input.receivableEvidenceUri, input.receivableEvidenceSha256, "receivable_evidence");
  assertEvidencePointer(input.programmePolicyUri, input.programmePolicySha256, "programme_policy");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO supply_chain_finance_programmes
       (legal_entity_id, funder_counterparty_id, integration_connection_id, supplier_beneficiary_id,
        programme_reference, receivable_evidence_uri, receivable_evidence_sha256,
        programme_policy_uri, programme_policy_sha256, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.legalEntityId, input.funderCounterpartyId, input.integrationConnectionId, input.supplierBeneficiaryId,
      input.programmeReference, input.receivableEvidenceUri, input.receivableEvidenceSha256,
      input.programmePolicyUri, input.programmePolicySha256, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

// ------------------------------------------------------------ spend cards

export async function registerSpendCardProgramme(actor: Actor, input: {
  legalEntityId: string;
  counterpartyId: string;
  integrationConnectionId: string;
  programmeReference: string;
  countryCode: string;
  currency: string;
  programmeEvidenceUri: string;
  programmeEvidenceSha256: string;
}) {
  assertEvidencePointer(input.programmeEvidenceUri, input.programmeEvidenceSha256, "programme_evidence");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO spend_card_programmes
       (legal_entity_id, counterparty_id, integration_connection_id, programme_reference,
        country_code, currency, programme_evidence_uri, programme_evidence_sha256, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.legalEntityId, input.counterpartyId, input.integrationConnectionId, input.programmeReference,
      input.countryCode, input.currency, input.programmeEvidenceUri, input.programmeEvidenceSha256, actor.openId,
    ],
  );
  return { id: rows[0].id };
}

export async function recordSpendPolicyRule(actor: Actor, input: {
  spendCardProgrammeId: string;
  ruleKind: "category" | "per_transaction_limit" | "period_limit" | "employee_eligibility" | "receipt_requirement";
  ruleValue: Record<string, unknown>;
  evidenceUri: string;
  evidenceSha256: string;
}) {
  assertEvidencePointer(input.evidenceUri, input.evidenceSha256);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO spend_policy_rules
       (spend_card_programme_id, rule_kind, rule_value, evidence_uri, evidence_sha256, recorded_by)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6)
     ON CONFLICT (spend_card_programme_id, rule_kind, evidence_sha256) DO NOTHING
     RETURNING id`,
    [input.spendCardProgrammeId, input.ruleKind, JSON.stringify(input.ruleValue), input.evidenceUri, input.evidenceSha256, actor.openId],
  );
  return { id: rows[0]?.id ?? null };
}

// --------------------------------------------------------------- reviews

export async function recordEnterpriseGovernanceReview(actor: Actor, input: {
  moduleKind: GovernanceModuleKind;
  subjectId: string;
  decision: "approved" | "blocked" | "needs_information";
  rationale: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO enterprise_governance_reviews (module_kind, subject_id, decision, rationale, decided_by, decided_role)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.moduleKind, input.subjectId, input.decision, input.rationale, actor.openId, actor.role],
  );
  return { id: rows[0].id };
}

// ------------------------------------------------------------------ reads

export async function getEnterpriseGovernanceWorkspace(legalEntityId: string) {
  const pool = getPool();
  const [accounts, policies, mandates, scf, cards, reviews] = await Promise.all([
    pool.query(`SELECT id, counterparty_id AS "counterpartyId", integration_connection_id AS "integrationConnectionId",
                  country_code AS "countryCode", currency, account_reference_hash AS "accountReferenceHash",
                  status, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
             FROM governed_bank_accounts WHERE legal_entity_id=$1 ORDER BY recorded_at DESC`, [legalEntityId]),
    pool.query(`SELECT id, country_code AS "countryCode", currency, concentration_limit_percent AS "concentrationLimitPercent",
                  approval_threshold_amount AS "approvalThresholdAmount", status, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
             FROM liquidity_governance_policies WHERE legal_entity_id=$1 ORDER BY recorded_at DESC`, [legalEntityId]),
    pool.query(`SELECT id, asset, counterparty_id AS "counterpartyId", maximum_exposure AS "maximumExposure",
                  requires_travel_rule AS "requiresTravelRule", requires_beneficiary_evidence AS "requiresBeneficiaryEvidence",
                  status, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
             FROM stablecoin_treasury_mandates WHERE legal_entity_id=$1 ORDER BY recorded_at DESC`, [legalEntityId]),
    pool.query(`SELECT id, funder_counterparty_id AS "funderCounterpartyId", supplier_beneficiary_id AS "supplierBeneficiaryId",
                  programme_reference AS "programmeReference", status, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
             FROM supply_chain_finance_programmes WHERE legal_entity_id=$1 ORDER BY recorded_at DESC`, [legalEntityId]),
    pool.query(`SELECT id, counterparty_id AS "counterpartyId", programme_reference AS "programmeReference",
                  country_code AS "countryCode", currency, status, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
             FROM spend_card_programmes WHERE legal_entity_id=$1 ORDER BY recorded_at DESC`, [legalEntityId]),
    pool.query(`SELECT id, module_kind AS "moduleKind", subject_id AS "subjectId", decision, rationale,
                  decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"
             FROM enterprise_governance_reviews ORDER BY decided_at DESC LIMIT 200`, []),
  ]);
  return {
    governedBankAccounts: accounts.rows,
    liquidityGovernancePolicies: policies.rows,
    stablecoinTreasuryMandates: mandates.rows,
    supplyChainFinanceProgrammes: scf.rows,
    spendCardProgrammes: cards.rows,
    governanceReviews: reviews.rows,
  };
}

export async function listSpendPolicyRules(spendCardProgrammeId: string) {
  const { rows } = await getPool().query(
    `SELECT id, rule_kind AS "ruleKind", rule_value AS "ruleValue", evidence_uri AS "evidenceUri",
            evidence_sha256 AS "evidenceSha256", recorded_by AS "recordedBy", recorded_at AS "recordedAt"
       FROM spend_policy_rules WHERE spend_card_programme_id=$1 ORDER BY recorded_at DESC`,
    [spendCardProgrammeId],
  );
  return rows;
}
