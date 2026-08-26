"""Fail-closed deletion worker for retention-gateway authorizations.

The worker verifies the gateway-issued token, atomically consumes it, rechecks
physical-index identity, and deletes only the exact index named in the request.
The OpenSearch adapter is injected so unit tests do not require a live cluster.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hmac
import json
from typing import Protocol

from .decision_engine import DeleteRequest, HMACAuthorizationSigner


class OpenSearchAuthenticationError(RuntimeError):
    pass


class OpenSearchAuthorizationError(RuntimeError):
    pass


class ManifestSignatureError(RuntimeError):
    """Raised when a manifest row signature is invalid or missing."""
    pass


class DatabaseConnectionPoolError(RuntimeError):
    """Raised when the worker cannot acquire a PostgreSQL pooled connection in time."""
    pass


@dataclass(frozen=True)
class IndexIdentity:
    index: str
    index_uuid: str
    index_version: str
    digest: str


@dataclass(frozen=True)
class VerifiedAuthorization:
    request: DeleteRequest
    decision_digest: str
    expires_at: datetime


class AuthorizationUseStore(Protocol):
    def claim(self, decision_digest: str, expires_at: datetime, now: datetime) -> bool: ...


class OpenSearchDeleteClient(Protocol):
    def identity(self, index: str) -> IndexIdentity | None: ...
    def delete_exact_index(self, index: str, expected_uuid: str, expected_version: str) -> bool: ...


class InMemoryAuthorizationUseStore:
    """Thread-safe test store; replace with a PostgreSQL conditional UPDATE in production."""

    def __init__(self) -> None:
        import threading
        self._lock = threading.Lock()
        self._claimed: set[str] = set()

    def claim(self, decision_digest: str, expires_at: datetime, now: datetime) -> bool:
        with self._lock:
            if now >= expires_at or decision_digest in self._claimed:
                return False
            self._claimed.add(decision_digest)
            return True


class HMACManifestSigner:
    def __init__(self, secret: bytes) -> None:
        if len(secret) < 32:
            raise ValueError("manifest HMAC secret must be at least 32 bytes")
        self.secret = secret

    def sign(self, index_name: str, index_uuid: str, index_version: str, archive_digest: str) -> str:
        body = {
            "index_name": index_name,
            "index_uuid": index_uuid,
            "index_version": index_version,
            "archive_digest": archive_digest,
        }
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        return hmac.new(self.secret, canonical, "sha256").hexdigest()


class HMACManifestVerifier:
    def __init__(self, secret: bytes) -> None:
        self._signer = HMACManifestSigner(secret)

    def verify(self, index_name: str, index_uuid: str, index_version: str, archive_digest: str, signature: str) -> bool:
        expected = self._signer.sign(index_name, index_uuid, index_version, archive_digest)
        return hmac.compare_digest(signature, expected)


class HMACAuthorizationVerifier:
    def __init__(self, secret: bytes) -> None:
        # Keep this requirement aligned with HMACAuthorizationSigner.
        self._signer = HMACAuthorizationSigner(secret)

    def verify(
        self,
        token: str,
        request: DeleteRequest,
        decision_digest: str,
        now: datetime | None = None,
    ) -> VerifiedAuthorization | None:
        try:
            supplied_signature, expiry_text = token.split(".", 1)
            if not supplied_signature or not expiry_text:
                return None
            expires_at = datetime.fromisoformat(expiry_text)
            if expires_at.tzinfo is None:
                return None
            expires_at = expires_at.astimezone(timezone.utc)
        except (TypeError, ValueError):
            return None

        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if now >= expires_at:
            return None

        body = {
            "index": request.index,
            "index_uuid": request.index_uuid,
            "index_version": request.index_version,
            "expected_digest": request.expected_digest,
            "decision_digest": decision_digest,
            "expires_at": expires_at.isoformat(),
        }
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        expected_signature = hmac.new(self._signer.secret, canonical, "sha256").hexdigest()
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return None
        return VerifiedAuthorization(request, decision_digest, expires_at)


class DeleteWorker:
    def __init__(self, verifier: HMACAuthorizationVerifier, use_store: AuthorizationUseStore, opensearch: OpenSearchDeleteClient) -> None:
        self.verifier = verifier
        self.use_store = use_store
        self.opensearch = opensearch

    def execute(
        self,
        token: str,
        request: DeleteRequest,
        decision_digest: str,
        now: datetime | None = None,
    ) -> str:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        verified = self.verifier.verify(token, request, decision_digest, now)
        if verified is None:
            return "denied_invalid_or_expired_token"

        # Consume before any index-state shortcut so a replay cannot be reported as
        # an ordinary already-deleted result. This claim must be an atomic durable
        # operation in production.
        try:
            claimed = self.use_store.claim(decision_digest, verified.expires_at, now)
        except DatabaseConnectionPoolError:
            return "database_connection_pool_saturated"
        except Exception:
            return "database_claim_error"
        if not claimed:
            return "denied_replay_or_consumed"

        # The token binds the request fields. Re-read the physical identity immediately
        # before deletion so an alias swap or index replacement cannot reuse the token.
        try:
            current = self.opensearch.identity(request.index)
        except OpenSearchAuthenticationError:
            return "opensearch_authentication_failure"
        except OpenSearchAuthorizationError:
            return "opensearch_authorization_failure"
        except ManifestSignatureError:
            return "denied_manifest_signature_invalid"
        if current is None:
            return "already_deleted"
        if (
            current.index != request.index
            or current.index_uuid != request.index_uuid
            or current.index_version != request.index_version
            or current.digest != request.expected_digest
        ):
            return "denied_scope_changed"

        # Deletion is idempotent: a 404/absent index is treated as already deleted.
        try:
            deleted = self.opensearch.delete_exact_index(
                request.index, request.index_uuid, request.index_version
            )
        except OpenSearchAuthenticationError:
            return "opensearch_authentication_failure"
        except OpenSearchAuthorizationError:
            return "opensearch_authorization_failure"
        except Exception:
            # The authorization remains consumed. A production worker should persist an
            # execution record and reconcile the exact index state before retrying.
            return "delete_execution_error"
        return "deleted" if deleted else "already_deleted"


class PostgresAuthorizationUseStore:
    """Durable authorization store using PostgreSQL row-level locking.

    The gateway must insert the decision digest before returning an authorization
    token.     The worker then claims it exactly once with an atomic conditional UPDATE.

    """

    CREATE_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS retention_delete_authorizations (
        decision_digest text PRIMARY KEY,
        expires_at timestamptz NOT NULL,
        issued_at timestamptz NOT NULL DEFAULT now(),
        consumed_at timestamptz,
        execution_status text NOT NULL DEFAULT 'issued',
        CHECK (length(decision_digest) = 64)
    );
    CREATE TABLE IF NOT EXISTS retention_index_manifests (
        index_name text NOT NULL,
        index_uuid text NOT NULL,
        index_version text NOT NULL,
        archive_digest text NOT NULL CHECK (length(archive_digest) = 64),
        row_signature text NOT NULL CHECK (length(row_signature) = 64),
        recorded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (index_name, index_uuid, index_version)
    )
    """

    def __init__(self, connection_factory, manifest_secret: bytes | None = None) -> None:
        self.connection_factory = connection_factory
        self.manifest_signer = HMACManifestSigner(manifest_secret) if manifest_secret else None
        self.manifest_verifier = HMACManifestVerifier(manifest_secret) if manifest_secret else None

    def initialize(self) -> None:
        with self.connection_factory() as connection:
            with connection.cursor() as cursor:
                cursor.execute(self.CREATE_TABLE_SQL)
            connection.commit()

    def register(self, decision_digest: str, expires_at: datetime) -> None:
        if len(decision_digest) != 64:
            raise ValueError("decision digest must be a SHA-256 hex digest")
        with self.connection_factory() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO retention_delete_authorizations
                        (decision_digest, expires_at)
                    VALUES (%s, %s)
                    ON CONFLICT (decision_digest) DO NOTHING
                    """,
                    (decision_digest, expires_at.astimezone(timezone.utc)),
                )
            connection.commit()

    def claim(self, decision_digest: str, expires_at: datetime, now: datetime) -> bool:
        """Atomically claim one unexpired authorization with a single row-locking UPDATE.

        The conditional UPDATE acquires the required row lock, validates the token's
        exact stored expiry, and sets ``consumed_at`` in one round trip. It returns
        False for missing, expired, mismatched-expiry, or previously claimed rows.
        """
        now = now.astimezone(timezone.utc)
        expires_at = expires_at.astimezone(timezone.utc)
        connection = None
        try:
            with self.connection_factory() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE retention_delete_authorizations
                        SET consumed_at = %s, execution_status = 'claimed'
                        WHERE decision_digest = %s
                          AND consumed_at IS NULL
                          AND expires_at = %s
                          AND expires_at > %s
                        RETURNING decision_digest
                        """,
                        (now, decision_digest, expires_at, now),
                    )
                    claimed = cursor.fetchone() is not None
                connection.commit()
                return claimed
        except Exception as exc:
            if connection is not None:
                connection.rollback()
            if exc.__class__.__name__ == "PoolTimeout":
                raise DatabaseConnectionPoolError("PostgreSQL connection pool acquisition timed out") from exc
            raise

    def archive_digest(self, index_name: str, index_uuid: str, index_version: str) -> str | None:
        with self.connection_factory() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT archive_digest, row_signature FROM retention_index_manifests
                    WHERE index_name = %s AND index_uuid = %s AND index_version = %s
                    """,
                    (index_name, index_uuid, index_version),
                )
                row = cursor.fetchone()
                if not row:
                    return None
                digest, signature = row
                if self.manifest_verifier is None:
                    raise ManifestSignatureError("manifest verification key is not configured")
                if not self.manifest_verifier.verify(
                    index_name, index_uuid, index_version, digest, signature
                ):
                    raise ManifestSignatureError(f"Invalid manifest signature for {index_name}")
                return digest

    def register_manifest(self, index_name: str, index_uuid: str, index_version: str, archive_digest: str) -> None:
        if len(archive_digest) != 64:
            raise ValueError("archive digest must be a SHA-256 hex digest")
        if self.manifest_signer is None:
            raise ManifestSignatureError("manifest signing key is not configured")
        signature = self.manifest_signer.sign(index_name, index_uuid, index_version, archive_digest)

        with self.connection_factory() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO retention_index_manifests(index_name, index_uuid, index_version, archive_digest, row_signature)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (index_name, index_uuid, index_version)
                    DO UPDATE SET archive_digest = EXCLUDED.archive_digest, row_signature = EXCLUDED.row_signature
                    """,
                    (index_name, index_uuid, index_version, archive_digest, signature),
                )
            connection.commit()

    def mark_result(self, decision_digest: str, status: str) -> None:
        allowed = {"deleted", "already_deleted", "delete_execution_error", "denied_scope_changed", "denied_manifest_signature_invalid"}
        if status not in allowed:
            raise ValueError("invalid deletion execution status")
        with self.connection_factory() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE retention_delete_authorizations SET execution_status = %s WHERE decision_digest = %s",
                    (status, decision_digest),
                )
            connection.commit()
