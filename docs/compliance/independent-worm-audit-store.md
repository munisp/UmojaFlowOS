# UmojaFlowOS Independent WORM Store and Cryptographic Audit-Immutability Guide

> **Scope.** This guide is a staging design and verification runbook. It does not declare a regulatory retention period, a CBN approval, or an immutable audit log already in existence. Select retention, legal-hold, key-management, residency, and access-review rules with Nigerian regulatory counsel, records management, and the accountable regulated entity.

## 1. Security objective and architecture

The current readiness-assurance register has valid lifecycle constraints and separation of duties, but it is not by itself an independent WORM archive. The independent design must prevent an application operator, database operator, deployment administrator, or evidence submitter from silently rewriting the exported audit history.

| Plane | Responsibility | Must not be held by |
|---|---|---|
| **Umoja application / PostgreSQL** | Emits canonical audit events and periodic signed batches. | WORM retention administrator. |
| **Audit publisher identity** | Writes new immutable objects only; cannot delete, list unrelated evidence, change retention, or set legal holds. | Database superuser or CI deployer. |
| **WORM storage administration** | Creates locked bucket and default compliance retention; manages legal holds under controlled process. | Application, publisher, or evidence submitter. |
| **Independent verifier** | Reads exact object versions, lock metadata, signatures, and digest chain; records verification outcome. | Publisher or storage administrator. |
| **Key custodian / HSM authority** | Controls signing key lifecycle and public-key distribution. | Publisher process runtime. |

The recommended implementation is a dedicated, independently administered **S3-compatible object-lock account/tenant** in a separate security boundary from staging. It can be self-managed MinIO AIStor in a dedicated tenant or a managed S3-compatible WORM service. The staging application has a write-only publisher identity; the auditor has a read-and-retention-inspection identity; neither has retention-administration or deletion authority.

## 2. Two viable WORM deployment options

| Option | When to choose it | Advantages | Residual controls required |
|---|---|---|---|
| **A. Dedicated MinIO AIStor tenant, S3-compatible Object Lock** | Sovereignty, private networking, or open-source/cloud-agnostic operations are required. | Separate tenant, S3-compatible API, versioning, COMPLIANCE retention, legal holds, and operator-controlled NTP. | Independent cluster administration, offsite replica, secure time, HSM/KMS, quarterly restore exercise. |
| **B. Managed Amazon S3 Object Lock, separate account** | A managed regional archive and a separate cloud account are acceptable. | Object Lock, compliance retention, legal holds, key policy separation, inventory and cross-account audit controls. | Separate account/organisation controls, KMS key survivability, retention policy, external access review. |

**Recommendation.** Use **Option A** if the regulated entity requires data sovereignty and can operate a separately administered storage boundary; use **Option B** if a separately governed managed account and cross-account controls are available. In either design, select **COMPLIANCE** rather than GOVERNANCE mode for final audit batches: governance retention can be bypassed by an authorised principal, whereas compliance retention is intended to prevent modification before expiry.[1] [2]

## 3. Canonical audit-batch format

Export immutable audit data as canonical JSON Lines plus a separately signed manifest. Do not rely on mutable CI logs, browser console logs, a database backup, or a single application table.

```json
{
  "format": "umoja-audit-batch/v1",
  "environment": "staging",
  "sequence": 42,
  "period_start": "2026-08-25T00:00:00Z",
  "period_end": "2026-08-25T00:15:00Z",
  "event_count": 184,
  "previous_batch_sha256": "<64-lowercase-hex-or-genesis>",
  "events_sha256": "<sha256-of-canonical-jsonl>",
  "batch_sha256": "<sha256-of-canonical-manifest-without-signature>",
  "signing_key_id": "audit-batch-ed25519-2026-q3",
  "signed_at": "2026-08-25T00:15:04Z",
  "signature_base64": "<detached-signature-over-batch_sha256>"
}
```

The publisher must serialize each event deterministically, with an immutable event ID, UTC timestamp, actor subject, action, target, before/after digest, request/correlation ID, and prior-event/batch reference. Sign the batch digest with an HSM- or KMS-protected asymmetric key, such as Ed25519 or ECDSA P-256; the verifier must hold the pinned public key. An HMAC does not provide independence because a party that can sign can also forge a replacement history.

## 4. Option A: dedicated MinIO AIStor configuration

The MinIO documentation states that object locking requires versioning, supports COMPLIANCE and GOVERNANCE modes, and supports legal holds. COMPLIANCE mode prevents retention modification by all users, including root, until expiry.[1]

### 4.1 Create a separate tenant and time boundary

1. Deploy a separate MinIO AIStor tenant/account with a different administrative team, network segment, and identity provider from Umoja staging.
2. Configure trusted NTP for the storage service (`MINIO_NTP_SERVER`) and monitor time drift; retention dates are only as trustworthy as the time source.[1]
3. Configure a dedicated TLS endpoint, for example `https://audit-worm.staging-regulated.example`, with no public anonymous access.

### 4.2 Create the immutable bucket and default retention

Run these commands **only as the independent storage administrator**, after the retention period has been approved:

```bash
export WORM_ALIAS='staging-worm'
export WORM_BUCKET='umoja-staging-audit-worm'

# Configure an already authenticated CLI alias using administrator-provided credentials.
mc alias set "$WORM_ALIAS" https://audit-worm.staging-regulated.example "$MINIO_ADMIN_ACCESS_KEY" "$MINIO_ADMIN_SECRET_KEY"

# Object lock enables versioning for this bucket.
mc mb --with-lock "$WORM_ALIAS/$WORM_BUCKET"

# Example only: set the approved default COMPLIANCE retention period.
# Replace 7y only after records-management approval.
mc retention set --recursive --default COMPLIANCE 7y "$WORM_ALIAS/$WORM_BUCKET"

# Record the configuration as controlled evidence.
mc retention info "$WORM_ALIAS/$WORM_BUCKET"
mc version info "$WORM_ALIAS/$WORM_BUCKET"
```

Use an approved **legal-hold** process for a specific audit version subject to investigation; a legal hold is indefinite until an authorised custodian lifts it.[1]

```bash
# Use the exact version ID returned from an object listing; do not apply blanket holds.
mc legalhold set "$WORM_ALIAS/$WORM_BUCKET/staging/2026/08/25/batch-000042.jsonl"
```

### 4.3 Identities and permissions

Create three distinct policies and service identities through the storage administrator’s normal IAM process.

| Identity | Allowed actions | Explicitly deny |
|---|---|---|
| `umoja-audit-publisher` | `PutObject` to `staging/*`; multipart upload completion if required. | Delete, `PutObjectRetention`, legal hold, bucket policy, user/policy administration, retention bypass. |
| `umoja-audit-verifier` | Read exact object versions, `GetObjectRetention`, `GetObjectLegalHold`, list only `staging/*`. | Write, delete, retention changes, legal-hold changes, identity administration. |
| `worm-retention-custodian` | Bucket creation, default retention, legal hold under dual approval. | Application/database administration. |

Do not give the staging Compose service, GitHub Actions workflow, database superuser, or control-plane administrator the retention-custodian credential.

## 5. Option B: managed Amazon S3 Object Lock configuration

Amazon S3 Object Lock cannot be disabled after it is enabled on a bucket; it requires versioning. Head/Get Object can return retention and legal-hold metadata to a principal with the appropriate read permissions.[2]

Run as the **separate-account WORM administrator**, not as the Umoja deployment role:

```bash
export AWS_REGION='APPROVED_REGION'
export WORM_BUCKET='umoja-staging-audit-worm-UNIQUE-SUFFIX'

aws s3api create-bucket \
  --bucket "$WORM_BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration "LocationConstraint=$AWS_REGION" \
  --object-lock-enabled-for-bucket

aws s3api put-object-lock-configuration \
  --bucket "$WORM_BUCKET" \
  --object-lock-configuration 'ObjectLockEnabled=Enabled,Rule={DefaultRetention={Mode=COMPLIANCE,Years=7}}'

aws s3api get-object-lock-configuration --bucket "$WORM_BUCKET"
```

Use a separate account/role for retention and key administration. The publisher role needs only object creation under its prefix; do not grant `s3:DeleteObjectVersion`, `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, or `s3:BypassGovernanceRetention`. The verifier role needs `s3:GetObject`, `s3:GetObjectRetention`, `s3:GetObjectLegalHold`, and restricted list permission. Configure encryption keys so the application cannot schedule their deletion; Object Lock does not protect availability if encryption keys are destroyed.[2]

## 6. Publisher configuration contract

Add these non-secret values through approved staging configuration, and inject only the publisher credential through the managed secret service:

```dotenv
UMOJA_AUDIT_WORM_ENABLED=true
UMOJA_AUDIT_WORM_ENDPOINT=https://audit-worm.staging-regulated.example
UMOJA_AUDIT_WORM_BUCKET=umoja-staging-audit-worm
UMOJA_AUDIT_WORM_PREFIX=staging
UMOJA_AUDIT_WORM_MODE=COMPLIANCE
UMOJA_AUDIT_WORM_SIGNING_KEY_REFERENCE=file:///run/umoja-secrets/audit-signing-key
UMOJA_AUDIT_WORM_PUBLIC_KEY_REFERENCE=https://evidence.example/keys/audit-batch-ed25519-2026-q3.pub
UMOJA_AUDIT_WORM_BATCH_INTERVAL_SECONDS=900
```

The publisher must fail closed: if the WORM endpoint, mTLS, signing key, clock, object-lock response, or write acknowledgment is unavailable, it must raise a monitored incident and preserve the source audit queue for recovery. It must never silently continue with an unsigned local-only log.

## 7. Cryptographic verification procedure

### 7.1 Verify a received batch locally

```bash
set -eu
export OBJECT_KEY='staging/2026/08/25/batch-000042.jsonl'
export MANIFEST_KEY='staging/2026/08/25/batch-000042.manifest.json'

# Fetch exact immutable versions using the verifier identity. Preserve returned VersionIds.
mc stat --json "$WORM_ALIAS/$WORM_BUCKET/$OBJECT_KEY" > object-stat.json
mc stat --json "$WORM_ALIAS/$WORM_BUCKET/$MANIFEST_KEY" > manifest-stat.json
mc cp "$WORM_ALIAS/$WORM_BUCKET/$OBJECT_KEY" ./batch-000042.jsonl
mc cp "$WORM_ALIAS/$WORM_BUCKET/$MANIFEST_KEY" ./batch-000042.manifest.json

# Recalculate payload digest and compare to manifest fields.
sha256sum ./batch-000042.jsonl
jq -r '.events_sha256, .previous_batch_sha256, .batch_sha256, .signing_key_id' ./batch-000042.manifest.json

# Verify a detached signature using the pinned public key; exact command depends on the approved signing implementation.
# Example for an Ed25519 implementation that writes a detached signature file:
openssl pkeyutl -verify -pubin -inkey audit-batch-public.pem \
  -rawin -in batch-sha256.txt -sigfile batch-000042.signature
```

For S3, inspect version-specific retention and legal hold:

```bash
aws s3api head-object --bucket "$WORM_BUCKET" --key "$OBJECT_KEY" --version-id 'VERSION_ID_FROM_HEAD_OR_LIST'
aws s3api get-object-retention --bucket "$WORM_BUCKET" --key "$OBJECT_KEY" --version-id 'VERSION_ID_FROM_HEAD_OR_LIST'
aws s3api get-object-legal-hold --bucket "$WORM_BUCKET" --key "$OBJECT_KEY" --version-id 'VERSION_ID_FROM_HEAD_OR_LIST'
```

The verifier must confirm all of the following before signing an assurance record:

1. The returned version ID is recorded in the batch manifest/workpaper.
2. Object lock mode is `COMPLIANCE`, and `RetainUntilDate` satisfies the approved policy.
3. The recomputed JSONL hash equals `events_sha256`.
4. The manifest batch hash recomputes under the approved canonicalization rule.
5. The detached asymmetric signature verifies against the pinned public key and declared key ID.
6. `previous_batch_sha256` equals the preceding independently verified batch digest, or equals the approved genesis value.
7. The object path/sequence has no unexplained gap, duplicate, or timestamp regression.

### 7.2 Controlled negative test

Perform this only in a dedicated staging test prefix with an approved change record; never target an operational evidence object.

1. Upload a synthetic `worm-negative-test` batch with COMPLIANCE retention.
2. Capture the object version ID, retention mode, retain-until date, SHA-256, and signature verification result.
3. Attempt a version-specific delete with a principal that has no WORM-bypass capability.
4. Expect a retention/AccessDenied failure; record the error body and object still present after the attempt.
5. Verify no publisher, verifier, CI, database, or deployment role can shorten retention or clear a legal hold.

A successful failed-delete test demonstrates storage enforcement only; it does not prove the completeness or truthfulness of application events.

## 8. Audit evidence and monitoring

Create a daily immutable inventory/manifest in the same WORM domain and independently reconcile it against the publisher sequence. Alert on:

- missing sequence numbers or broken `previous_batch_sha256` links;
- signature/key-ID verification failure;
- object write without COMPLIANCE retention;
- retention less than approved policy;
- system/NTP time drift; and
- publisher queue growth or failed WORM upload.

Store WORM configuration output, policy review, key attestation, verifier workpapers, and negative-test results as separate locked evidence objects. Schedule a quarterly restore/read exercise and at least annual key-rotation verification.

## References

[1]: https://docs.min.io/aistor/administration/object-locking-and-immutability/ "MinIO AIStor Object Locking and Immutability"
[2]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html "Amazon S3 Object Lock considerations"
