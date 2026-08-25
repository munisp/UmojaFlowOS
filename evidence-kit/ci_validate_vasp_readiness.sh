#!/usr/bin/env bash
# CI-safe VASP evidence gate. It never records evidence, verifies evidence,
# assigns platform roles, activates providers, or sends regulatory submissions.
set -euo pipefail

: "${OWNER_ASSIGNMENTS_JSON:?Set to the reviewed six-owner assignment JSON file}"
: "${EVIDENCE_MANIFEST_JSON:?Set to the reviewed six-item evidence manifest JSON file}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/verify_vasp_owner_assignments.py" "$OWNER_ASSIGNMENTS_JSON"
python3 "$SCRIPT_DIR/verify_vasp_evidence_manifest.py" --require-attestation "$EVIDENCE_MANIFEST_JSON"

echo "local owner and evidence validation passed; no platform record has been changed"

# Optional staging read-only verification. It is intentionally opt-in and uses
# an auditor token supplied by CI secret injection, never written to logs/files.
if [[ -n "${READ_ONLY_STAGING_BASE_URL:-}" || -n "${READ_ONLY_AUDITOR_TOKEN:-}" || -n "${READ_ONLY_DOSSIER_ID:-}" ]]; then
  : "${READ_ONLY_STAGING_BASE_URL:?Set only a staging base URL, e.g. https://staging.example}"
  : "${READ_ONLY_AUDITOR_TOKEN:?Inject a short-lived named-auditor token through CI secrets}"
  : "${READ_ONLY_DOSSIER_ID:?Set the staging VASP dossier UUID}"

  trpc_read() {
    local procedure="$1"
    curl --fail-with-body --silent --show-error --get \
      -H "Authorization: Bearer ${READ_ONLY_AUDITOR_TOKEN}" \
      --data-urlencode "input={\"json\":{\"dossierId\":\"${READ_ONLY_DOSSIER_ID}\"}}" \
      "${READ_ONLY_STAGING_BASE_URL%/}/api/trpc/${procedure}"
  }

  mkdir -p ci-readonly-output
  trpc_read 'postgres.readinessAssurance' > ci-readonly-output/readiness-assurance.json
  trpc_read 'postgres.assessReadinessAssurance' > ci-readonly-output/readiness-assessment.json
  grep -Eq 'externally_verified|evidence_recorded|open|rejected' ci-readonly-output/readiness-assurance.json
  grep -Eq 'verifiedPoints|remainingPoints|externalApproval|licence|admission' ci-readonly-output/readiness-assessment.json
  echo "staging status read successfully; outputs saved to ci-readonly-output/"
fi
