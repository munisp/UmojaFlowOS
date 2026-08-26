import os
from datetime import datetime, timedelta, timezone

import pytest

from simulators.retention_gateway.delete_worker import (
    DeleteWorker,
    HMACAuthorizationVerifier,
    IndexIdentity,
    InMemoryAuthorizationUseStore,
    PostgresAuthorizationUseStore,
    ManifestSignatureError,
)
from simulators.retention_gateway.decision_engine import DeleteRequest

pytestmark = pytest.mark.integration

if os.getenv("RUN_OPENSEARCH_INTEGRATION") != "1":
    pytest.skip("set RUN_OPENSEARCH_INTEGRATION=1 to run Docker integration tests", allow_module_level=True)

requests = pytest.importorskip("requests")
DockerContainer = pytest.importorskip("testcontainers.core.container").DockerContainer


class RealOpenSearchClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")

    def _get(self, path):
        response = requests.get(self.base_url + path, timeout=10)
        response.raise_for_status()
        return response

    def identity(self, index):
        response = requests.get(f"{self.base_url}/{index}/_settings/index.uuid,index.version", timeout=10)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        payload = response.json()[index]["settings"]["index"]
        return IndexIdentity(
            index=index,
            index_uuid=payload["uuid"],
            index_version=payload.get("version", "1"),
            digest=DIGEST,
        )

    def delete_exact_index(self, index, expected_uuid, expected_version):
        response = requests.delete(f"{self.base_url}/{index}", timeout=10)
        if response.status_code == 404:
            return False
        response.raise_for_status()
        return True


DIGEST = "c" * 64
NOW = datetime.now(timezone.utc)


@pytest.fixture(scope="module")
def opensearch_url():
    with DockerContainer("opensearchproject/opensearch:2.15.0") \
        .with_env("discovery.type", "single-node") \
        .with_env("DISABLE_SECURITY_PLUGIN", "true") \
        .with_env("OPENSEARCH_JAVA_OPTS", "-Xms512m -Xmx512m") \
        .with_env("bootstrap.memory_lock", "true") \
        .with_exposed_ports(9200) as container:
        url = f"http://{container.get_container_host_ip()}:{container.get_exposed_port(9200)}"
        for _ in range(60):
            response = requests.get(f"{url}/_cluster/health", timeout=2)
            if response.ok:
                return url
            import time
            time.sleep(2)
        pytest.fail("OpenSearch container did not become healthy")


def create_request(client, index):
    response = requests.put(f"{client.base_url}/{index}", timeout=10)
    response.raise_for_status()
    identity = client.identity(index)
    assert identity is not None
    return DeleteRequest(index, identity.index_uuid, identity.index_version, DIGEST, "ism-service", "integration-correlation")


def test_delete_worker_deletes_exact_real_opensearch_index(opensearch_url):
    client = RealOpenSearchClient(opensearch_url)
    index = "umoja-retention-it-delete-001"
    request = create_request(client, index)
    worker = DeleteWorker(HMACAuthorizationVerifier(b"k" * 32), InMemoryAuthorizationUseStore(), client)
    # The integration test supplies a pre-authorized token using the same canonical format.
    from simulators.retention_gateway.decision_engine import HMACAuthorizationSigner
    expiry = NOW + timedelta(minutes=5)
    token = HMACAuthorizationSigner(b"k" * 32).sign(request, "d" * 64, expiry)
    assert worker.execute(token, request, "d" * 64, NOW) == "deleted"
    assert client.identity(index) is None


def test_delete_worker_rejects_changed_scope_before_real_delete(opensearch_url):
    client = RealOpenSearchClient(opensearch_url)
    index = "umoja-retention-it-scope-001"
    request = create_request(client, index)
    worker = DeleteWorker(HMACAuthorizationVerifier(b"k" * 32), InMemoryAuthorizationUseStore(), client)
    from simulators.retention_gateway.decision_engine import HMACAuthorizationSigner
    expiry = NOW + timedelta(minutes=5)
    token = HMACAuthorizationSigner(b"k" * 32).sign(request, "e" * 64, expiry)
    changed = DeleteRequest(index, "wrong-uuid", request.index_version, DIGEST, request.requested_by, request.correlation_id)
    assert worker.execute(token, changed, "e" * 64, NOW) == "denied_invalid_or_expired_token"
    assert client.identity(index) is not None
    requests.delete(f"{opensearch_url}/{index}", timeout=10)


def test_postgres_store_verifies_manifest_signature(tmp_path):
    import sqlite3
    # Use sqlite3 as a simple double for psycopg connection in this test.
    db_path = tmp_path / "test.db"

    def connect():
        conn = sqlite3.connect(db_path)
        # Add PostgreSQL-style %s support to sqlite3 for this test.
        original_execute = conn.execute
        def pg_execute(sql, params=None):
            return original_execute(sql.replace("%s", "?"), params or ())
        conn.execute = pg_execute
        return conn

    secret = b"m" * 32
    store = PostgresAuthorizationUseStore(connect, manifest_secret=secret)
    # Initialize schema (using sqlite-compatible subset)
    with connect() as conn:
        conn.execute("CREATE TABLE retention_index_manifests (index_name text, index_uuid text, index_version text, archive_digest text, row_signature text, PRIMARY KEY (index_name, index_uuid, index_version))")

    index, uuid, version, digest = "idx", "u1", "v1", "d" * 64
    store.register_manifest(index, uuid, version, digest)

    # Valid lookup
    assert store.archive_digest(index, uuid, version) == digest

    # Tamper with signature in DB
    with connect() as conn:
        conn.execute("UPDATE retention_index_manifests SET row_signature = 'tampered' WHERE index_name = ?", (index,))
        conn.commit()

    with pytest.raises(ManifestSignatureError):
        store.archive_digest(index, uuid, version)
