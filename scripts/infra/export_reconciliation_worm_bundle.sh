#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${WORM_EXPORT_APPROVED:?set WORM_EXPORT_APPROVED=APPROVED_STAGING_WORM_EXPORT}"
[[ "$WORM_EXPORT_APPROVED" == APPROVED_STAGING_WORM_EXPORT ]] || { echo 'invalid WORM export approval' >&2; exit 2; }
: "${EVIDENCE_DIR:?set evidence directory}"
: "${WORM_BUCKET:?set WORM bucket}"
: "${WORM_PREFIX:?set WORM object prefix without leading/trailing slash}"
: "${RECONCILIATION_RUN_ID:?set reconciliation run ID}"
: "${RELEASE_SHA:?set 40-character release SHA}"
: "${RETAIN_UNTIL:?set ISO-8601 retention deadline}"
[[ -d "$EVIDENCE_DIR" ]] || { echo 'evidence directory does not exist' >&2; exit 2; }
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'invalid release SHA' >&2; exit 2; }
[[ "$RECONCILIATION_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]] || { echo 'invalid run ID' >&2; exit 2; }
[[ "$WORM_PREFIX" != /* && "$WORM_PREFIX" != */ ]] || { echo 'invalid WORM prefix' >&2; exit 2; }
command -v aws >/dev/null || { echo 'aws CLI is required' >&2; exit 2; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required' >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
bundle="umoja-reconciliation-${RECONCILIATION_RUN_ID}.tar.gz"
manifest="$work/evidence-manifest.json"

python3 - "$EVIDENCE_DIR" "$manifest" "$RECONCILIATION_RUN_ID" "$RELEASE_SHA" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]); output = pathlib.Path(sys.argv[2]); run_id = sys.argv[3]; release_sha = sys.argv[4]
items = []
for p in sorted(root.rglob('*')):
    if p.is_file() and p.name not in {'sha256sums.txt'}:
        items.append({'path': str(p.relative_to(root)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
output.write_text(json.dumps({'simulation': root.joinpath('collection-metadata.json').exists(), 'reconciliation_run_id': run_id, 'release_sha': release_sha, 'artifacts': items}, indent=2) + '\n')
PY
cp "$manifest" "$EVIDENCE_DIR/evidence-manifest-exported.json"
tar -C "$EVIDENCE_DIR" -czf "$work/$bundle" .
digest=$(sha256sum "$work/$bundle" | awk '{print $1}')
key="$WORM_PREFIX/$bundle"

result=$(aws s3api put-object \
  --bucket "$WORM_BUCKET" \
  --key "$key" \
  --body "$work/$bundle" \
  --checksum-algorithm SHA256 \
  --object-lock-mode COMPLIANCE \
  --object-lock-retain-until-date "$RETAIN_UNTIL" \
  --metadata "reconciliation-run-id=$RECONCILIATION_RUN_ID,release-sha=$RELEASE_SHA,bundle-sha256=$digest")
version_id=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["VersionId"])')

head=$(aws s3api head-object --bucket "$WORM_BUCKET" --key "$key" --version-id "$version_id")
printf '%s\n' "$head" > "$EVIDENCE_DIR/worm-export-head.json"
python3 - "$EVIDENCE_DIR/worm-export-head.json" "$RECONCILIATION_RUN_ID" "$RELEASE_SHA" "$digest" <<'PY'
import json, sys
h=json.load(open(sys.argv[1])); expected_run, expected_sha, expected_digest=sys.argv[2:]
md={k.lower():v for k,v in h.get('Metadata',{}).items()}
if md.get('reconciliation-run-id') != expected_run: raise SystemExit('run ID metadata mismatch')
if md.get('release-sha') != expected_sha: raise SystemExit('release SHA metadata mismatch')
if md.get('bundle-sha256') != expected_digest: raise SystemExit('bundle digest metadata mismatch')
if h.get('ObjectLockMode') != 'COMPLIANCE': raise SystemExit('Object Lock mode is not COMPLIANCE')
if not h.get('ObjectLockRetainUntilDate'): raise SystemExit('retention deadline missing')
print(json.dumps({'status':'PASS','version_id':h.get('VersionId'),'object_lock_mode':h.get('ObjectLockMode'),'retain_until':str(h.get('ObjectLockRetainUntilDate')),'bundle_sha256':expected_digest}, indent=2))
PY
printf 'WORM_EXPORT_PASS bucket=%s key=%s version_id=%s bundle_sha256=%s run_id=%s\n' "$WORM_BUCKET" "$key" "$version_id" "$digest" "$RECONCILIATION_RUN_ID"
