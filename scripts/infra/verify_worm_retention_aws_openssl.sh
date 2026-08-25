#!/usr/bin/env bash
# Independent WORM verifier for verify_sod_alerting_and_worm.sh.
# Requires AWS CLI, OpenSSL, and Python 3. It performs no delete or retention-shortening
# operation. Use a separately administered least-privilege verifier identity.
set -euo pipefail

fail() { printf 'worm_verifier_error=%s\n' "$1" >&2; exit 1; }
require_env() { [[ -n "${!1:-}" ]] || fail "missing_${1}"; }

AWS_CLI=${AWS_CLI:-aws}
require_env WORM_BUCKET
require_env WORM_OBJECT_KEY
require_env WORM_OBJECT_VERSION_ID
require_env WORM_SIGNATURE_KEY
require_env WORM_PUBLIC_KEY_PATH
require_env WORM_EXPECTED_SHA256
require_env WORM_MIN_RETAIN_UNTIL

[[ -x "$(command -v "$AWS_CLI" || true)" ]] || fail aws_cli_not_found
command -v openssl >/dev/null 2>&1 || fail openssl_not_found
command -v python3 >/dev/null 2>&1 || fail python3_not_found
[[ -r "$WORM_PUBLIC_KEY_PATH" ]] || fail public_key_not_readable
[[ "$WORM_EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail expected_sha256_must_be_64_lowercase_hex

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/umoja-worm-verify.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
OBJECT_PATH="$WORK_DIR/audit-batch"
SIGNATURE_PATH="$WORK_DIR/audit-batch.sig"
HEAD_JSON="$WORK_DIR/head.json"
RETENTION_JSON="$WORK_DIR/retention.json"

AWS_ARGS=()
[[ -n "${AWS_PROFILE:-}" ]] && AWS_ARGS+=(--profile "$AWS_PROFILE")
[[ -n "${AWS_REGION:-}" ]] && AWS_ARGS+=(--region "$AWS_REGION")
[[ -n "${AWS_ENDPOINT_URL:-}" ]] && AWS_ARGS+=(--endpoint-url "$AWS_ENDPOINT_URL")

"$AWS_CLI" "${AWS_ARGS[@]}" s3api head-object \
  --bucket "$WORM_BUCKET" \
  --key "$WORM_OBJECT_KEY" \
  --version-id "$WORM_OBJECT_VERSION_ID" \
  --output json >"$HEAD_JSON" || fail head_object_failed

"$AWS_CLI" "${AWS_ARGS[@]}" s3api get-object-retention \
  --bucket "$WORM_BUCKET" \
  --key "$WORM_OBJECT_KEY" \
  --version-id "$WORM_OBJECT_VERSION_ID" \
  --output json >"$RETENTION_JSON" || fail get_object_retention_failed

python3 - "$HEAD_JSON" "$RETENTION_JSON" "$WORM_MIN_RETAIN_UNTIL" <<'PY'
import datetime as dt
import json
import sys

head_path, retention_path, minimum = sys.argv[1:]
head = json.load(open(head_path, encoding="utf-8"))
retention = json.load(open(retention_path, encoding="utf-8"))
head_mode = head.get("ObjectLockMode")
head_until = head.get("ObjectLockRetainUntilDate")
ret_mode = retention.get("Retention", {}).get("Mode")
ret_until = retention.get("Retention", {}).get("RetainUntilDate")
if head_mode != "COMPLIANCE":
    raise SystemExit(f"object_lock_mode_not_compliance:{head_mode!r}")
if ret_mode != "COMPLIANCE":
    raise SystemExit(f"retention_api_mode_not_compliance:{ret_mode!r}")
if not head_until or not ret_until:
    raise SystemExit("missing_object_lock_retention_date")
if head_until != ret_until:
    raise SystemExit(f"retention_date_mismatch:{head_until}:{ret_until}")
def parse(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
if parse(ret_until) < parse(minimum):
    raise SystemExit(f"retention_before_required_horizon:{ret_until}:{minimum}")
print(f"object_lock=COMPLIANCE")
print(f"retain_until={ret_until}")
print(f"retention_minimum={minimum}")
PY

"$AWS_CLI" "${AWS_ARGS[@]}" s3api get-object \
  --bucket "$WORM_BUCKET" \
  --key "$WORM_OBJECT_KEY" \
  --version-id "$WORM_OBJECT_VERSION_ID" \
  "$OBJECT_PATH" >/dev/null || fail object_download_failed

actual_sha256=$(sha256sum "$OBJECT_PATH" | awk '{print $1}')
[[ "$actual_sha256" == "$WORM_EXPECTED_SHA256" ]] || \
  fail "sha256_mismatch_expected_${WORM_EXPECTED_SHA256}_actual_${actual_sha256}"
printf 'object_sha256=%s\n' "$actual_sha256"

"$AWS_CLI" "${AWS_ARGS[@]}" s3api get-object \
  --bucket "$WORM_BUCKET" \
  --key "$WORM_SIGNATURE_KEY" \
  --output json "$SIGNATURE_PATH" >/dev/null || fail detached_signature_download_failed

openssl dgst -sha256 \
  -verify "$WORM_PUBLIC_KEY_PATH" \
  -signature "$SIGNATURE_PATH" \
  "$OBJECT_PATH" >/dev/null 2>&1 || fail detached_signature_invalid

printf 'detached_signature=valid\n'
printf 'signature_algorithm=SHA-256-with-public-key\n'
printf 'worm_verification=passed\n'
