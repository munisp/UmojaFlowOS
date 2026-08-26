#!/usr/bin/env bash
set -euo pipefail

MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../infra/terraform/modules/release-evidence-worm" && pwd)"
WORK_DIR="${1:-$(mktemp -d /tmp/umoja-worm-tf.XXXXXX)}"
trap 'rm -rf "$WORK_DIR"' EXIT

command -v terraform >/dev/null || { echo "terraform is required" >&2; exit 1; }
cd "$MODULE_DIR"
terraform fmt -check -diff
terraform init -backend=false -input=false
terraform validate

cat > "$WORK_DIR/main.tfvars" <<EOF
bucket_name              = "umoja-release-evidence-validation-123456"
retention_days           = 30
github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
github_repository        = "munisp/UmojaFlowOS"
github_environment       = "production-release-evidence"
prefix                   = "umoja/releases"
EOF
terraform plan -input=false -refresh=false -var-file="$WORK_DIR/main.tfvars" -out="$WORK_DIR/plan.tfplan"
terraform show -json "$WORK_DIR/plan.tfplan" > "$WORK_DIR/plan.json"

python3 - "$WORK_DIR/plan.json" <<'PY'
import json
import sys
plan = json.load(open(sys.argv[1], encoding="utf-8"))
resources = {r["address"]: r for r in plan["planned_values"].get("root_module", {}).get("resources", [])}
required = {
    "aws_s3_bucket.evidence",
    "aws_s3_bucket_versioning.evidence",
    "aws_s3_bucket_object_lock_configuration.evidence",
    "aws_s3_bucket_public_access_block.evidence",
    "aws_s3_bucket_server_side_encryption_configuration.evidence",
    "aws_iam_role.publisher",
    "aws_iam_role_policy.publisher",
}
missing = sorted(required - resources.keys())
if missing:
    raise SystemExit(f"missing planned security resources: {missing}")
bucket = resources["aws_s3_bucket.evidence"]["values"]
if bucket.get("object_lock_enabled") is not True or bucket.get("force_destroy") is not False:
    raise SystemExit("bucket must enable Object Lock and disable force_destroy")
print("terraform WORM module policy checks: PASSED")
PY
printf 'release-evidence-worm Terraform preflight: PASSED\n'
