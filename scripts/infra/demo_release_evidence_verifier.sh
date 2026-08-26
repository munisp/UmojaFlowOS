#!/usr/bin/env bash
# Demonstrate fail-closed release evidence validation locally. The generated
# files are labelled as demonstration artifacts and never represent staging or
# production evidence.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REPO_DIR=${1:-"$ROOT_DIR"}
OUTPUT_DIR=${2:-"$ROOT_DIR/assurance/evidence/verifier-demo"}
VERIFIER="$ROOT_DIR/scripts/infra/verify_production_release_evidence.py"

for command in git sha256sum python3; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 69; }
done
if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  echo "Refusing demonstration against dirty repository: $REPO_DIR" >&2
  exit 64
fi

release_sha=$(git -C "$REPO_DIR" rev-parse HEAD)
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/artifacts"

for number in $(seq -f '%02g' 1 9); do
  printf 'demonstration-only artifact E-%s bound to %s\n' "$number" "$release_sha" > "$OUTPUT_DIR/artifacts/E-${number}.txt"
done

write_manifest() {
  local manifest=$1
  {
    printf '{\n'
    printf '  "release_sha": "%s",\n' "$release_sha"
    printf '  "environment": "staging",\n'
    printf '  "created_at": "2026-08-26T12:00:00Z",\n'
    printf '  "artifacts": [\n'
    for number in $(seq -f '%02g' 1 9); do
      local path="artifacts/E-${number}.txt"
      local digest
      digest=$(sha256sum "$OUTPUT_DIR/$path" | awk '{print $1}')
      printf '    {"evidence_id":"E-%s","path":"%s","sha256":"%s","run_id":"demo-E-%s"}' "$number" "$path" "$digest" "$number"
      [[ "$number" == "09" ]] || printf ','
      printf '\n'
    done
    printf '  ],\n'
    printf '  "approvals": [\n'
    printf '    {"role":"release_manager","subject":"demo-release-manager","release_sha":"%s","approved_at":"2026-08-26T12:00:00Z"},\n' "$release_sha"
    printf '    {"role":"security_owner","subject":"demo-security-owner","release_sha":"%s","approved_at":"2026-08-26T12:01:00Z"},\n' "$release_sha"
    printf '    {"role":"compliance_owner","subject":"demo-compliance-owner","release_sha":"%s","approved_at":"2026-08-26T12:02:00Z"},\n' "$release_sha"
    printf '    {"role":"operations_owner","subject":"demo-operations-owner","release_sha":"%s","approved_at":"2026-08-26T12:03:00Z"}\n' "$release_sha"
    printf '  ]\n}\n'
  } > "$manifest"
}

printf '{"release_sha":"%s","environment":"staging","created_at":"2026-08-26T12:00:00Z","artifacts":[],"approvals":[]}' "$release_sha" > "$OUTPUT_DIR/invalid-missing-evidence.json"
set +e
python3 "$VERIFIER" --manifest "$OUTPUT_DIR/invalid-missing-evidence.json" --repo "$REPO_DIR" > "$OUTPUT_DIR/invalid.stdout" 2> "$OUTPUT_DIR/invalid.stderr"
invalid_status=$?
set -e
if [[ "$invalid_status" -eq 0 ]]; then
  echo "Expected the incomplete evidence manifest to fail" >&2
  exit 1
fi

write_manifest "$OUTPUT_DIR/release.json"
python3 "$VERIFIER" --manifest "$OUTPUT_DIR/release.json" --repo "$REPO_DIR" | tee "$OUTPUT_DIR/valid.stdout"
printf 'invalid_exit_code=%s\nvalid_exit_code=0\nrelease_sha=%s\n' "$invalid_status" "$release_sha" > "$OUTPUT_DIR/summary.txt"
cat "$OUTPUT_DIR/summary.txt"
echo "Verifier demonstration completed. Demonstration artifacts are not staging evidence: $OUTPUT_DIR"
