import { getPool, listPostgresActivityEventsForObjects, listPostgresCounterpartyAuthorizations, type Actor } from "./postgres";
import { listCounterpartyOnboardings } from "./counterpartyOnboarding";

export type BankArchetype = "correspondent_bank" | "receiving_bank" | "settlement_bank" | "custodian_bank" | "issuing_bank";
export type BankEvidenceType =
  | "banking_licence"
  | "aml_cft_attestation"
  | "correspondent_agreement_template"
  | "nostro_account_confirmation"
  | "sanctions_policy"
  | "travel_rule_readiness_attestation"
  | "swift_message_support_confirmation"
  | "fee_schedule"
  | "audit_reports"
  | "regulator_no_objection_letter"
  | "cyber_bcm_evidence"
  | "settlement_cutoff_calendar";

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify(metadata)],
  );
}

/** OM §6.2: the five banking-partner archetypes this platform can now record. */
export async function updateCounterpartyBankArchetype(actor: Actor, input: { counterpartyId: string; archetype: BankArchetype }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR UPDATE", [input.counterpartyId]);
    if (!current.rows[0]) throw new Error("counterparty record was not found");
    await client.query("UPDATE counterparties SET bank_archetype=$1::bank_archetype WHERE id=$2", [input.archetype, input.counterpartyId]);
    await recordActivity(client, actor, "counterparty.bank_archetype_updated", "counterparty", input.counterpartyId, { archetype: input.archetype });
    await client.query("COMMIT");
    return { id: input.counterpartyId, archetype: input.archetype };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** OM §6.4: one of the 12-item banking-partner evidence pack. */
export async function recordBankEvidenceItem(actor: Actor, input: { counterpartyId: string; evidenceType: BankEvidenceType; evidenceUri: string; note?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("a canonical counterparty is required before recording evidence");
    const { rows } = await client.query<{ id: string; counterpartyId: string; evidenceType: BankEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
      `INSERT INTO bank_evidence_items (counterparty_id, evidence_type, evidence_uri, note, recorded_by)
       VALUES ($1,$2::bank_evidence_type,$3,$4,$5)
       RETURNING id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"`,
      [input.counterpartyId, input.evidenceType, input.evidenceUri, input.note ?? null, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("bank evidence item insert did not return a record");
    await recordActivity(client, actor, "counterparty.bank_evidence_item_recorded", "counterparty", input.counterpartyId, { evidenceType: input.evidenceType });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listBankEvidenceItems(counterpartyId: string) {
  const { rows } = await getPool().query<{ id: string; counterpartyId: string; evidenceType: BankEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>(
    `SELECT id, counterparty_id AS "counterpartyId", evidence_type AS "evidenceType", evidence_uri AS "evidenceUri", note, recorded_by AS "recordedBy", recorded_at AS "recordedAt"
       FROM bank_evidence_items WHERE counterparty_id=$1 ORDER BY recorded_at DESC`,
    [counterpartyId],
  );
  return rows;
}

/**
 * OM §6.6 Gate G2 — crypto / VASP posture, owned by Compliance+Country Lead:
 * whether the correspondent bank will actually accept VASP-customer flows
 * with regulatory clarity. This platform has no distinct Country Lead role,
 * so it is restricted to compliance_officer/admin — a known gap against the
 * OM, not a substitution. Independent of the generic legal/technical/pilot
 * gate model for the same reason the LP financial-soundness gate is.
 */
export async function decideCryptoPostureGate(actor: Actor, input: { onboardingId: string; decision: "approved" | "blocked"; rationale: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const onboarding = await client.query<{ cycleNumber: number }>("SELECT cycle_number AS \"cycleNumber\" FROM counterparty_onboardings WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!onboarding.rows[0]) throw new Error("counterparty onboarding lifecycle was not found");
    const { rows } = await client.query<{ id: string; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>(
      `INSERT INTO counterparty_crypto_posture_decisions (onboarding_id, cycle_number, decision, rationale, decided_by, decided_role)
       VALUES ($1,$2,$3::counterparty_onboarding_decision,$4,$5,$6::operating_role)
       RETURNING id, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"`,
      [input.onboardingId, onboarding.rows[0].cycleNumber, input.decision, input.rationale, actor.openId, actor.role],
    );
    const record = rows[0];
    if (!record) throw new Error("crypto posture decision insert did not return a record");
    await recordActivity(client, actor, "counterparty.crypto_posture_gate_decided", "counterparty_onboarding", input.onboardingId, { decision: input.decision, cycleNumber: onboarding.rows[0].cycleNumber });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listCryptoPostureDecisions(onboardingId: string) {
  const { rows } = await getPool().query<{ id: string; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date; cycleNumber: number }>(
    `SELECT id, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt", cycle_number AS "cycleNumber"
       FROM counterparty_crypto_posture_decisions WHERE onboarding_id=$1 ORDER BY decided_at DESC`,
    [onboardingId],
  );
  return rows;
}

export async function listBankingPartners() {
  const { rows } = await getPool().query<{ id: string; legalName: string; jurisdiction: string; bankArchetype: BankArchetype | null; evidenceCount: string; createdAt: Date }>(
    `SELECT counterparty.id, counterparty.legal_name AS "legalName", counterparty.jurisdiction, counterparty.bank_archetype AS "bankArchetype",
            count(evidence.id)::text AS "evidenceCount",
            counterparty.created_at AS "createdAt"
       FROM counterparties counterparty
       LEFT JOIN bank_evidence_items evidence ON evidence.counterparty_id = counterparty.id
      WHERE counterparty.counterparty_type = 'correspondent_bank'
      GROUP BY counterparty.id
      ORDER BY counterparty.created_at DESC`,
  );
  return rows;
}

/**
 * Composite read backing the Banking Partner workspace: identity + OM
 * archetype, the 12-item evidence pack, licence authorisations, the generic
 * onboarding lifecycle (legal/technical/pilot gates, reused as-is), the
 * bank-specific crypto/VASP-posture gate, and the reconstructed activity feed.
 */
export async function getBankingPartnerWorkspace(counterpartyId: string) {
  const counterpartyResult = await getPool().query<{ id: string; legalName: string; counterpartyType: string; jurisdiction: string; bankArchetype: BankArchetype | null; createdAt: Date }>(
    `SELECT id, legal_name AS "legalName", counterparty_type AS "counterpartyType", jurisdiction, bank_archetype AS "bankArchetype", created_at AS "createdAt" FROM counterparties WHERE id=$1`,
    [counterpartyId],
  );
  const counterparty = counterpartyResult.rows[0];
  if (!counterparty) return undefined;

  const [evidenceItems, authorizations, onboardings] = await Promise.all([
    listBankEvidenceItems(counterpartyId),
    listPostgresCounterpartyAuthorizations().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
    listCounterpartyOnboardings().then(rows => rows.filter(row => row.counterpartyId === counterpartyId)),
  ]);
  const onboarding = onboardings[0];

  const [cryptoPostureDecisions, activity] = await Promise.all([
    onboarding ? listCryptoPostureDecisions(onboarding.id) : Promise.resolve([]),
    listPostgresActivityEventsForObjects([counterpartyId, ...(onboarding ? [onboarding.id] : [])]),
  ]);

  return { counterparty, evidenceItems, authorizations, onboarding, cryptoPostureDecisions, activity };
}
