import { getPool, listPostgresActivityEventsForObjects, listPostgresCounterpartyAuthorizations, type Actor } from "./postgres";
import { listCounterpartyOnboardings } from "./counterpartyOnboarding";

export type LpArchetype = "principal_market_maker" | "regional_liquidity_desk" | "stablecoin_fiat_conversion_desk" | "otc_counterparty";
export type LpEvidenceType =
  | "mm_otc_licence"
  | "incountry_vasp_licence"
  | "beneficial_ownership_disclosure"
  | "sanctions_pep_attestation"
  | "audited_financials"
  | "aml_cft_policy"
  | "travel_rule_policy"
  | "mlro_appointment_letter"
  | "market_microstructure_policy"
  | "reference_list"
  | "insurance_certificate"
  | "regulatory_disciplinary_history";

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, "counterparty", objectId, JSON.stringify(metadata)],
  );
}

/** OM §5.2: the four liquidity-provider archetypes this platform can now record. */
export async function updateCounterpartyLpArchetype(actor: Actor, input: { counterpartyId: string; archetype: LpArchetype }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR UPDATE", [input.counterpartyId]);
    if (!current.rows[0]) throw new Error("counterparty record was not found");
    await client.query("UPDATE counterparties SET lp_archetype=$1::lp_archetype WHERE id=$2", [input.archetype, input.counterpartyId]);
    await recordActivity(client, actor, "counterparty.lp_archetype_updated", input.counterpartyId, { archetype: input.archetype });
    await client.query("COMMIT");
    return { id: input.counterpartyId, archetype: input.archetype };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** OM §5.4: one of the 12-item liquidity-provider evidence pack. */
export async function recordCounterpartyEvidenceItem(actor: Actor, input: { counterpartyId: string; evidenceType: LpEvidenceType; evidenceUri: string; note?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("a canonical counterparty is required before recording evidence");
    const { rows } = await client.query<{ id: string; counterpartyId: string; evidenceType: LpEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
      `INSERT INTO counterparty_evidence_items (counterparty_id, evidence_type, evidence_uri, note, recorded_by)
       VALUES ($1,$2::lp_evidence_type,$3,$4,$5)
       RETURNING id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"`,
      [input.counterpartyId, input.evidenceType, input.evidenceUri, input.note ?? null, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("counterparty evidence item insert did not return a record");
    await recordActivity(client, actor, "counterparty.evidence_item_recorded", input.counterpartyId, { evidenceType: input.evidenceType });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listCounterpartyEvidenceItems(counterpartyId: string) {
  const { rows } = await getPool().query<{ id: string; counterpartyId: string; evidenceType: LpEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
    `SELECT id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
       FROM counterparty_evidence_items WHERE counterparty_id=$1 ORDER BY recorded_at DESC`,
    [counterpartyId],
  );
  return rows;
}

/**
 * OM §5.6 Gate G2 — financial soundness, owned by Treasury+Finance. This
 * platform has no distinct Finance role, so it is restricted to
 * treasury_operator/admin — a known gap against the OM, not a substitution.
 * Kept independent of the generic legal/technical/pilot gate model: it does
 * not block or advance counterparty_onboardings.stage, since that model is
 * shared by every other counterparty type and changing its transition rules
 * is out of scope here.
 */
export async function decideFinancialSoundnessGate(actor: Actor, input: { onboardingId: string; decision: "approved" | "blocked"; rationale: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const onboarding = await client.query<{ cycleNumber: number }>("SELECT cycle_number AS \"cycleNumber\" FROM counterparty_onboardings WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!onboarding.rows[0]) throw new Error("counterparty onboarding lifecycle was not found");
    const { rows } = await client.query<{ id: string; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>(
      `INSERT INTO counterparty_financial_soundness_decisions (onboarding_id, cycle_number, decision, rationale, decided_by, decided_role)
       VALUES ($1,$2,$3::counterparty_onboarding_decision,$4,$5,$6::operating_role)
       RETURNING id, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"`,
      [input.onboardingId, onboarding.rows[0].cycleNumber, input.decision, input.rationale, actor.openId, actor.role],
    );
    const record = rows[0];
    if (!record) throw new Error("financial soundness decision insert did not return a record");
    await recordActivity(client, actor, "counterparty.financial_soundness_gate_decided", input.onboardingId, { decision: input.decision, cycleNumber: onboarding.rows[0].cycleNumber });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listFinancialSoundnessDecisions(onboardingId: string) {
  const { rows } = await getPool().query<{ id: string; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date; cycleNumber: number }>(
    `SELECT id, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt", cycle_number AS "cycleNumber"
       FROM counterparty_financial_soundness_decisions WHERE onboarding_id=$1 ORDER BY decided_at DESC`,
    [onboardingId],
  );
  return rows;
}

export async function listLiquidityProviders() {
  const { rows } = await getPool().query<{ id: string; legalName: string; jurisdiction: string; lpArchetype: LpArchetype | null; evidenceCount: string; createdAt: Date }>(
    `SELECT counterparty.id, counterparty.legal_name AS "legalName", counterparty.jurisdiction, counterparty.lp_archetype AS "lpArchetype",
            count(evidence.id)::text AS "evidenceCount",
            counterparty.created_at AS "createdAt"
       FROM counterparties counterparty
       LEFT JOIN counterparty_evidence_items evidence ON evidence.counterparty_id = counterparty.id
      WHERE counterparty.counterparty_type = 'fx_liquidity_provider'
      GROUP BY counterparty.id
      ORDER BY counterparty.created_at DESC`,
  );
  return rows;
}

/**
 * Composite read backing the Liquidity Provider workspace: identity + OM
 * archetype, the 12-item evidence pack, licence authorisations, the generic
 * onboarding lifecycle (legal/technical/pilot gates, reused as-is), the
 * LP-specific financial-soundness gate, and the reconstructed activity feed.
 */
export async function getLiquidityProviderWorkspace(counterpartyId: string) {
  const counterpartyResult = await getPool().query<{ id: string; legalName: string; counterpartyType: string; jurisdiction: string; lpArchetype: LpArchetype | null; createdAt: Date }>(
    `SELECT id, legal_name AS "legalName", counterparty_type AS "counterpartyType", jurisdiction, lp_archetype AS "lpArchetype", created_at AS "createdAt" FROM counterparties WHERE id=$1`,
    [counterpartyId],
  );
  const counterparty = counterpartyResult.rows[0];
  if (!counterparty) return undefined;

  const [evidenceItems, authorizations, onboardings] = await Promise.all([
    listCounterpartyEvidenceItems(counterpartyId),
    listPostgresCounterpartyAuthorizations().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
    listCounterpartyOnboardings().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
  ]);
  const onboarding = onboardings[0];

  const [financialSoundnessDecisions, activity] = await Promise.all([
    onboarding ? listFinancialSoundnessDecisions(onboarding.id) : Promise.resolve([]),
    listPostgresActivityEventsForObjects([counterpartyId, ...(onboarding ? [onboarding.id] : [])]),
  ]);

  return { counterparty, evidenceItems, authorizations, onboarding, financialSoundnessDecisions, activity };
}
