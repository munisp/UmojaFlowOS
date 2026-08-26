#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  verify_worm_evidence_upload.sh \
    --bucket BUCKET \
    --prefix PREFIX \
    --evidence-root PATH \
    --retain-until ISO-8601 \
    --release-sha 40-char-lowercase-sha \
    --run-id RUN-ID
USAGE
  exit 2
}

BUCKET=""
PREFIX=""
EVIDENCE_ROOT=""
RETAIN_UNTIL=""
RELEASE_SHA=""
RUN_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET=${2:?missing value}; shift 2 ;;
    --prefix) PREFIX=${2:?missing value}; shift 2 ;;
    --evidence-root) EVIDENCE_ROOT=${2:?missing value}; shift 2 ;;
    --retain-until) RETAIN_UNTIL=${2:?missing value}; shift 2 ;;
    --release-sha) RELEASE_SHA=${2:?missing value}; shift 2 ;;
    --run-id) RUN_ID=${2:?missing value}; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$BUCKET" && -n "$PREFIX" && -d "$EVIDENCE_ROOT" && -n "$RETAIN_UNTIL" && -n "$RUN_ID" ]] || usage
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid lowercase release SHA" >&2; exit 1; }
command -v aws >/dev/null || { echo "aws CLI is required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

count=0
while IFS= read -r -d '' file; do
  rel="${file#"$EVIDENCE_ROOT"/}"
  key="$PREFIX/$rel"
  expected=$(sha256sum "$file" | awk '{print $1}')
  head=$(mktemp)
  trap 'rm -f "$head"' EXIT
  aws s3api head-object --bucket "$BUCKET" --key "$key" >"$head"
  actual_size=$(jq -r '.ContentLength // 0' "$head")
  expected_size=$(wc -c <"$file")
  [[ "$actual_size" = "$expected_size" ]] || { echo "WORM object size mismatch: s3://$BUCKET/$key" >&2; exit 1; }
  mode=$(jq -r '.ObjectLockMode // empty' "$head")
  until=$(jq -r '.ObjectLockRetainUntilDate // empty' "$head")
  [[ "$mode" = "COMPLIANCE" ]] || { echo "WORM object is not COMPLIANCE locked: s3://$BUCKET/$key" >&2; exit 1; }
  [[ -n "$until" ]] || { echo "WORM object has no retention timestamp: s3://$BUCKET/$key" >&2; exit 1; }
  python3 - "$until" "$RETAIN_UNTIL" <<'PY'
from datetime import datetime
import sys
actual = datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
expected = datetime.fromisoformat(sys.argv[2].replace('Z', '+00:00'))
if actual < expected:
    raise SystemExit('WORM retention is shorter than the approved retain-until time')
PY
  metadata_sha=$(jq -r '.Metadata["release-sha"] // empty' "$head")
  metadata_run=$(jq -r '.Metadata["run-id"] // empty' "$head")
  [[ "$metadata_sha" = "$RELEASE_SHA" ]] || { echo "WORM release SHA metadata mismatch: s3://$BUCKET/$key" >&2; exit 1; }
  [[ "$metadata_run" = "$RUN_ID" ]] || { echo "WORM run ID metadata mismatch: s3://$BUCKET/$key" >&2; exit 1; }
  printf '%s\t%s\t%s\t%s\n' "$rel" "$expected" "$mode" "$until"
  count=$((count + 1))
done < <(find "$EVIDENCE_ROOT" -type f -not -name '*.sha256' -print0 | sort -z)
[[ "$count" -gt 0 ]] || { echo "no evidence files found" >&2; exit 1; }
printf 'WORM verification passed: %s objects\n' "$count"
