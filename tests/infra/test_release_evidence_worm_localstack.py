from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from botocore.exceptions import ClientError


@pytest.mark.integration
@pytest.mark.skipif(not os.getenv("LOCALSTACK_URL"), reason="set LOCALSTACK_URL to run the LocalStack integration")
def test_object_lock_compliance_and_delete_denial(tmp_path):
    endpoint = os.environ["LOCALSTACK_URL"]
    region = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY", "test"),
    )
    bucket = f"umoja-worm-{uuid.uuid4().hex[:20]}"
    key = "umoja/releases/test-sha/test-run/E-01/report.json"
    body = b'{"release_sha":"' + (b"a" * 40) + b'","result":"pass"}\n'
    retain_until = datetime.now(timezone.utc) + timedelta(days=1)

    s3.create_bucket(Bucket=bucket, ObjectLockEnabledForBucket=True)
    s3.put_bucket_versioning(Bucket=bucket, VersioningConfiguration={"Status": "Enabled"})
    s3.put_object_lock_configuration(
        Bucket=bucket,
        ObjectLockConfiguration={
            "ObjectLockEnabled": "Enabled",
            "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Days": 1}},
        },
    )
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json",
        ServerSideEncryption="AES256",
        ObjectLockMode="COMPLIANCE",
        ObjectLockRetainUntilDate=retain_until,
        Metadata={"release-sha": "a" * 40, "run-id": "test-run"},
    )

    lock = s3.get_object_lock_configuration(Bucket=bucket)
    assert lock["ObjectLockConfiguration"]["ObjectLockEnabled"] == "Enabled"
    assert lock["ObjectLockConfiguration"]["Rule"]["DefaultRetention"]["Mode"] == "COMPLIANCE"

    head = s3.head_object(Bucket=bucket, Key=key)
    assert head["ObjectLockMode"] == "COMPLIANCE"
    assert head["ObjectLockRetainUntilDate"] >= retain_until - timedelta(seconds=5)
    assert head["Metadata"]["release-sha"] == "a" * 40
    assert hashlib.sha256(body).hexdigest() == hashlib.sha256(s3.get_object(Bucket=bucket, Key=key)["Body"].read()).hexdigest()

    with pytest.raises(ClientError) as error:
        s3.delete_object(Bucket=bucket, Key=key)
    assert error.value.response["Error"]["Code"] in {"AccessDenied", "InvalidRequest"}
