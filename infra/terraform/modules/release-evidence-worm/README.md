# Release evidence WORM module

This module provisions a versioned S3 bucket with Object Lock `COMPLIANCE` retention and a GitHub Actions OIDC publisher role. It does not create signing keys, approver identities, or release evidence.

## Example

```hcl
module "release_evidence_worm" {
  source = "../../modules/release-evidence-worm"

  bucket_name               = "umoja-release-evidence-prod-<unique-suffix>"
  retention_days            = 2555
  github_oidc_provider_arn  = "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
  github_repository         = "munisp/UmojaFlowOS"
  github_environment        = "production-release-evidence"
  prefix                    = "umoja/releases"
  tags = {
    system  = "UmojaFlowOS"
    purpose = "release-evidence"
  }
}
```

The OIDC trust policy is restricted to the exact repository and protected GitHub environment. The publisher role can list only the configured prefix and can put/get/head objects below that prefix; it cannot delete objects, alter retention, change bucket policy, or manage credentials.

## Apply and verify

Use a separately controlled infrastructure runner with AWS credentials allowed to manage the bucket and IAM resources:

```bash
terraform init
terraform plan -out=tfplan
terraform apply tfplan

aws s3api get-object-lock-configuration \
  --bucket "$(terraform output -raw bucket_name)"
aws s3api get-bucket-versioning \
  --bucket "$(terraform output -raw bucket_name)"
aws iam get-role \
  --role-name umoja-release-evidence-publisher
```

The output must show versioning enabled and a default `COMPLIANCE` retention rule. Confirm the trust policy subject is exactly `repo:munisp/UmojaFlowOS:environment:production-release-evidence` and the audience is `sts.amazonaws.com`.

Set these GitHub environment variables for the reusable workflow:

```text
UMOJA_EVIDENCE_PUBLISH_ROLE_ARN
UMOJA_EVIDENCE_AWS_REGION
UMOJA_EVIDENCE_WORM_BUCKET
```

The workflow must receive the full release SHA, run ID, evidence root, and retention deadline from a protected release job. Never accept the bucket, role, or retention policy from an untrusted pull request.

Object Lock compliance retention is intentionally difficult or impossible to shorten before expiry. Validate the retention period and legal-hold policy before applying the module.
