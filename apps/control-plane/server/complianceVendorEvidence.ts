import { getPool, listPostgresActivityEventsForObjects, listPostgresCounterpartyAuthorizations, type Actor } from "./postgres";
import { listCounterpartyOnboardings } from "./counterpartyOnboarding";

export type ComplianceVendorArchetype = "kyc_kyb_platform" | "sanctions_screening" | "chain_analytics" | "travel_rule_vendor" | "adverse_media";
export type ComplianceVendorEvidenceType =
  | "soc2_or_iso27001_report"
  | "information_security_policy"
  | "privacy_policy_dpa_template"
  | "penetration_test_summary"
  | "insurance_certificate"
  | "beneficial_ownership_disclosure"
  | "vendor_sanctions_compliance_posture"
  | "list_data_sourcing_summary"
  | "sub_processor_list"
  | "sla_template_uptime_commitment";
export type ComplianceVendorGate = "security_posture" | "coverage_feasibility" | "false_positive_ceiling" | "annual_review";

/**
 * OM §9.6 gate ownership: G1 Compliance+Eng Sec, G2 Compliance, G3
 * Compliance+Operations, G4 Compliance. Neither "Eng Sec" nor "Operations"
 * is a role this platform has, so every gate restricts to compliance/admin
 * -- the closest match, disclosed per-gate in the UI.
 */
const permittedGateRoles: Record<ComplianceVendorGate, Actor["role"][]> = {
  security_posture: ["compliance_officer", "admin"],
  coverage_feasibility: ["compliance_officer", "admin"],
  false_positive_ceiling: ["compliance_officer", "admin"],
  annual_review: ["compliance_officer", "admin"],
};

/**
 * OM §9.2 names five archetypes, but the counterparty_type check constraint
 * only had a matching value for three of them until this chapter's
 * migration added travel_rule_provider and adverse_media_provider. The
 * vendor pool this workspace lists spans all five types at once, unlike
 * every prior chapter's single-type filter.
 */
const vendorCounterpartyTypes = ["kyc_provider", "sanctions_provider", "chain_analytics_provider", "travel_rule_provider", "adverse_media_provider"] as const;

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify(metadata)],
  );
}

/** OM §9.2: the five compliance/risk-vendor archetypes this platform can now record. */
export async function updateCounterpartyComplianceVendorArchetype(actor: Actor, input: { counterpartyId: string; archetype: ComplianceVendorArchetype }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR UPDATE", [input.counterpartyId]);
    if (!current.rows[0]) throw new Error("counterparty record was not found");
    await client.query("UPDATE counterparties SET compliance_vendor_archetype=$1::compliance_vendor_archetype WHERE id=$2", [input.archetype, input.counterpartyId]);
    await recordActivity(client, actor, "counterparty.compliance_vendor_archetype_updated", "counterparty", input.counterpartyId, { archetype: input.archetype });
    await client.query("COMMIT");
    return { id: input.counterpartyId, archetype: input.archetype };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** OM §9.4: one of the 10-item compliance-vendor evidence pack. */
export async function recordComplianceVendorEvidenceItem(actor: Actor, input: { counterpartyId: string; evidenceType: ComplianceVendorEvidenceType; evidenceUri: string; note?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("a canonical counterparty is required before recording evidence");
    const { rows } = await client.query<{ id: string; counterpartyId: string; evidenceType: ComplianceVendorEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
      `INSERT INTO compliance_vendor_evidence_items (counterparty_id, evidence_type, evidence_uri, note, recorded_by)
       VALUES ($1,$2::compliance_vendor_evidence_type,$3,$4,$5)
       RETURNING id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"`,
      [input.counterpartyId, input.evidenceType, input.evidenceUri, input.note ?? null, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("compliance vendor evidence item insert did not return a record");
    await recordActivity(client, actor, "counterparty.compliance_vendor_evidence_item_recorded", "counterparty", input.counterpartyId, { evidenceType: input.evidenceType });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listComplianceVendorEvidenceItems(counterpartyId: string) {
  const { rows } = await getPool().query<{ id: string; counterpartyId: string; evidenceType: ComplianceVendorEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
    `SELECT id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
       FROM compliance_vendor_evidence_items WHERE counterparty_id=$1 ORDER BY recorded_at DESC`,
    [counterpartyId],
  );
  return rows;
}

/**
 * OM §9.6 gate decision -- one of the four vendor-specific gates, none of
 * which map onto the shared legal/technical/pilot lifecycle. Independent of
 * counterparty_onboarding_gate_decisions for the same reason the payout-PSP
 * and stablecoin-issuer dedicated gates are.
 */
export async function decideComplianceVendorGate(actor: Actor, input: { onboardingId: string; gate: ComplianceVendorGate; decision: "approved" | "blocked"; rationale: string }) {
  if (!permittedGateRoles[input.gate].includes(actor.role)) throw new Error("this role cannot decide the selected compliance-vendor gate");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const onboarding = await client.query<{ cycleNumber: number }>("SELECT cycle_number AS \"cycleNumber\" FROM counterparty_onboardings WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!onboarding.rows[0]) throw new Error("counterparty onboarding lifecycle was not found");
    const { rows } = await client.query<{ id: string; gate: ComplianceVendorGate; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>(
      `INSERT INTO compliance_vendor_gate_decisions (onboarding_id, cycle_number, gate, decision, rationale, decided_by, decided_role)
       VALUES ($1,$2,$3::compliance_vendor_gate,$4::counterparty_onboarding_decision,$5,$6,$7::operating_role)
       RETURNING id, gate, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"`,
      [input.onboardingId, onboarding.rows[0].cycleNumber, input.gate, input.decision, input.rationale, actor.openId, actor.role],
    );
    const record = rows[0];
    if (!record) throw new Error("compliance vendor gate decision insert did not return a record");
    await recordActivity(client, actor, "counterparty.compliance_vendor_gate_decided", "counterparty_onboarding", input.onboardingId, { gate: input.gate, decision: input.decision, cycleNumber: onboarding.rows[0].cycleNumber });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listComplianceVendorGateDecisions(onboardingId: string) {
  const { rows } = await getPool().query<{ id: string; gate: ComplianceVendorGate; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date; cycleNumber: number }>(
    `SELECT id, gate, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt", cycle_number AS "cycleNumber"
       FROM compliance_vendor_gate_decisions WHERE onboarding_id=$1 ORDER BY decided_at DESC`,
    [onboardingId],
  );
  return rows;
}

export async function listComplianceVendors() {
  const { rows } = await getPool().query<{ id: string; legalName: string; jurisdiction: string; counterpartyType: string; complianceVendorArchetype: ComplianceVendorArchetype | null; evidenceCount: string; createdAt: Date }>(
    `SELECT counterparty.id, counterparty.legal_name AS "legalName", counterparty.jurisdiction, counterparty.counterparty_type AS "counterpartyType", counterparty.compliance_vendor_archetype AS "complianceVendorArchetype",
            count(evidence.id)::text AS "evidenceCount",
            counterparty.created_at AS "createdAt"
       FROM counterparties counterparty
       LEFT JOIN compliance_vendor_evidence_items evidence ON evidence.counterparty_id = counterparty.id
      WHERE counterparty.counterparty_type = ANY($1::text[])
      GROUP BY counterparty.id
      ORDER BY counterparty.created_at DESC`,
    [vendorCounterpartyTypes],
  );
  return rows;
}

/**
 * Composite read backing the Compliance Vendor workspace: identity + OM
 * archetype, the 10-item evidence pack, licence authorisations, the generic
 * onboarding lifecycle record (created like every counterparty, but not
 * gated by it), the four vendor-specific gate decisions, and the
 * reconstructed activity feed.
 */
export async function getComplianceVendorWorkspace(counterpartyId: string) {
  const counterpartyResult = await getPool().query<{ id: string; legalName: string; counterpartyType: string; jurisdiction: string; complianceVendorArchetype: ComplianceVendorArchetype | null; createdAt: Date }>(
    `SELECT id, legal_name AS "legalName", counterparty_type AS "counterpartyType", jurisdiction, compliance_vendor_archetype AS "complianceVendorArchetype", created_at AS "createdAt" FROM counterparties WHERE id=$1`,
    [counterpartyId],
  );
  const counterparty = counterpartyResult.rows[0];
  if (!counterparty) return undefined;

  const [evidenceItems, authorizations, onboardings] = await Promise.all([
    listComplianceVendorEvidenceItems(counterpartyId),
    listPostgresCounterpartyAuthorizations().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
    listCounterpartyOnboardings().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
  ]);
  const onboarding = onboardings[0];

  const [gateDecisions, activity] = await Promise.all([
    onboarding ? listComplianceVendorGateDecisions(onboarding.id) : Promise.resolve([]),
    listPostgresActivityEventsForObjects([counterpartyId, ...(onboarding ? [onboarding.id] : [])]),
  ]);

  return { counterparty, evidenceItems, authorizations, onboarding, gateDecisions, activity };
}
