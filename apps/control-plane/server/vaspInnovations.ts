/**
 * VASP innovation layer — ten read-only analytical capabilities over the
 * recorded VASP/CBN evidence state.
 *
 * Every function is:
 *  - read-only (no writes, no transactions required);
 *  - fail-closed (a non-VASP or missing dossier throws rather than guesses);
 *  - honest (each report carries explicit `externalAuthority: false` and
 *    `regulatorSubmission: false` markers; nothing here contacts, verifies,
 *    or transmits to any external party).
 */
import { createHash } from "crypto";
import { getPool } from "./postgres";

const STALENESS_DAYS = 180;
const INCIDENT_WINDOW_DAYS = 90;
const HEIGHTENED_EXPOSURE_LIMIT = 2;
const VERIFIER_CONCENTRATION_CEILING = 2 / 3;

type Finding = { code: string; detail: string };

function sha256Hex(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic JSON serialization with sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function requireVaspDossier(dossierId: string) {
  const { rows } = await getPool().query<{ id: string; track: string; status: string }>(
    "SELECT id, track, status FROM cbn_sandbox_dossiers WHERE id = $1",
    [dossierId],
  );
  if (!rows[0]) throw new Error("CBN sandbox dossier does not exist");
  if (rows[0].track !== "vasp") throw new Error("A canonical VASP dossier is required");
  return rows[0];
}

function daysBetween(from: Date, to: Date) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/* 1 — Evidence staleness monitor --------------------------------------- */
export async function evaluateVaspEvidenceStaleness(dossierId: string, now = new Date()) {
  await requireVaspDossier(dossierId);
  const findings: Finding[] = [];
  const assurance = await getPool().query<{ area: string; status: string; evidence_recorded_at: Date | null; verified_at: Date | null }>(
    "SELECT area, status, evidence_recorded_at, verified_at FROM vasp_readiness_assurance_items WHERE dossier_id = $1 ORDER BY area",
    [dossierId],
  );
  for (const row of assurance.rows) {
    const stamped = row.verified_at ?? row.evidence_recorded_at;
    if ((row.status === "evidence_recorded" || row.status === "externally_verified") && stamped && daysBetween(stamped, now) > STALENESS_DAYS) {
      findings.push({ code: "ASSURANCE_EVIDENCE_STALE", detail: `${row.area}: last evidence activity ${daysBetween(stamped, now)} days ago (> ${STALENESS_DAYS})` });
    }
    if (row.status === "rejected") findings.push({ code: "AREA_REJECTED_PENDING_FRESH_EVIDENCE", detail: `${row.area}: rejected evidence awaits replacement` });
  }
  const dossierEvidence = await getPool().query<{ category: string; recorded_at: Date }>(
    "SELECT category, MAX(recorded_at) AS recorded_at FROM cbn_sandbox_evidence_items WHERE dossier_id = $1 GROUP BY category ORDER BY category",
    [dossierId],
  );
  for (const row of dossierEvidence.rows) {
    if (daysBetween(row.recorded_at, now) > STALENESS_DAYS) {
      findings.push({ code: "DOSSIER_EVIDENCE_STALE", detail: `${row.category}: recorded ${daysBetween(row.recorded_at, now)} days ago (> ${STALENESS_DAYS})` });
    }
  }
  return { dossierId, stale: findings.length > 0, stalenessThresholdDays: STALENESS_DAYS, findings, checkedAt: now.toISOString(), externalAuthority: false, regulatorSubmission: false };
}

/* 2 — Tamper-evident assurance evidence chain -------------------------- */
export async function computeVaspAssuranceEvidenceChain(dossierId: string) {
  await requireVaspDossier(dossierId);
  const { rows } = await getPool().query<Record<string, unknown>>(
    "SELECT area, max_points, status, evidence_uri, evidence_sha256, evidence_recorded_by, external_verifier, verified_by, updated_at FROM vasp_readiness_assurance_items WHERE dossier_id = $1 ORDER BY area",
    [dossierId],
  );
  let head = sha256Hex(`vasp-assurance-chain:${dossierId}:genesis`);
  for (const row of rows) {
    head = sha256Hex(head + ":" + canonicalJson({ ...row, updated_at: row.updated_at ? new Date(row.updated_at as string).toISOString() : null }));
  }
  return { dossierId, itemCount: rows.length, headDigest: head, algorithm: "sha256-chain-over-canonical-rows", computedAt: new Date().toISOString(), externalAuthority: false, regulatorSubmission: false };
}

/* 3 — Travel Rule route completeness scoring ---------------------------- */
const TRAVEL_RULE_CATEGORIES = ["originator_information_schema", "beneficiary_information_schema", "secure_counterparty_exchange_design", "counterparty_identity_and_authorisation", "exception_and_rejection_handling"] as const;
export async function scoreVaspTravelRuleRoute(dossierId: string, counterpartyId: string) {
  await requireVaspDossier(dossierId);
  const { rows } = await getPool().query<{ category: string }>(
    "SELECT DISTINCT category FROM vasp_travel_rule_evidence_items WHERE dossier_id = $1 AND counterparty_id = $2",
    [dossierId, counterpartyId],
  );
  const recorded = new Set(rows.map(row => row.category));
  const missing = TRAVEL_RULE_CATEGORIES.filter(category => !recorded.has(category));
  const score = Math.round(((TRAVEL_RULE_CATEGORIES.length - missing.length) / TRAVEL_RULE_CATEGORIES.length) * 100);
  const band = missing.length === TRAVEL_RULE_CATEGORIES.length ? "no_recorded_evidence" : missing.length > 0 ? "partial_record" : "internal_record_complete";
  return { dossierId, counterpartyId, score, band, recordedCategories: [...recorded].sort(), missingCategories: missing, externalCounterpartyVerification: false, externalTransmission: false, computedAt: new Date().toISOString() };
}

/* 4 — Composite VASP readiness index ------------------------------------ */
export async function computeVaspReadinessIndex(dossierId: string) {
  await requireVaspDossier(dossierId);
  const dossierEvidence = await getPool().query<{ count: string }>(
    "SELECT COUNT(DISTINCT category) AS count FROM cbn_sandbox_evidence_items WHERE dossier_id = $1",
    [dossierId],
  );
  const dossierComponent = Math.min(1, Number(dossierEvidence.rows[0]?.count ?? 0) / 15);
  const profile = await getPool().query<{ id: string }>("SELECT id FROM vasp_regulatory_profiles WHERE dossier_id = $1", [dossierId]);
  let supervisoryComponent = 0;
  if (profile.rows[0]) {
    const supervisory = await getPool().query<{ count: string }>(
      "SELECT COUNT(DISTINCT category) AS count FROM vasp_regulatory_evidence_items WHERE profile_id = $1",
      [profile.rows[0].id],
    );
    supervisoryComponent = Math.min(1, Number(supervisory.rows[0]?.count ?? 0) / 10);
  }
  const assurance = await getPool().query<{ verified: string; total: string }>(
    "SELECT COALESCE(SUM(CASE WHEN status = 'externally_verified' THEN max_points ELSE 0 END), 0) AS verified, COALESCE(SUM(max_points), 0) AS total FROM vasp_readiness_assurance_items WHERE dossier_id = $1",
    [dossierId],
  );
  const assuranceTotal = Number(assurance.rows[0]?.total ?? 0);
  const assuranceComponent = assuranceTotal > 0 ? Number(assurance.rows[0]?.verified ?? 0) / assuranceTotal : 0;
  const index = Math.round((0.25 * dossierComponent + 0.35 * supervisoryComponent + 0.40 * assuranceComponent) * 1000) / 10;
  return {
    dossierId, index,
    components: { dossierEvidence: Math.round(dossierComponent * 1000) / 10, supervisoryEvidence: Math.round(supervisoryComponent * 1000) / 10, assuranceVerification: Math.round(assuranceComponent * 1000) / 10 },
    weights: { dossierEvidence: 0.25, supervisoryEvidence: 0.35, assuranceVerification: 0.40 },
    note: "Internal evidence-completeness index only; not an eligibility, admission, or licensing signal.",
    computedAt: new Date().toISOString(), externalAuthority: false, regulatorSubmission: false,
  };
}

/* 5 — Offshore exposure concentration check ----------------------------- */
export async function evaluateVaspOffshoreExposureConcentration(dossierId: string) {
  await requireVaspDossier(dossierId);
  const profiles = await getPool().query<{ id: string; counterparty_id: string; home_jurisdiction: string; exposure_tier: string }>(
    "SELECT id, counterparty_id, home_jurisdiction, exposure_tier FROM vasp_offshore_counterparty_profiles WHERE dossier_id = $1 ORDER BY recorded_at",
    [dossierId],
  );
  const breaches: Finding[] = [];
  const heightened = profiles.rows.filter(row => row.exposure_tier === "heightened");
  for (const row of profiles.rows.filter(item => item.exposure_tier === "prohibited_review")) {
    breaches.push({ code: "PROHIBITED_REVIEW_EXPOSURE_PRESENT", detail: `${row.home_jurisdiction} counterparty ${row.counterparty_id} is in prohibited_review` });
  }
  if (heightened.length > HEIGHTENED_EXPOSURE_LIMIT) {
    breaches.push({ code: "HEIGHTENED_EXPOSURE_CONCENTRATION", detail: `${heightened.length} heightened-tier exposures exceed the internal ceiling of ${HEIGHTENED_EXPOSURE_LIMIT}` });
  }
  const perProfile: Array<{ profileId: string; jurisdiction: string; tier: string; missingCategories: string[] }> = [];
  for (const row of profiles.rows) {
    const evidence = await getPool().query<{ category: string }>(
      "SELECT DISTINCT category FROM vasp_offshore_counterparty_evidence_items WHERE profile_id = $1",
      [row.id],
    );
    const recorded = new Set(evidence.rows.map(item => item.category));
    const missing = ["jurisdictional_authorisation_scope", "ownership_and_control", "sanctions_and_adverse_media_process", "travel_rule_interoperability", "data_protection_and_retention", "incident_and_exit_contact"].filter(category => !recorded.has(category));
    perProfile.push({ profileId: row.id, jurisdiction: row.home_jurisdiction, tier: row.exposure_tier, missingCategories: missing });
  }
  return { dossierId, breach: breaches.length > 0, breaches, profiles: perProfile, heightenedCeiling: HEIGHTENED_EXPOSURE_LIMIT, checkedAt: new Date().toISOString(), externalAuthority: false, providerActivation: false, valueMovement: false };
}

/* 6 — Incident pattern detection ---------------------------------------- */
export async function detectVaspIncidentPatterns(dossierId: string, now = new Date()) {
  await requireVaspDossier(dossierId);
  const { rows } = await getPool().query<{ kind: string; severity: string; occurred_at: Date; detected_at: Date }>(
    "SELECT kind, severity, occurred_at, detected_at FROM cbn_sandbox_incidents WHERE dossier_id = $1 ORDER BY occurred_at",
    [dossierId],
  );
  const findings: Finding[] = [];
  const windowStart = new Date(now.getTime() - INCIDENT_WINDOW_DAYS * 86_400_000);
  const byKind = new Map<string, number>();
  let latencyHoursTotal = 0;
  for (const row of rows) {
    latencyHoursTotal += Math.max(0, (row.detected_at.getTime() - row.occurred_at.getTime()) / 3_600_000);
    if ((row.severity === "high" || row.severity === "critical") && row.occurred_at >= windowStart) {
      byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
    }
  }
  for (const [kind, count] of byKind) {
    if (count >= 2) findings.push({ code: "RECURRING_SEVERE_INCIDENT_PATTERN", detail: `${count} ${severityNote(rows, kind)} ${kind} incident(s) within ${INCIDENT_WINDOW_DAYS} days` });
  }
  return {
    dossierId, incidentCount: rows.length, meanDetectionLatencyHours: rows.length ? Math.round((latencyHoursTotal / rows.length) * 10) / 10 : null,
    findings, windowDays: INCIDENT_WINDOW_DAYS, advisoryOnly: true, checkedAt: now.toISOString(), externalNotification: false,
  };
}
function severityNote(rows: Array<{ kind: string; severity: string }>, kind: string) {
  return rows.filter(row => row.kind === kind).some(row => row.severity === "critical") ? "high/critical" : "high";
}

/* 7 — Regulatory critical-path planner ---------------------------------- */
export async function planVaspRegulatoryCriticalPath(dossierId: string, now = new Date()) {
  await requireVaspDossier(dossierId);
  const deadlines = await getPool().query<{ id: string; title: string; due_at: Date; regulator: string }>(
    "SELECT id, title, due_at, regulator FROM regulatory_deadlines WHERE status = 'open' AND regulator = 'CBN' ORDER BY due_at",
    [],
  );
  const assurance = await getPool().query<{ area: string; status: string; max_points: number }>(
    "SELECT area, status, max_points FROM vasp_readiness_assurance_items WHERE dossier_id = $1 AND status IN ('open','rejected') ORDER BY max_points DESC",
    [dossierId],
  );
  const steps: Array<{ rank: number; kind: string; reference: string; daysRemaining: number | null; detail: string }> = [];
  deadlines.rows.forEach(row => {
    steps.push({ rank: 0, kind: "regulatory_deadline", reference: row.id, daysRemaining: daysBetween(now, row.due_at), detail: `${row.regulator}: ${row.title}` });
  });
  assurance.rows.forEach(row => {
    steps.push({ rank: 0, kind: "assurance_gap", reference: row.area, daysRemaining: null, detail: `${row.area.replaceAll("_", " ")} (${row.max_points} points) is ${row.status}` });
  });
  steps.sort((a, b) => (a.daysRemaining ?? Number.MAX_SAFE_INTEGER) - (b.daysRemaining ?? Number.MAX_SAFE_INTEGER));
  steps.forEach((step, index) => { step.rank = index + 1; });
  return { dossierId, steps, overdueCount: steps.filter(step => (step.daysRemaining ?? 0) < 0).length, note: "Internal planning aid only; no deadline is extended, met, or submitted by this report.", computedAt: now.toISOString(), regulatorSubmission: false };
}

/* 8 — Evidence digest reuse / integrity audit ---------------------------- */
export async function auditVaspEvidenceIntegrity(dossierId: string) {
  await requireVaspDossier(dossierId);
  const queries: Array<{ table: string; rows: Array<{ digest: string; label: string }> }> = [];
  const sources: Array<{ sql: string; label: (row: Record<string, string>) => string }> = [
    { sql: "SELECT evidence_sha256 AS digest, category AS label FROM cbn_sandbox_evidence_items WHERE dossier_id = $1", label: row => `dossier/${row.label}` },
    { sql: "SELECT evidence_sha256 AS digest, category AS label FROM vasp_travel_rule_evidence_items WHERE dossier_id = $1", label: row => `travel-rule/${row.label}` },
    { sql: "SELECT evidence_sha256 AS digest, area AS label FROM vasp_readiness_assurance_items WHERE dossier_id = $1 AND evidence_sha256 IS NOT NULL", label: row => `assurance/${row.label}` },
  ];
  for (const source of sources) {
    const { rows } = await getPool().query<{ digest: string; label: string }>(source.sql, [dossierId]);
    queries.push({ table: source.sql, rows: rows.map(row => ({ digest: row.digest, label: source.label(row) })) });
  }
  const seen = new Map<string, string[]>();
  for (const set of queries) for (const row of set.rows) {
    const list = seen.get(row.digest) ?? [];
    if (!list.includes(row.label)) list.push(row.label);
    seen.set(row.digest, list);
  }
  const findings: Finding[] = [];
  for (const [digest, labels] of seen) {
    if (labels.length > 1) findings.push({ code: "DIGEST_REUSE_ACROSS_CATEGORIES", detail: `${digest.slice(0, 12)}… attached to ${labels.join(", ")}` });
  }
  const profile = await getPool().query<{ id: string }>("SELECT id FROM vasp_regulatory_profiles WHERE dossier_id = $1", [dossierId]);
  if (profile.rows[0]) {
    const supervisory = await getPool().query<{ digest: string; category: string }>(
      "SELECT evidence_sha256 AS digest, category FROM vasp_regulatory_evidence_items WHERE profile_id = $1",
      [profile.rows[0].id],
    );
    const supervisorySeen = new Map<string, string[]>();
    for (const row of supervisory.rows) {
      const list = supervisorySeen.get(row.digest) ?? [];
      list.push(row.category);
      supervisorySeen.set(row.digest, list);
    }
    for (const [digest, labels] of supervisorySeen) {
      if (new Set(labels).size > 1) findings.push({ code: "DIGEST_REUSE_ACROSS_CATEGORIES", detail: `${digest.slice(0, 12)}… attached to supervisory ${[...new Set(labels)].join(", ")}` });
    }
  }
  return { dossierId, consistent: findings.length === 0, findings, checkedDigests: seen.size, checkedAt: new Date().toISOString(), externalAuthority: false };
}

/* 9 — Cross-dossier verifier concentration / SoD scanner ----------------- */
export async function scanVaspSodConflicts() {
  const verified = await getPool().query<{ dossier_id: string; verified_by: string }>(
    "SELECT dossier_id, verified_by FROM vasp_readiness_assurance_items WHERE status = 'externally_verified'",
    [],
  );
  const findings: Finding[] = [];
  const total = verified.rows.length;
  const byVerifier = new Map<string, Set<string>>();
  for (const row of verified.rows) {
    const dossiers = byVerifier.get(row.verified_by) ?? new Set<string>();
    dossiers.add(row.dossier_id);
    byVerifier.set(row.verified_by, dossiers);
  }
  for (const [verifier, dossiers] of byVerifier) {
    const count = verified.rows.filter(row => row.verified_by === verifier).length;
    if (total > 0 && count / total > VERIFIER_CONCENTRATION_CEILING && total >= 3) {
      findings.push({ code: "VERIFIER_CONCENTRATION", detail: `${verifier} verified ${count}/${total} items across ${dossiers.size} dossier(s) (> ${Math.round(VERIFIER_CONCENTRATION_CEILING * 100)}%)` });
    }
  }
  const recorded = await getPool().query<{ evidence_recorded_by: string; verified_by: string }>(
    "SELECT evidence_recorded_by, verified_by FROM vasp_readiness_assurance_items WHERE status = 'externally_verified' AND evidence_recorded_by IS NOT NULL",
    [],
  );
  for (const row of recorded.rows) {
    if (row.evidence_recorded_by === row.verified_by) findings.push({ code: "SOD_VIOLATION_RESIDUAL", detail: `${row.verified_by} recorded and verified the same item — investigate schema bypass` });
  }
  return { scope: "all_vasp_dossiers", verifiedItems: total, findings, advisoryOnly: true, checkedAt: new Date().toISOString(), externalAuthority: false };
}

/* 10 — Deterministic assurance pack generator ---------------------------- */
export async function generateVaspAssurancePack(dossierId: string) {
  const dossier = await requireVaspDossier(dossierId);
  const items = await getPool().query<Record<string, unknown>>(
    "SELECT area, max_points, status, evidence_uri, evidence_sha256, evidence_recorded_by, evidence_recorded_at, external_verifier, external_attestation_uri, external_attestation_sha256, verified_by, verified_at FROM vasp_readiness_assurance_items WHERE dossier_id = $1 ORDER BY area",
    [dossierId],
  );
  const chain = await computeVaspAssuranceEvidenceChain(dossierId);
  const index = await computeVaspReadinessIndex(dossierId);
  const snapshot = items.rows.map(row => ({
    ...row,
    evidence_recorded_at: row.evidence_recorded_at ? new Date(row.evidence_recorded_at as string).toISOString() : null,
    verified_at: row.verified_at ? new Date(row.verified_at as string).toISOString() : null,
  }));
  const body = { dossierId, dossierStatus: dossier.status, readinessIndex: index.index, chainHeadDigest: chain.headDigest, items: snapshot };
  return {
    ...body,
    packSha256: sha256Hex(canonicalJson(body)),
    status: "internal_only_not_submitted",
    note: "Deterministic board/audit pack over recorded register state. It is not a regulatory filing and asserts no external approval.",
    generatedAt: new Date().toISOString(), externalAuthority: false, regulatorSubmission: false,
  };
}
