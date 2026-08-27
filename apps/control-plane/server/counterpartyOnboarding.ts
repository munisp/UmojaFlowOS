import { getPool, type Actor } from "./postgres";

export type OnboardingStage = "legal_onboarding" | "technical_readiness" | "pilot" | "steady_state" | "recertification_due" | "blocked";
export type OnboardingGate = "legal" | "technical" | "pilot";
export type OnboardingDecision = "approved" | "blocked";
export type Corridor = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";

type OnboardingRow = {
  id: string;
  counterpartyId: string;
  legalName: string;
  counterpartyType: string;
  jurisdiction: string;
  countryOverlays: Corridor[];
  stage: OnboardingStage;
  cycleNumber: number;
  legalEvidenceUri: string;
  technicalEvidenceUri: string | null;
  pilotEvidenceUri: string | null;
  recertificationDueAt: Date | null;
  currentReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  decisions: Array<{
    id: string;
    cycleNumber: number;
    gate: OnboardingGate;
    decision: OnboardingDecision;
    evidenceUri: string;
    rationale: string;
    decidedBy: string;
    decidedRole: Actor["role"];
    decidedAt: Date;
  }>;
};

const stageForGate: Record<OnboardingGate, OnboardingStage> = {
  legal: "legal_onboarding",
  technical: "technical_readiness",
  pilot: "pilot",
};

const permittedGateRoles: Record<OnboardingGate, Actor["role"][]> = {
  legal: ["compliance_officer"],
  technical: ["admin"],
  pilot: ["compliance_officer", "treasury_operator"],
};

function requireDistinctOverlays(overlays: Corridor[]) {
  if (!overlays.length || overlays.length > 3 || new Set(overlays).size !== overlays.length) {
    throw new Error("one to three distinct Nigeria, Kenya, or South Africa corridor overlays are required");
  }
}

async function readOnboarding(onboardingId: string): Promise<OnboardingRow | undefined> {
  const { rows } = await getPool().query<OnboardingRow>(
    `SELECT onboarding.id,
            onboarding.counterparty_id AS "counterpartyId",
            counterparty.legal_name AS "legalName",
            counterparty.counterparty_type AS "counterpartyType",
            counterparty.jurisdiction,
            -- node-postgres has no built-in type parser for arrays of a
            -- custom enum (corridor_code[] here), so it falls back to the
            -- raw wire-format string ("{NIGERIA_NGN}") instead of a JS
            -- array - confirmed live, crashed the client's .map() calls in
            -- CounterpartyOnboardingControls.tsx. Casting to the built-in
            -- text[] here makes the driver parse it correctly; the values
            -- are still valid Corridor strings, just no longer typed as the
            -- enum at the wire level.
            onboarding.country_overlays::text[] AS "countryOverlays",
            onboarding.stage::text AS stage,
            onboarding.cycle_number AS "cycleNumber",
            onboarding.legal_evidence_uri AS "legalEvidenceUri",
            onboarding.technical_evidence_uri AS "technicalEvidenceUri",
            onboarding.pilot_evidence_uri AS "pilotEvidenceUri",
            onboarding.recertification_due_at AS "recertificationDueAt",
            onboarding.current_reason AS "currentReason",
            onboarding.created_by AS "createdBy",
            onboarding.created_at AS "createdAt",
            onboarding.updated_at AS "updatedAt",
            COALESCE(
              json_agg(json_build_object(
                'id', decision.id,
                'cycleNumber', decision.cycle_number,
                'gate', decision.gate,
                'decision', decision.decision,
                'evidenceUri', decision.evidence_uri,
                'rationale', decision.rationale,
                'decidedBy', decision.decided_by,
                'decidedRole', decision.decided_role,
                'decidedAt', decision.decided_at
              ) ORDER BY decision.decided_at) FILTER (WHERE decision.id IS NOT NULL), '[]'::json
            ) AS decisions
       FROM counterparty_onboardings onboarding
       JOIN counterparties counterparty ON counterparty.id = onboarding.counterparty_id
       LEFT JOIN counterparty_onboarding_gate_decisions decision ON decision.onboarding_id = onboarding.id
       WHERE onboarding.id = $1
       GROUP BY onboarding.id, counterparty.id`,
    [onboardingId],
  );
  return rows[0];
}

export async function listCounterpartyOnboardings() {
  const { rows } = await getPool().query<{ id: string }>("SELECT id FROM counterparty_onboardings ORDER BY updated_at DESC");
  const values = await Promise.all(rows.map(row => readOnboarding(row.id)));
  return values.filter((value): value is OnboardingRow => Boolean(value));
}

export async function createCounterpartyOnboarding(actor: Actor, input: { counterpartyId: string; countryOverlays: Corridor[]; legalEvidenceUri: string; recertificationDueAt: Date }) {
  requireDistinctOverlays(input.countryOverlays);
  if (input.recertificationDueAt <= new Date()) throw new Error("recertification due date must be in the future");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("a canonical counterparty is required before onboarding");
    const existing = await client.query<{ id: string }>("SELECT id FROM counterparty_onboardings WHERE counterparty_id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (existing.rows[0]) throw new Error("counterparty already has an onboarding lifecycle");
    const created = await client.query<{ id: string }>(
      `INSERT INTO counterparty_onboardings (counterparty_id, country_overlays, legal_evidence_uri, recertification_due_at, created_by)
       VALUES ($1, $2::corridor_code[], $3, $4, $5) RETURNING id`,
      [input.counterpartyId, input.countryOverlays, input.legalEvidenceUri, input.recertificationDueAt, actor.openId],
    );
    const onboarding = created.rows[0];
    if (!onboarding) throw new Error("counterparty onboarding insert did not return a record");
    await client.query(
      "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [actor.openId, actor.role, "counterparty_onboarding.created", "counterparty_onboarding", onboarding.id, JSON.stringify({ counterpartyId: input.counterpartyId, countryOverlays: input.countryOverlays, stage: "legal_onboarding", legalEvidenceUri: input.legalEvidenceUri })],
    );
    await client.query("COMMIT");
    return await readOnboarding(onboarding.id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function decideCounterpartyOnboardingGate(actor: Actor, input: { onboardingId: string; gate: OnboardingGate; decision: OnboardingDecision; evidenceUri: string; rationale: string }) {
  if (!permittedGateRoles[input.gate].includes(actor.role)) throw new Error("this role cannot decide the selected onboarding gate");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ counterpartyId: string; stage: OnboardingStage; cycleNumber: number }>(
      "SELECT counterparty_id AS \"counterpartyId\", stage::text AS stage, cycle_number AS \"cycleNumber\" FROM counterparty_onboardings WHERE id=$1 FOR UPDATE",
      [input.onboardingId],
    );
    const onboarding = current.rows[0];
    if (!onboarding) throw new Error("counterparty onboarding lifecycle was not found");
    if (onboarding.stage !== stageForGate[input.gate]) throw new Error("onboarding gate does not match the current lifecycle stage");

    if (input.gate === "legal" && input.decision === "approved") {
      const authorisation = await client.query<{ id: string }>(
        "SELECT id FROM counterparty_authorizations WHERE counterparty_id=$1 AND status='verified' LIMIT 1 FOR KEY SHARE",
        [onboarding.counterpartyId],
      );
      if (!authorisation.rows[0]) throw new Error("legal onboarding requires a verified counterparty authorisation");
    }
    if (input.gate === "technical" && input.decision === "approved") {
      const integration = await client.query<{ id: string }>(
        "SELECT id FROM integration_connections WHERE counterparty_id=$1 AND state='active' LIMIT 1 FOR KEY SHARE",
        [onboarding.counterpartyId],
      );
      if (!integration.rows[0]) throw new Error("technical readiness requires a verified active integration connection");
    }
    if (input.gate === "pilot") {
      const duplicateActor = await client.query<{ id: string }>(
      "SELECT id FROM counterparty_onboarding_gate_decisions WHERE onboarding_id=$1 AND cycle_number=$2 AND gate='pilot' AND decided_by=$3 LIMIT 1",
        [input.onboardingId, onboarding.cycleNumber, actor.openId],
      );
      if (duplicateActor.rows[0]) throw new Error("pilot approval requires an independent second actor");
    }

    const duplicateRole = await client.query<{ id: string }>(
      "SELECT id FROM counterparty_onboarding_gate_decisions WHERE onboarding_id=$1 AND cycle_number=$2 AND gate=$3::counterparty_onboarding_gate AND decided_role=$4::operating_role LIMIT 1",
      [input.onboardingId, onboarding.cycleNumber, input.gate, actor.role],
    );
    if (duplicateRole.rows[0]) throw new Error("this role has already decided the selected onboarding gate for this cycle");

    await client.query(
      `INSERT INTO counterparty_onboarding_gate_decisions (onboarding_id, cycle_number, gate, decision, evidence_uri, rationale, decided_by, decided_role)
       VALUES ($1,$2,$3::counterparty_onboarding_gate,$4::counterparty_onboarding_decision,$5,$6,$7,$8::operating_role)`,
      [input.onboardingId, onboarding.cycleNumber, input.gate, input.decision, input.evidenceUri, input.rationale, actor.openId, actor.role],
    );

    let nextStage: OnboardingStage = onboarding.stage;
    if (input.decision === "blocked") nextStage = "blocked";
    if (input.gate === "legal" && input.decision === "approved") nextStage = "technical_readiness";
    if (input.gate === "technical" && input.decision === "approved") nextStage = "pilot";
    if (input.gate === "pilot" && input.decision === "approved") {
      const approvals = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM counterparty_onboarding_gate_decisions WHERE onboarding_id=$1 AND cycle_number=$2 AND gate='pilot' AND decision='approved'",
        [input.onboardingId, onboarding.cycleNumber],
      );
      if (Number(approvals.rows[0]?.count ?? 0) === 2) nextStage = "steady_state";
    }
    const evidenceColumn = input.gate === "technical" ? "technical_evidence_uri" : input.gate === "pilot" ? "pilot_evidence_uri" : "legal_evidence_uri";
    await client.query(
      `UPDATE counterparty_onboardings SET stage=$1::counterparty_onboarding_stage, current_reason=$2, ${evidenceColumn}=$3, updated_at=now() WHERE id=$4`,
      [nextStage, input.rationale, input.evidenceUri, input.onboardingId],
    );
    await client.query(
      "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [actor.openId, actor.role, "counterparty_onboarding.gate_decided", "counterparty_onboarding", input.onboardingId, JSON.stringify({ gate: input.gate, decision: input.decision, from: onboarding.stage, to: nextStage, cycleNumber: onboarding.cycleNumber })],
    );
    await client.query("COMMIT");
    return await readOnboarding(input.onboardingId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function beginCounterpartyRecertification(actor: Actor, onboardingId: string, legalEvidenceUri: string, recertificationDueAt: Date) {
  if (recertificationDueAt <= new Date()) throw new Error("next recertification due date must be in the future");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ stage: OnboardingStage; cycleNumber: number; recertificationDueAt: Date | null }>(
      "SELECT stage::text AS stage, cycle_number AS \"cycleNumber\", recertification_due_at AS \"recertificationDueAt\" FROM counterparty_onboardings WHERE id=$1 FOR UPDATE",
      [onboardingId],
    );
    const onboarding = current.rows[0];
    if (!onboarding) throw new Error("counterparty onboarding lifecycle was not found");
    if (onboarding.stage !== "steady_state") throw new Error("only a steady-state counterparty can enter recertification");
    if (!onboarding.recertificationDueAt || onboarding.recertificationDueAt > new Date()) throw new Error("recertification is not yet due");
    await client.query(
      `UPDATE counterparty_onboardings
          SET stage='legal_onboarding', cycle_number=cycle_number+1, legal_evidence_uri=$1,
              technical_evidence_uri=NULL, pilot_evidence_uri=NULL, current_reason='recertification cycle started',
              recertification_due_at=$2, updated_at=now()
        WHERE id=$3`,
      [legalEvidenceUri, recertificationDueAt, onboardingId],
    );
    await client.query(
      "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [actor.openId, actor.role, "counterparty_onboarding.recertification_started", "counterparty_onboarding", onboardingId, JSON.stringify({ from: "steady_state", to: "legal_onboarding", priorCycle: onboarding.cycleNumber, nextCycle: onboarding.cycleNumber + 1 })],
    );
    await client.query("COMMIT");
    return await readOnboarding(onboardingId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
