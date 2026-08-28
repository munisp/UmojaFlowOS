import { getPool, listPostgresActivityEventsForObjects, listPostgresCounterpartyAuthorizations, type Actor } from "./postgres";
import { listCounterpartyOnboardings } from "./counterpartyOnboarding";

export type PspArchetype = "bank_instant_rail" | "mobile_money" | "virtual_card_issuer" | "otc_cash_pickup" | "aggregator_psp";
export type PspEvidenceType =
  | "psp_licence"
  | "mobile_money_authorisation"
  | "aggregator_licence"
  | "sanctions_pep_attestation"
  | "aml_cft_policy"
  | "beneficial_ownership_disclosure"
  | "cutoff_settlement_calendar"
  | "fee_schedule_fx_margin"
  | "reconciliation_file_format_spec"
  | "dispute_recall_channel_sla"
  | "audited_financials"
  | "cyber_bcp_attestation";
export type PspGate = "licence_rail_coverage" | "settlement_cutoff_validation" | "bounded_live" | "failover_rail";

/**
 * OM §7.6 gate ownership is "Operations" throughout (paired with Compliance,
 * Treasury, or Country Lead). This platform has neither an Operations nor a
 * Country Lead role, so each gate is restricted to the closest existing
 * pairing rather than silently substituted -- disclosed in the workspace UI.
 */
const permittedGateRoles: Record<PspGate, Actor["role"][]> = {
  licence_rail_coverage: ["compliance_officer", "admin"],
  settlement_cutoff_validation: ["treasury_operator", "admin"],
  bounded_live: ["compliance_officer", "admin"],
  failover_rail: ["admin"],
};

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify(metadata)],
  );
}

/** OM §7.2: the five payout-PSP / mobile-money archetypes this platform can now record. */
export async function updateCounterpartyPspArchetype(actor: Actor, input: { counterpartyId: string; archetype: PspArchetype }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR UPDATE", [input.counterpartyId]);
    if (!current.rows[0]) throw new Error("counterparty record was not found");
    await client.query("UPDATE counterparties SET psp_archetype=$1::psp_archetype WHERE id=$2", [input.archetype, input.counterpartyId]);
    await recordActivity(client, actor, "counterparty.psp_archetype_updated", "counterparty", input.counterpartyId, { archetype: input.archetype });
    await client.query("COMMIT");
    return { id: input.counterpartyId, archetype: input.archetype };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** OM §7.4: one of the 12-item payout-PSP evidence pack. */
export async function recordPspEvidenceItem(actor: Actor, input: { counterpartyId: string; evidenceType: PspEvidenceType; evidenceUri: string; note?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("a canonical counterparty is required before recording evidence");
    const { rows } = await client.query<{ id: string; counterpartyId: string; evidenceType: PspEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
      `INSERT INTO psp_evidence_items (counterparty_id, evidence_type, evidence_uri, note, recorded_by)
       VALUES ($1,$2::psp_evidence_type,$3,$4,$5)
       RETURNING id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"`,
      [input.counterpartyId, input.evidenceType, input.evidenceUri, input.note ?? null, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("psp evidence item insert did not return a record");
    await recordActivity(client, actor, "counterparty.psp_evidence_item_recorded", "counterparty", input.counterpartyId, { evidenceType: input.evidenceType });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listPspEvidenceItems(counterpartyId: string) {
  const { rows } = await getPool().query<{ id: string; counterpartyId: string; evidenceType: PspEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
    `SELECT id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
       FROM psp_evidence_items WHERE counterparty_id=$1 ORDER BY recorded_at DESC`,
    [counterpartyId],
  );
  return rows;
}

/**
 * OM §7.6 gate decision -- one of the four PSP-specific gates (licence+rail
 * coverage, settlement+cutoff validation, bounded-live, failover rail), none
 * of which map onto the shared legal/technical/pilot lifecycle. Independent
 * of counterparty_onboarding_gate_decisions for the same reason the LP/Bank
 * dedicated gates are.
 */
export async function decidePspGate(actor: Actor, input: { onboardingId: string; gate: PspGate; decision: "approved" | "blocked"; rationale: string }) {
  if (!permittedGateRoles[input.gate].includes(actor.role)) throw new Error("this role cannot decide the selected payout-PSP gate");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const onboarding = await client.query<{ cycleNumber: number }>("SELECT cycle_number AS \"cycleNumber\" FROM counterparty_onboardings WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!onboarding.rows[0]) throw new Error("counterparty onboarding lifecycle was not found");
    const { rows } = await client.query<{ id: string; gate: PspGate; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>(
      `INSERT INTO psp_gate_decisions (onboarding_id, cycle_number, gate, decision, rationale, decided_by, decided_role)
       VALUES ($1,$2,$3::psp_gate,$4::counterparty_onboarding_decision,$5,$6,$7::operating_role)
       RETURNING id, gate, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"`,
      [input.onboardingId, onboarding.rows[0].cycleNumber, input.gate, input.decision, input.rationale, actor.openId, actor.role],
    );
    const record = rows[0];
    if (!record) throw new Error("psp gate decision insert did not return a record");
    await recordActivity(client, actor, "counterparty.psp_gate_decided", "counterparty_onboarding", input.onboardingId, { gate: input.gate, decision: input.decision, cycleNumber: onboarding.rows[0].cycleNumber });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listPspGateDecisions(onboardingId: string) {
  const { rows } = await getPool().query<{ id: string; gate: PspGate; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date; cycleNumber: number }>(
    `SELECT id, gate, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt", cycle_number AS "cycleNumber"
       FROM psp_gate_decisions WHERE onboarding_id=$1 ORDER BY decided_at DESC`,
    [onboardingId],
  );
  return rows;
}

export async function listPayoutPsps() {
  const { rows } = await getPool().query<{ id: string; legalName: string; jurisdiction: string; pspArchetype: PspArchetype | null; evidenceCount: string; createdAt: Date }>(
    `SELECT counterparty.id, counterparty.legal_name AS "legalName", counterparty.jurisdiction, counterparty.psp_archetype AS "pspArchetype",
            count(evidence.id)::text AS "evidenceCount",
            counterparty.created_at AS "createdAt"
       FROM counterparties counterparty
       LEFT JOIN psp_evidence_items evidence ON evidence.counterparty_id = counterparty.id
      WHERE counterparty.counterparty_type = 'licensed_psp'
      GROUP BY counterparty.id
      ORDER BY counterparty.created_at DESC`,
  );
  return rows;
}

/**
 * Composite read backing the Payout PSP workspace: identity + OM archetype,
 * the 12-item evidence pack, licence authorisations, the generic onboarding
 * lifecycle record (created like every counterparty, but not gated by it --
 * see decidePspGate), the four PSP-specific gate decisions, and the
 * reconstructed activity feed.
 */
export async function getPayoutPspWorkspace(counterpartyId: string) {
  const counterpartyResult = await getPool().query<{ id: string; legalName: string; counterpartyType: string; jurisdiction: string; pspArchetype: PspArchetype | null; createdAt: Date }>(
    `SELECT id, legal_name AS "legalName", counterparty_type AS "counterpartyType", jurisdiction, psp_archetype AS "pspArchetype", created_at AS "createdAt" FROM counterparties WHERE id=$1`,
    [counterpartyId],
  );
  const counterparty = counterpartyResult.rows[0];
  if (!counterparty) return undefined;

  const [evidenceItems, authorizations, onboardings] = await Promise.all([
    listPspEvidenceItems(counterpartyId),
    listPostgresCounterpartyAuthorizations().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
    listCounterpartyOnboardings().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
  ]);
  const onboarding = onboardings[0];

  const [gateDecisions, activity] = await Promise.all([
    onboarding ? listPspGateDecisions(onboarding.id) : Promise.resolve([]),
    listPostgresActivityEventsForObjects([counterpartyId, ...(onboarding ? [onboarding.id] : [])]),
  ]);

  return { counterparty, evidenceItems, authorizations, onboarding, gateDecisions, activity };
}
