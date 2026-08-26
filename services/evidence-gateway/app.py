from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import boto3
import httpx
import jwt
from botocore.exceptions import ClientError
from fastapi import FastAPI, Header, HTTPException, Request
from jwt.algorithms import RSAAlgorithm

SHA_RE = re.compile(r"^[a-f0-9]{40}$")
RUN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PATH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$")


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"required configuration is missing: {name}")
    return value


def load_mapping() -> dict[str, Any]:
    path = Path(required("RELEASE_MAPPING_FILE"))
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"release mapping cannot be loaded: {path}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("releases"), dict):
        raise RuntimeError("release mapping must contain an object named releases")
    for release_sha, release in data["releases"].items():
        if not SHA_RE.fullmatch(release_sha) or not isinstance(release, dict):
            raise RuntimeError("release mapping contains an invalid release entry")
        if release.get("status") != "active":
            continue
        prefix = release.get("prefix")
        if not isinstance(prefix, str) or not prefix or prefix.startswith("/") or ".." in prefix.split("/"):
            raise RuntimeError("active release mapping contains an unsafe prefix")
    return data


class Settings:
    issuer: str
    audience: str
    role: str
    jwks_url: str
    bucket: str
    prefix: str
    retention_days: int
    mapping: dict[str, Any]
    s3: Any

    def __init__(self) -> None:
        self.issuer = required("OIDC_ISSUER").rstrip("/")
        self.audience = required("OIDC_AUDIENCE")
        self.role = required("OIDC_REQUIRED_ROLE")
        self.jwks_url = os.getenv("OIDC_JWKS_URL", f"{self.issuer}/protocol/openid-connect/certs")
        self.bucket = required("S3_BUCKET")
        self.prefix = required("S3_PREFIX").strip("/")
        self.retention_days = int(os.getenv("S3_RETENTION_DAYS", "1"))
        if self.retention_days < 1:
            raise RuntimeError("S3_RETENTION_DAYS must be at least 1")
        self.mapping = load_mapping()
        self.s3 = boto3.client(
            "s3",
            endpoint_url=os.getenv("S3_ENDPOINT_URL") or None,
            region_name=os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
            aws_access_key_id=required("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=required("AWS_SECRET_ACCESS_KEY"),
        )
        self.ensure_bucket = os.getenv("ENSURE_BUCKET_CONFIG", "false").lower() == "true"

    def initialize_bucket(self) -> None:
        if not self.ensure_bucket:
            return
        try:
            self.s3.head_bucket(Bucket=self.bucket)
        except ClientError:
            self.s3.create_bucket(Bucket=self.bucket, ObjectLockEnabledForBucket=True)
        self.s3.put_bucket_versioning(Bucket=self.bucket, VersioningConfiguration={"Status": "Enabled"})
        self.s3.put_object_lock_configuration(
            Bucket=self.bucket,
            ObjectLockConfiguration={
                "ObjectLockEnabled": "Enabled",
                "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Days": self.retention_days}},
            },
        )

    def release(self, release_sha: str, run_id: str) -> str:
        item = self.mapping["releases"].get(release_sha)
        if not isinstance(item, dict) or item.get("status") != "active":
            raise HTTPException(status_code=403, detail="release SHA is not active in server-side mapping")
        allowed_run = item.get("run_id")
        if allowed_run != run_id:
            raise HTTPException(status_code=403, detail="run ID is not bound to release SHA")
        configured = item.get("prefix")
        if not isinstance(configured, str) or configured.strip("/") != self.prefix:
            raise HTTPException(status_code=403, detail="release prefix mapping is not configured for this gateway")
        return configured.strip("/")


class JwksValidator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.keys: dict[str, Any] = {}

    def _load(self) -> None:
        response = httpx.get(self.settings.jwks_url, timeout=5.0)
        response.raise_for_status()
        keys = response.json().get("keys", [])
        self.keys = {key["kid"]: RSAAlgorithm.from_jwk(json.dumps(key)) for key in keys if key.get("kid")}
        if not self.keys:
            raise RuntimeError("Keycloak JWKS did not contain usable keys")

    def decode(self, token: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as exc:
            raise HTTPException(status_code=401, detail="invalid JWT header") from exc
        if header.get("alg") != "RS256" or not header.get("kid"):
            raise HTTPException(status_code=401, detail="JWT must use RS256 with a key ID")
        if header["kid"] not in self.keys:
            self._load()
        key = self.keys.get(header["kid"])
        if key is None:
            raise HTTPException(status_code=401, detail="JWT key is not trusted")
        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=["RS256"],
                audience=self.settings.audience,
                issuer=self.settings.issuer,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
                leeway=5,
            )
        except jwt.InvalidTokenError as exc:
            raise HTTPException(status_code=401, detail="JWT validation failed") from exc
        roles = set(claims.get("realm_access", {}).get("roles", []))
        roles.update(claims.get("resource_access", {}).get(self.settings.audience, {}).get("roles", []))
        if self.settings.role not in roles:
            raise HTTPException(status_code=403, detail="required evidence role is missing")
        if claims.get("evidence_release_sha") and not SHA_RE.fullmatch(claims["evidence_release_sha"]):
            raise HTTPException(status_code=403, detail="JWT release claim is malformed")
        return claims


app = FastAPI(title="Umoja Evidence Gateway", version="1.0.0")
settings: Settings | None = None
validator: JwksValidator | None = None


@app.on_event("startup")
def startup() -> None:
    global settings, validator
    settings = Settings()
    settings.initialize_bucket()
    validator = JwksValidator(settings)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    if settings is None or validator is None:
        raise HTTPException(status_code=503, detail="gateway is not initialized")
    return {"status": "ok"}


@app.put("/v1/evidence/{release_sha}/{run_id}/{object_path:path}")
async def put_evidence(
    release_sha: str,
    run_id: str,
    object_path: str,
    request: Request,
    authorization: str | None = Header(default=None),
    x_evidence_sha256: str | None = Header(default=None),
) -> dict[str, str]:
    if settings is None or validator is None:
        raise HTTPException(status_code=503, detail="gateway is not initialized")
    if not SHA_RE.fullmatch(release_sha) or not RUN_RE.fullmatch(run_id) or not PATH_RE.fullmatch(object_path):
        raise HTTPException(status_code=400, detail="invalid release, run, or object path")
    if ".." in object_path.split("/") or object_path.startswith("/"):
        raise HTTPException(status_code=400, detail="object path traversal is forbidden")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="bearer token is required")
    claims = validator.decode(authorization[7:].strip())
    if claims.get("evidence_release_sha") and claims.get("evidence_release_sha") != release_sha:
        raise HTTPException(status_code=403, detail="JWT release binding does not match request")
    if claims.get("evidence_run_id") and claims.get("evidence_run_id") != run_id:
        raise HTTPException(status_code=403, detail="JWT run binding does not match request")
    configured_prefix = settings.release(release_sha, run_id)
    body = await request.body()
    actual_digest = hashlib.sha256(body).hexdigest()
    if x_evidence_sha256 != actual_digest:
        raise HTTPException(status_code=400, detail="X-Evidence-SHA256 does not match body")
    key = f"{configured_prefix}/{release_sha}/{run_id}/{object_path}"
    retain_until = datetime.now(timezone.utc) + timedelta(days=settings.retention_days)
    try:
        settings.s3.put_object(
            Bucket=settings.bucket,
            Key=key,
            Body=body,
            ContentType=request.headers.get("content-type", "application/octet-stream"),
            ServerSideEncryption="AES256",
            ObjectLockMode="COMPLIANCE",
            ObjectLockRetainUntilDate=retain_until,
            Tagging="umoja-immutable=true",
            Metadata={"release-sha": release_sha, "run-id": run_id, "sha256": actual_digest},
        )
    except ClientError as exc:
        raise HTTPException(status_code=502, detail="evidence object publication failed") from exc
    return {"status": "stored", "key": key, "sha256": actual_digest}
