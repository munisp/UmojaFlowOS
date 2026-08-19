"""S3-compatible immutable bronze writer for approved analytics evidence.

The lakehouse is an analytics and model-training projection. PostgreSQL keeps
the operational truth, TigerBeetle keeps double-entry facts, and this writer
never accepts raw document material, account numbers, credentials, or customer
names. Objects are keyed by their canonical payload digest and created with a
conditional put so retry cannot overwrite previously recorded evidence.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from hashlib import sha256
from ipaddress import ip_address
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from .lakehouse import BatchManifest, LakehouseContractError, build_bronze_manifest

APPROVED_DATASETS = {
    "payment-lifecycle-evidence",
    "compliance-decision-evidence",
    "service-health",
    "treasury-alerts",
    "geospatial-aggregates",
}
FORBIDDEN_KEY = re.compile(r"(?:secret|token|password|document_bytes|base64|account_number|wallet_address|customer_name|latitude|longitude)", re.I)


class LakehouseUnavailable(RuntimeError):
    pass


def _loopback(hostname: str | None) -> bool:
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return True
    if not hostname:
        return False
    try:
        return ip_address(hostname).is_loopback
    except ValueError:
        return False


def _walk_no_forbidden(value: object) -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            if not isinstance(key, str) or FORBIDDEN_KEY.search(key):
                raise LakehouseContractError("lakehouse evidence contains an unapproved identifying, credential, or raw-location field")
            _walk_no_forbidden(nested)
    elif isinstance(value, list):
        for nested in value:
            _walk_no_forbidden(nested)


@dataclass(frozen=True)
class LakehouseConfig:
    endpoint_url: str
    bucket: str
    access_key_id: str
    secret_access_key: str
    region_name: str = "us-east-1"
    allow_insecure_loopback: bool = False

    def validate(self) -> None:
        parsed = urlparse(self.endpoint_url)
        if not parsed.scheme or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise LakehouseUnavailable("lakehouse endpoint must be an absolute credential-free URL")
        if parsed.scheme == "https":
            pass
        elif parsed.scheme == "http" and self.allow_insecure_loopback and _loopback(parsed.hostname):
            pass
        elif parsed.scheme == "http" and not self.allow_insecure_loopback:
            raise LakehouseUnavailable("lakehouse plaintext transport requires the explicit loopback exemption")
        else:
            raise LakehouseUnavailable("lakehouse plaintext transport is permitted on loopback only")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", self.bucket):
            raise LakehouseUnavailable("lakehouse bucket name is invalid")
        if not self.access_key_id or not self.secret_access_key:
            raise LakehouseUnavailable("lakehouse deployment credentials are required")


class BronzeLakehouseWriter:
    def __init__(self, config: LakehouseConfig) -> None:
        config.validate()
        self._config = config
        self._client = boto3.client(
            "s3",
            endpoint_url=config.endpoint_url,
            aws_access_key_id=config.access_key_id,
            aws_secret_access_key=config.secret_access_key,
            region_name=config.region_name,
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 2, "mode": "standard"},
                s3={"addressing_style": "path"},
            ),
        )

    @staticmethod
    def prepare(dataset: str, records: Sequence[Mapping[str, object]], schema_version: str = "v1") -> tuple[BatchManifest, bytes, str]:
        if dataset not in APPROVED_DATASETS:
            raise LakehouseContractError("lakehouse dataset is not approved")
        for record in records:
            _walk_no_forbidden(record)
        manifest = build_bronze_manifest(dataset, records, schema_version)
        payload = b"".join(
            json.dumps(dict(record), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8") + b"\n"
            for record in records
        )
        # The manifest digest intentionally covers the canonical records array,
        # whereas object bytes are newline-delimited JSON for incremental reads.
        # Both are recorded so a reader can verify the object stream separately.
        object_digest = sha256(payload).hexdigest()
        return manifest, payload, object_digest

    def write(self, dataset: str, records: Sequence[Mapping[str, object]], schema_version: str = "v1") -> tuple[BatchManifest, str, str]:
        manifest, payload, object_digest = self.prepare(dataset, records, schema_version)
        key = f"bronze/{dataset}/{manifest.schema_version}/{manifest.payload_sha256}.jsonl"
        metadata = {"manifest-sha256": manifest.payload_sha256, "object-sha256": object_digest, "record-count": str(manifest.record_count)}
        try:
            self._client.put_object(
                Bucket=self._config.bucket,
                Key=key,
                Body=payload,
                ContentType="application/x-ndjson",
                Metadata=metadata,
                IfNoneMatch="*",
            )
            return manifest, key, "created"
        except ClientError as exc:
            if exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") not in {409, 412}:
                raise LakehouseUnavailable("lakehouse write failed") from exc
        except BotoCoreError as exc:
            raise LakehouseUnavailable("lakehouse endpoint is unavailable") from exc

        try:
            existing = self._client.get_object(Bucket=self._config.bucket, Key=key)
            existing_payload = existing["Body"].read()
            if sha256(existing_payload).hexdigest() != object_digest or existing.get("Metadata", {}).get("manifest-sha256") != manifest.payload_sha256:
                raise LakehouseUnavailable("lakehouse immutable object conflict: existing evidence differs")
            return manifest, key, "duplicate"
        except (BotoCoreError, ClientError, KeyError) as exc:
            if isinstance(exc, LakehouseUnavailable):
                raise
            raise LakehouseUnavailable("lakehouse duplicate could not be verified") from exc

    def presigned_read_url(self, key: str, expires_seconds: int = 900) -> str:
        if not 60 <= expires_seconds <= 3600:
            raise LakehouseUnavailable("lakehouse signed URL expiry must be between one minute and one hour")
        try:
            return str(self._client.generate_presigned_url("get_object", Params={"Bucket": self._config.bucket, "Key": key}, ExpiresIn=expires_seconds))
        except BotoCoreError as exc:
            raise LakehouseUnavailable("could not create lakehouse signed URL") from exc
