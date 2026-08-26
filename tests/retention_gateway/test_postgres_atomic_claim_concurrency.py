"""Real PostgreSQL concurrency tests for the retention authorization claim.

Run only when Docker is available:
  RUN_POSTGRES_INTEGRATION=1 python3 -m pytest -m integration -q \
    tests/retention_gateway/test_postgres_atomic_claim_concurrency.py
"""
from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from simulators.retention_gateway.delete_worker import PostgresAuthorizationUseStore

pytestmark = pytest.mark.integration

if os.getenv("RUN_POSTGRES_INTEGRATION") != "1":
    pytest.skip("set RUN_POSTGRES_INTEGRATION=1 to run PostgreSQL Docker integration tests", allow_module_level=True)

psycopg = pytest.importorskip("psycopg")
PostgresContainer = pytest.importorskip("testcontainers.postgres").PostgresContainer

WORKERS = int(os.getenv("POSTGRES_CONCURRENCY_WORKERS", "64"))
if not 2 <= WORKERS <= 96:
    raise ValueError("POSTGRES_CONCURRENCY_WORKERS must be between 2 and 96")


@pytest.fixture(scope="module")
def postgres_dsn():
    with PostgresContainer("postgres:16-alpine") as container:
        yield container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")


@pytest.fixture
def store(postgres_dsn):
    def connection_factory():
        return psycopg.connect(postgres_dsn, autocommit=False)

    result = PostgresAuthorizationUseStore(connection_factory)
    result.initialize()
    with connection_factory() as connection:
        with connection.cursor() as cursor:
            cursor.execute("TRUNCATE retention_delete_authorizations")
        connection.commit()
    return result, connection_factory


def concurrent_claims(store: PostgresAuthorizationUseStore, digest: str, expires_at: datetime, now: datetime, workers: int) -> list[bool]:
    barrier = threading.Barrier(workers)

    def claim_once() -> bool:
        barrier.wait(timeout=20)
        return store.claim(digest, expires_at, now)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        return list(executor.map(lambda _unused: claim_once(), range(workers)))


def test_atomic_claim_has_exactly_one_winner_under_high_contention(store):
    authorization_store, connection_factory = store
    now = datetime.now(timezone.utc).replace(microsecond=0)
    expires_at = now + timedelta(minutes=5)
    digest = "a" * 64
    authorization_store.register(digest, expires_at)

    results = concurrent_claims(authorization_store, digest, expires_at, now, WORKERS)

    assert sum(results) == 1
    assert results.count(False) == WORKERS - 1
    with connection_factory() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) FILTER (WHERE consumed_at IS NOT NULL), execution_status "
                "FROM retention_delete_authorizations WHERE decision_digest = %s GROUP BY execution_status",
                (digest,),
            )
            row = cursor.fetchone()
    assert row == (1, "claimed")


def test_atomic_claim_rejects_expiry_mismatch_for_all_contenders(store):
    authorization_store, connection_factory = store
    now = datetime.now(timezone.utc).replace(microsecond=0)
    stored_expiry = now + timedelta(minutes=5)
    wrong_token_expiry = now + timedelta(minutes=4)
    digest = "b" * 64
    authorization_store.register(digest, stored_expiry)

    results = concurrent_claims(authorization_store, digest, wrong_token_expiry, now, WORKERS)

    assert not any(results)
    with connection_factory() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT consumed_at, execution_status FROM retention_delete_authorizations WHERE decision_digest = %s",
                (digest,),
            )
            row = cursor.fetchone()
    assert row == (None, "issued")


def test_atomic_claim_allows_one_winner_per_independent_authorization(store):
    authorization_store, connection_factory = store
    now = datetime.now(timezone.utc).replace(microsecond=0)
    expires_at = now + timedelta(minutes=5)
    digests = [f"{number:064x}" for number in range(WORKERS)]
    for digest in digests:
        authorization_store.register(digest, expires_at)

    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        results = list(executor.map(lambda digest: authorization_store.claim(digest, expires_at, now), digests))

    assert all(results)
    with connection_factory() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM retention_delete_authorizations WHERE consumed_at IS NOT NULL")
            claimed_count = cursor.fetchone()[0]
    assert claimed_count == WORKERS
