import { getPool, listPostgresActivityEventsForObjects, listPostgresCounterpartyAuthorizations, type Actor } from "./postgres";
import { listCounterpartyOnboardings } from "./counterpartyOnboarding";

export type StablecoinIssuerArchetype = "regulated_issuer" | "open_issuer" | "network";
export type StablecoinIssuerEvidenceType =
  | "issuer_regulatory_licence"
  | "reserve_attestation"
  | "reserve_asset_composition"
  | "aml_cft_policy"
  | "sanctions_ofac_attestation"
  | "blockchain_finality_posture"
  | "custody_provider_licence_insurance"
  | "network_fee_schedule"
  | "principal_beneficial_ownership_kyb"
  | "audited_financials"
  | "smart_contract_audit";
export type StablecoinIssuerGate = "licence_reserve_posture" | "mint_redeem_technical_proof" | "chain_readiness" | "operating_posture";

/**
 * OM §8.6 gate ownership: G1/G4 Compliance+Treasury, G2 Treasury+Engineering,
 * G3 Engineering alone. Unlike Ch.6/7, every named owner maps onto a role
 * this platform actually has -- "Engineering" is restricted to admin, the
 * same convention already used for the generic technical-readiness gate.
 */
const permittedGateRoles: Record<StablecoinIssuerGate, Actor["role"][]> = {
  licence_reserve_posture: ["compliance_officer", "treasury_operator", "admin"],
  mint_redeem_technical_proof: ["treasury_operator", "admin"],
  chain_readiness: ["admin"],
  operating_posture: ["compliance_officer", "treasury_operator", "admin"],
};

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify(metadata)],
  );
}

/** OM §8.2: the three stablecoin-issuer/network archetypes this platform can now record. */
export async function updateCounterpartyStablecoinIssuerArchetype(actor: Actor, input: { counterpartyId: string; archetype: StablecoinIssuerArchetype }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR UPDATE", [input.counterpartyId]);
    if (!current.rows[0]) throw new Error("counterparty record was not found");
    await client.query("UPDATE counterparties SET stablecoin_issuer_archetype=$1::stablecoin_issuer_archetype WHERE id=$2", [input.archetype, input.counterpartyId]);
    await recordActivity(client, actor, "counterparty.stablecoin_issuer_archetype_updated", "counterparty", input.counterpartyId, { archetype: input.archetype });
    await client.query("COMMIT");
    return { id: input.counterpartyId, archetype: input.archetype };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** OM §8.4: one of the 11-item stablecoin-issuer evidence pack. */
export async function recordStablecoinIssuerEvidenceItem(actor: Actor, input: { counterpartyId: string; evidenceType: StablecoinIssuerEvidenceType; evidenceUri: string; note?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("a canonical counterparty is required before recording evidence");
    const { rows } = await client.query<{ id: string; counterpartyId: string; evidenceType: StablecoinIssuerEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
      `INSERT INTO stablecoin_issuer_evidence_items (counterparty_id, evidence_type, evidence_uri, note, recorded_by)
       VALUES ($1,$2::stablecoin_issuer_evidence_type,$3,$4,$5)
       RETURNING id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"`,
      [input.counterpartyId, input.evidenceType, input.evidenceUri, input.note ?? null, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("stablecoin issuer evidence item insert did not return a record");
    await recordActivity(client, actor, "counterparty.stablecoin_issuer_evidence_item_recorded", "counterparty", input.counterpartyId, { evidenceType: input.evidenceType });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listStablecoinIssuerEvidenceItems(counterpartyId: string) {
  const { rows } = await getPool().query<{ id: string; counterpartyId: string; evidenceType: StablecoinIssuerEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
    `SELECT id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
       FROM stablecoin_issuer_evidence_items WHERE counterparty_id=$1 ORDER BY recorded_at DESC`,
    [counterpartyId],
  );
  return rows;
}

/**
 * OM §8.6 gate decision -- one of the four issuer-specific gates, none of
 * which map onto the shared legal/technical/pilot lifecycle. Independent of
 * counterparty_onboarding_gate_decisions for the same reason the payout-PSP
 * dedicated gates are.
 */
export async function decideStablecoinIssuerGate(actor: Actor, input: { onboardingId: string; gate: StablecoinIssuerGate; decision: "approved" | "blocked"; rationale: string }) {
  if (!permittedGateRoles[input.gate].includes(actor.role)) throw new Error("this role cannot decide the selected stablecoin-issuer gate");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const onboarding = await client.query<{ cycleNumber: number }>("SELECT cycle_number AS \"cycleNumber\" FROM counterparty_onboardings WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!onboarding.rows[0]) throw new Error("counterparty onboarding lifecycle was not found");
    const { rows } = await client.query<{ id: string; gate: StablecoinIssuerGate; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>(
      `INSERT INTO stablecoin_issuer_gate_decisions (onboarding_id, cycle_number, gate, decision, rationale, decided_by, decided_role)
       VALUES ($1,$2,$3::stablecoin_issuer_gate,$4::counterparty_onboarding_decision,$5,$6,$7::operating_role)
       RETURNING id, gate, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"`,
      [input.onboardingId, onboarding.rows[0].cycleNumber, input.gate, input.decision, input.rationale, actor.openId, actor.role],
    );
    const record = rows[0];
    if (!record) throw new Error("stablecoin issuer gate decision insert did not return a record");
    await recordActivity(client, actor, "counterparty.stablecoin_issuer_gate_decided", "counterparty_onboarding", input.onboardingId, { gate: input.gate, decision: input.decision, cycleNumber: onboarding.rows[0].cycleNumber });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listStablecoinIssuerGateDecisions(onboardingId: string) {
  const { rows } = await getPool().query<{ id: string; gate: StablecoinIssuerGate; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date; cycleNumber: number }>(
    `SELECT id, gate, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt", cycle_number AS "cycleNumber"
       FROM stablecoin_issuer_gate_decisions WHERE onboarding_id=$1 ORDER BY decided_at DESC`,
    [onboardingId],
  );
  return rows;
}

export async function listStablecoinIssuers() {
  const { rows } = await getPool().query<{ id: string; legalName: string; jurisdiction: string; stablecoinIssuerArchetype: StablecoinIssuerArchetype | null; evidenceCount: string; createdAt: Date }>(
    `SELECT counterparty.id, counterparty.legal_name AS "legalName", counterparty.jurisdiction, counterparty.stablecoin_issuer_archetype AS "stablecoinIssuerArchetype",
            count(evidence.id)::text AS "evidenceCount",
            counterparty.created_at AS "createdAt"
       FROM counterparties counterparty
       LEFT JOIN stablecoin_issuer_evidence_items evidence ON evidence.counterparty_id = counterparty.id
      WHERE counterparty.counterparty_type = 'stablecoin_provider'
      GROUP BY counterparty.id
      ORDER BY counterparty.created_at DESC`,
  );
  return rows;
}

/**
 * Composite read backing the Stablecoin Issuer workspace: identity + OM
 * archetype, the 11-item evidence pack, licence authorisations, the generic
 * onboarding lifecycle record (created like every counterparty, but not
 * gated by it), the four issuer-specific gate decisions, and the
 * reconstructed activity feed.
 */
export async function getStablecoinIssuerWorkspace(counterpartyId: string) {
  const counterpartyResult = await getPool().query<{ id: string; legalName: string; counterpartyType: string; jurisdiction: string; stablecoinIssuerArchetype: StablecoinIssuerArchetype | null; createdAt: Date }>(
    `SELECT id, legal_name AS "legalName", counterparty_type AS "counterpartyType", jurisdiction, stablecoin_issuer_archetype AS "stablecoinIssuerArchetype", created_at AS "createdAt" FROM counterparties WHERE id=$1`,
    [counterpartyId],
  );
  const counterparty = counterpartyResult.rows[0];
  if (!counterparty) return undefined;

  const [evidenceItems, authorizations, onboardings] = await Promise.all([
    listStablecoinIssuerEvidenceItems(counterpartyId),
    listPostgresCounterpartyAuthorizations().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
    listCounterpartyOnboardings().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
  ]);
  const onboarding = onboardings[0];

  const [gateDecisions, activity] = await Promise.all([
    onboarding ? listStablecoinIssuerGateDecisions(onboarding.id) : Promise.resolve([]),
    listPostgresActivityEventsForObjects([counterpartyId, ...(onboarding ? [onboarding.id] : [])]),
  ]);

  return { counterparty, evidenceItems, authorizations, onboarding, gateDecisions, activity };
}
