import { createHash } from "node:crypto";
import { getPool } from "./postgres";
import { readinessAssuranceAreas } from "./vaspReadinessAssurance";

/**
 * Server-side VASP evidence-kit consistency checks.
 *
 * The evidence-kit validators (evidence-kit/verify_vasp_*.py) check the
 * DECLARED files in isolation before CI. These functions close the remaining
 * gap: they verify the declarations against the live PostgreSQL register —
 * area coverage, fixed points, accountable roles, submitter/verifier
 * segregation-of-duties, and sha256/URI agreement between the declared
 * manifest and recorded assurance evidence.
 *
 * Everything here is read-only and advisory: it never records evidence,
 * verifies evidence, assigns roles, activates providers, or submits anything
 * to a regulator.
 */

const EXPECTED_OWNER: Record<(typeof readinessAssuranceAreas)[number], { points: number; role: string }> = {
  controlled_live_test: { points: 7, role: "product_and_risk_owner" },
  governance_legal_ownership: { points: 8, role: "board_legal_company_secretary" },
  aml_cft_cpf_operations: { points: 14, role: "mlro_compliance_owner" },
  customer_asset_safeguarding: { points: 13, role: "custody_treasury_owner" },
  cybersecurity_resilience: { points: 10, role: "ciso_platform_sre_owner" },
  consumer_incident_reporting: { points: 6, role: "consumer_protection_cbn_liaison" },
};

const PLACEHOLDER = /REPLACE_WITH|\bTODO\b|\bTBD\b|<[^>]+>/i;
const SHA256 = /^[0-9a-f]{64}$/;
const HTTPS = /^https:\/\//i;
const UUID = /^[0-9a-fA-F-]{36}$/;
const EMAILISH = /@/;

export interface OwnerAssignmentRow {
  area: string;
  points: number;
  accountableRole: string;
  externalEvidenceOwner: string;
  externalContact: string;
  platformSubmitterSubject: string;
  platformVerifierSubject: string;
}

export interface ManifestEvidenceRow {
  area: string;
  evidenceUri: string;
  evidenceSha256: string;
  attestationUri?: string;
  attestationSha256?: string;
}

export interface ConsistencyFinding {
  area: string | null;
  code: string;
  detail: string;
}

export interface ConsistencyReport {
  dossierId: string;
  consistent: boolean;
  findings: ConsistencyFinding[];
  checkedAt: string;
  externalAuthority: false;
  regulatorSubmission: false;
}

function finding(area: string | null, code: string, detail: string): ConsistencyFinding {
  return { area, code, detail };
}

async function requireVaspDossierId(dossierId: string) {
  const { rows } = await getPool().query<{ id: string }>(
    "SELECT id FROM cbn_sandbox_dossiers WHERE id=$1 AND track='vasp'",
    [dossierId],
  );
  if (!rows[0]) throw new Error("A canonical VASP dossier is required");
}

async function assuranceItems(dossierId: string) {
  const { rows } = await getPool().query<{
    area: string;
    max_points: number;
    accountable_owner_role: string;
    status: string;
    evidence_uri: string | null;
    evidence_sha256: string | null;
    evidence_recorded_by: string | null;
    external_attestation_uri: string | null;
    external_attestation_sha256: string | null;
    verified_by: string | null;
  }>(
    `SELECT area, max_points, accountable_owner_role, status, evidence_uri, evidence_sha256,
            evidence_recorded_by, external_attestation_uri, external_attestation_sha256, verified_by
       FROM vasp_readiness_assurance_items WHERE dossier_id=$1`,
    [dossierId],
  );
  return rows;
}

/**
 * Validate declared six-owner assignments against schema rules AND the live
 * register (points/roles must match the initialised register rows, and any
 * recorded submitter/verifier subjects must match the declaration and remain
 * segregated).
 */
export async function validateVaspOwnerAssignmentsAgainstRegister(
  dossierId: string,
  assignments: OwnerAssignmentRow[],
): Promise<ConsistencyReport> {
  await requireVaspDossierId(dossierId);
  const items = await assuranceItems(dossierId);
  const byArea = new Map(items.map(item => [item.area, item]));
  const findings: ConsistencyFinding[] = [];

  const seen = new Set<string>();
  for (const row of assignments) {
    const expected = EXPECTED_OWNER[row.area as keyof typeof EXPECTED_OWNER];
    if (!expected || seen.has(row.area)) {
      findings.push(finding(row.area ?? null, "AREA_UNSUPPORTED_OR_DUPLICATE", "area is not one of the six fixed readiness areas, or is declared twice"));
      continue;
    }
    seen.add(row.area);
    if (row.points !== expected.points || row.accountableRole !== expected.role) {
      findings.push(finding(row.area, "POINTS_OR_ROLE_MISMATCH", "declared points/accountableRole do not match the fixed readiness register"));
    }
    for (const [key, value] of Object.entries({ externalEvidenceOwner: row.externalEvidenceOwner, externalContact: row.externalContact, platformSubmitterSubject: row.platformSubmitterSubject, platformVerifierSubject: row.platformVerifierSubject })) {
      if (typeof value !== "string" || !value.trim() || PLACEHOLDER.test(value)) {
        findings.push(finding(row.area, "PLACEHOLDER_VALUE", `${key} must be a real non-placeholder value`));
      }
    }
    if (!EMAILISH.test(row.externalContact ?? "")) {
      findings.push(finding(row.area, "CONTACT_NOT_EMAIL", "externalContact must be an email-like address"));
    }
    if (row.platformSubmitterSubject === row.platformVerifierSubject) {
      findings.push(finding(row.area, "SOD_VIOLATION", "platform verifier must differ from platform submitter"));
    }
    const live = byArea.get(row.area);
    if (!live) {
      findings.push(finding(row.area, "REGISTER_NOT_INITIALISED", "no live assurance register row exists for this area; initialise the register first"));
      continue;
    }
    if (live.max_points !== expected.points || live.accountable_owner_role !== expected.role) {
      findings.push(finding(row.area, "LIVE_REGISTER_DRIFT", "live register points/owner role differ from the fixed blueprint"));
    }
    if (live.evidence_recorded_by && live.evidence_recorded_by !== row.platformSubmitterSubject) {
      findings.push(finding(row.area, "SUBMITTER_MISMATCH", "recorded evidence submitter differs from the declared platformSubmitterSubject"));
    }
    if (live.verified_by && live.verified_by !== row.platformVerifierSubject) {
      findings.push(finding(row.area, "VERIFIER_MISMATCH", "recorded verifier differs from the declared platformVerifierSubject"));
    }
  }
  for (const area of readinessAssuranceAreas) {
    if (!seen.has(area)) findings.push(finding(area, "AREA_MISSING", "assignments must cover every fixed readiness area"));
  }
  return { dossierId, consistent: findings.length === 0, findings, checkedAt: new Date().toISOString(), externalAuthority: false, regulatorSubmission: false };
}

/**
 * Validate a declared evidence manifest against live recorded assurance
 * evidence: URI/sha256 must agree with what is stored, statuses must be
 * consistent with declared attestations, and every digest is re-hashed from
 * the declared canonical string form to catch malformed hex.
 */
export async function validateVaspEvidenceManifestAgainstRegister(
  dossierId: string,
  manifest: ManifestEvidenceRow[],
): Promise<ConsistencyReport> {
  await requireVaspDossierId(dossierId);
  const items = await assuranceItems(dossierId);
  const byArea = new Map(items.map(item => [item.area, item]));
  const findings: ConsistencyFinding[] = [];

  for (const row of manifest) {
    const live = byArea.get(row.area);
    if (!live) {
      findings.push(finding(row.area ?? null, "AREA_UNKNOWN", "manifest area has no live assurance register row"));
      continue;
    }
    if (!HTTPS.test(row.evidenceUri ?? "")) findings.push(finding(row.area, "EVIDENCE_URI_NOT_HTTPS", "evidence URI must be https://"));
    if (!SHA256.test(row.evidenceSha256 ?? "")) findings.push(finding(row.area, "EVIDENCE_DIGEST_MALFORMED", "evidence sha256 must be 64 lowercase hex characters"));
    if (SHA256.test(row.evidenceSha256 ?? "")) {
      const rehash = createHash("sha256").update(row.evidenceSha256, "utf8").digest("hex");
      if (!SHA256.test(rehash)) findings.push(finding(row.area, "EVIDENCE_DIGEST_UNHASHABLE", "digest could not be re-hashed; malformed input"));
    }
    if (live.evidence_uri && live.evidence_uri !== row.evidenceUri) {
      findings.push(finding(row.area, "EVIDENCE_URI_MISMATCH", "declared evidence URI differs from the live register"));
    }
    if (live.evidence_sha256 && live.evidence_sha256 !== row.evidenceSha256) {
      findings.push(finding(row.area, "EVIDENCE_DIGEST_MISMATCH", "declared evidence digest differs from the live register"));
    }
    const declaresAttestation = Boolean(row.attestationUri || row.attestationSha256);
    if (declaresAttestation) {
      if (!HTTPS.test(row.attestationUri ?? "")) findings.push(finding(row.area, "ATTESTATION_URI_NOT_HTTPS", "attestation URI must be https://"));
      if (!SHA256.test(row.attestationSha256 ?? "")) findings.push(finding(row.area, "ATTESTATION_DIGEST_MALFORMED", "attestation sha256 must be 64 lowercase hex characters"));
      if (live.status !== "externally_verified") {
        findings.push(finding(row.area, "ATTESTATION_WITHOUT_VERIFICATION", "manifest declares an attestation but the live item is not externally_verified"));
      }
      if (live.external_attestation_uri && live.external_attestation_uri !== row.attestationUri) {
        findings.push(finding(row.area, "ATTESTATION_URI_MISMATCH", "declared attestation URI differs from the live register"));
      }
      if (live.external_attestation_sha256 && live.external_attestation_sha256 !== row.attestationSha256) {
        findings.push(finding(row.area, "ATTESTATION_DIGEST_MISMATCH", "declared attestation digest differs from the live register"));
      }
    } else if (live.status === "externally_verified") {
      findings.push(finding(row.area, "VERIFIED_WITHOUT_ATTESTATION", "live item is externally_verified but the manifest declares no attestation"));
    }
  }
  return { dossierId, consistent: findings.length === 0, findings, checkedAt: new Date().toISOString(), externalAuthority: false, regulatorSubmission: false };
}
