"""OpenSearch writer regressions against a real local HTTP server.

OpenSearch itself does not fit the current host. These tests do not replace the
writer with a mock: they run an actual HTTP listener, validate the emitted
method/path/authorization/body, and drive the create/duplicate/conflict
protocol that a configured OpenSearch endpoint must support.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from umojaflowos_reporting.opensearch_adapter import (
    OpenSearchConfig,
    OpenSearchProjectionWriter,
    OpenSearchUnavailable,
    redacted_search_document,
)


class SearchServer(BaseHTTPRequestHandler):
    responses: list[tuple[int, dict]] = []
    received: list[tuple[str, str, str, dict]] = []

    def do_PUT(self) -> None:  # noqa: N802
        self._record()

    def do_GET(self) -> None:  # noqa: N802
        self._record()

    def _record(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        body = json.loads(raw) if raw else {}
        type(self).received.append((self.command, self.path, self.headers.get("Authorization", ""), body))
        status, response = type(self).responses.pop(0)
        encoded = json.dumps(response).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args) -> None:  # type: ignore[no-untyped-def]
        return


@pytest.fixture
def search_endpoint():
    SearchServer.responses = []
    SearchServer.received = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), SearchServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def writer(endpoint: str) -> OpenSearchProjectionWriter:
    return OpenSearchProjectionWriter(
        OpenSearchConfig(
            base_url=endpoint,
            bearer_token="development-secret-reference-resolved-outside-browser",
            allow_insecure_loopback=True,
        )
    )


def test_writer_creates_a_redacted_projection_over_the_real_http_protocol(search_endpoint: str) -> None:
    SearchServer.responses = [(201, {"result": "created"})]
    outcome = writer(search_endpoint).write("umojaflowos-audit-v1", "audit-1", {"event_id": "audit-1", "action": "case.opened"})
    assert outcome == "created"
    method, path, authorization, body = SearchServer.received[0]
    assert method == "PUT"
    assert path == "/umojaflowos-audit-v1/_doc/audit-1?op_type=create"
    assert authorization.startswith("Bearer ")
    assert body == {"event_id": "audit-1", "action": "case.opened"}


def test_duplicate_is_acknowledged_only_when_existing_source_matches(search_endpoint: str) -> None:
    document = {"event_id": "audit-1", "action": "case.opened"}
    SearchServer.responses = [(409, {"error": {"type": "version_conflict_engine_exception"}}), (200, {"_source": document})]
    assert writer(search_endpoint).write("umojaflowos-audit-v1", "audit-1", document) == "duplicate"

    SearchServer.responses = [(409, {"error": {"type": "version_conflict_engine_exception"}}), (200, {"_source": {"event_id": "audit-1", "action": "case.closed"}})]
    with pytest.raises(OpenSearchUnavailable, match="differs"):
        writer(search_endpoint).write("umojaflowos-audit-v1", "audit-1", document)


def test_writer_refuses_remote_plaintext_and_path_shaped_index() -> None:
    with pytest.raises(OpenSearchUnavailable, match="loopback only"):
        OpenSearchProjectionWriter(OpenSearchConfig(base_url="http://198.51.100.4:9200", bearer_token="secret", allow_insecure_loopback=True))
    with pytest.raises(OpenSearchUnavailable, match="path-safe"):
        writer("http://127.0.0.1:9200").write("audit/unsafe", "id", {"event_id": "id"})


def test_case_projection_allows_only_approved_search_fields() -> None:
    index, document_id, document = redacted_search_document(
        {
            "projection_type": "case",
            "case_id": "case-1",
            "status": "open",
            "corridor": "KENYA_KES",
            "updated_at": "2026-08-19T04:00:00Z",
            "reason_codes": ["SCREENING_UNAVAILABLE"],
        }
    )
    assert (index, document_id) == ("umojaflowos-cases-v1", "case-1")
    assert "amount" not in document
    with pytest.raises(OpenSearchUnavailable, match="not approved"):
        redacted_search_document(
            {
                "projection_type": "case",
                "case_id": "case-1",
                "status": "open",
                "corridor": "KENYA_KES",
                "updated_at": "2026-08-19T04:00:00Z",
                "amount": "100",
            }
        )
