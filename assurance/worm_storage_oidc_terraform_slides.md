# UmojaFlowOS WORM Evidence and Release Infrastructure

## Cover

**WORM Evidence Storage, OIDC Security, and Terraform Preflight**

UmojaFlowOS staging release assurance

## Slide 1 — The release-evidence control plane

- Evidence is generated in an approved staging environment.
- Strict schema validation runs before publication.
- The immutable release SHA binds source, image, provenance, and manifest.
- WORM storage preserves the reviewed bundle for the retention period.

## Slide 2 — Evidence flow is deliberately fail-closed

```text
staging runners
    ↓
E-01–E-09 reports and sidecars
    ↓
strict schema validator
    ↓
semantic release verifier
    ↓
four independent approvals
    ↓
OIDC-authenticated publisher
    ↓
S3 Object Lock COMPLIANCE
    ↓
post-upload digest and retention verification
```

A missing artifact, digest mismatch, invalid approval, or storage-policy failure stops publication and keeps the release NO-GO.

## Slide 3 — WORM storage architecture

- Bucket versioning is enabled before Object Lock configuration.
- Default retention uses `COMPLIANCE` mode.
- Evidence is stored under an immutable `<release-sha>/<run-id>` prefix.
- Public access is blocked and insecure transport is denied.
- The publisher cannot delete objects or shorten retention.

## Slide 4 — GitHub OIDC trust boundary

- The workflow requests an OIDC token with `id-token: write`.
- AWS trusts only the GitHub OIDC provider and `sts.amazonaws.com` audience.
- The subject is restricted to `repo:munisp/UmojaFlowOS:environment:production-release-evidence`.
- The session is short-lived and scoped to the evidence publisher role.
- Pull requests cannot select the production bucket, role, or retention policy.

## Slide 5 — Least-privilege publisher role

| Permission | Scope |
|---|---|
| `s3:ListBucket` | `umoja/releases/*` prefix only |
| `s3:PutObject` | Evidence prefix only |
| `s3:GetObject` | Evidence prefix only |
| `s3:HeadObject` | Evidence prefix only |
| Delete and retention mutation | Not granted |
| IAM, bucket policy, infrastructure mutation | Not granted |

## Slide 6 — Terraform preflight pipeline

- Pull requests run format, backend-free initialization, validation, plan, and policy assertions.
- Manual staging apply is a separate job behind a protected environment.
- The apply job requires `APPLY_APPROVED_STAGING_WORM_IAC`.
- Post-apply checks confirm versioning and `COMPLIANCE` Object Lock.
- Terraform state and AWS credentials remain outside pull-request execution.

## Slide 7 — Local WORM integration test

- LocalStack emulates S3 for a disposable test.
- The test creates a versioned Object Lock bucket.
- It uploads a retained object with release/run metadata.
- It reads Object Lock mode and retention timestamp.
- It downloads the object and compares content digest.
- It attempts deletion and requires an access-denied or invalid-request response.

## Slide 8 — OIDC testing boundaries

- `act` can test workflow branching and shell behavior, but cannot produce a genuine GitHub OIDC token by default.
- A real OIDC trust test requires an ephemeral AWS account or isolated staging account.
- The test repository/environment, audience, and subject must be exact.
- Use a short-lived role and a disposable bucket with a short approved retention period.
- Revoke the test role and destroy only non-locked test infrastructure after evidence capture.

## Slide 9 — Operational release gate

1. Run the PR contract workflow.
2. Run Terraform preflight and review the plan.
3. Apply only from the protected staging environment.
4. Execute E-01–E-09 staging runners.
5. Publish the bundle through OIDC to Object Lock storage.
6. Verify digests, retention, metadata, and manifest integrity.
7. Obtain four independent approvals.
8. Preserve the bundle and release the decision only after all checks pass.

## Slide 10 — Decision status

- Local schema, verifier, WORM-shell, and workflow tests are contract evidence only.
- A LocalStack pass does not prove AWS Object Lock behavior or staging identity trust.
- A green Terraform plan does not prove an applied staging environment.
- Production remains **NO-GO** until real E-01–E-09 artifacts, Object Lock metadata, cryptographic provenance, and independent approvals exist.
