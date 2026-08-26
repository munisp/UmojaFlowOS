# WORM evidence incident response

## Trigger conditions

Treat any of these as a release-blocking evidence incident:

| Trigger | Meaning |
|---|---|
| Strict schema validation failure | The manifest is not an accepted release contract; custom fields or malformed values are present |
| Artifact SHA-256 mismatch | The uploaded object differs from the digest declared in the manifest |
| Missing or empty object | Evidence is incomplete or the upload was interrupted |
| Missing Object Lock metadata | The object is not protected by the required retention mode |
| Retention timestamp too short | The object can expire before the approved evidence-retention date |
| Release/run metadata mismatch | The object may belong to another release or execution |
| Upload/API failure | The evidence bundle is incomplete and must not be approved |

The GitHub job must fail closed. A notification failure must never turn the original publication failure into a success.

## Immediate containment

1. Stop the release promotion and mark the release decision `NO-GO`.
2. Do not delete, overwrite, shorten retention, or force-replace any object in the WORM prefix. Preserve versions and Object Lock metadata.
3. Disable the evidence publication workflow environment approval until the incident owner authorizes a controlled investigation.
4. Record the workflow run URL, release SHA, run ID, bucket, prefix, failing E-item, failing object key, computed digest, declared digest, and Object Lock response.
5. Notify the release manager, security owner, compliance owner, and operations owner through the configured incident channel. If the webhook fails, escalate through the secondary on-call path.

## Invalid manifest procedure

For a schema failure, retain the original manifest and its digest as incident evidence. Copy it to a separate quarantine prefix only if the storage policy permits a new immutable object; do not alter the original:

```text
umoja/quarantine/<release-sha>/<run-id>/<incident-id>/original-release.json
```

Run the strict validator against the quarantined copy and capture its complete output. Identify whether the cause is an unknown custom field, missing required field, wrong type, invalid SHA, duplicate E-item, duplicate role, or release-SHA mismatch. Correct the source generator or manifest in a new release-evidence run; never edit an already approved manifest in place.

## Corrupted or mismatched object procedure

For an SHA mismatch or size mismatch:

1. Freeze the release and all downstream approvals.
2. Record the expected digest from the manifest and recompute the digest from the local pre-upload artifact.
3. Retrieve the object metadata and version ID without deleting or overwriting the object.
4. Compare the local artifact, uploaded object, manifest, `SHA256SUMS`, release SHA, and run ID.
5. Preserve all comparison output in the incident prefix with a new incident ID and the same WORM retention policy.
6. Determine whether corruption occurred before upload, during artifact transfer, through an incorrect manifest digest, or through a wrong release/run prefix.
7. Generate a new evidence bundle and new immutable prefix after the root cause is corrected.
8. Obtain fresh independent reviews and approvals for the new bundle; old approvals do not transfer.

Example metadata inspection:

```bash
aws s3api head-object --bucket "$BUCKET" --key "$KEY" > object-head.json
aws s3api get-object --bucket "$BUCKET" --key "$KEY" object-copy
sha256sum object-copy
jq '{VersionId,ContentLength,Metadata,ObjectLockMode,ObjectLockRetainUntilDate,ETag}' object-head.json
```

The S3 ETag must not be used as a SHA-256 substitute, especially for multipart uploads or encrypted objects.

## Recovery and closure

The incident owner may close the incident only after the new run has a clean schema result, matching SHA-256 digests, COMPLIANCE Object Lock metadata, retention dates at or beyond policy, correct release/run metadata, successful manifest verification, and four fresh independent approvals. Security and compliance owners must review the incident record and explicitly approve reopening the release gate.

## Monitoring and alert routing

The WORM workflow emits a failed GitHub Check and posts a structured event to `RELEASE_ALERT_WEBHOOK_URL` when configured. Route that endpoint to the organization’s incident gateway, which should map `umoja_release_evidence_worm_failure` to a high-priority incident and preserve the release SHA/run ID as correlation fields. The alert receiver must authenticate the webhook, rate-limit repeated events, and retain delivery receipts. PagerDuty, Wazuh, or Alertmanager may be used behind that gateway; none should be treated as a substitute for the failed GitHub Check or the WORM metadata verification.
