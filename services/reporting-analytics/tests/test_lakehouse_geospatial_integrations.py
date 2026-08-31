import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from umojaflowos_reporting.geolibre_project import GeoLibrePublicationError, build_aggregate_project
from umojaflowos_reporting.lakehouse import LakehouseContractError
from umojaflowos_reporting.lakehouse_writer import BronzeLakehouseWriter, LakehouseConfig, LakehouseUnavailable
from umojaflowos_reporting.sedona_livy import SedonaAggregateJobClient, SedonaLivyConfig, SedonaUnavailable


class ProtocolServer(BaseHTTPRequestHandler):
    received: list[tuple[str, str, dict[str, str], bytes]] = []
    response_status = 200
    response_body: dict = {}

    def do_PUT(self) -> None:  # noqa: N802
        self._record()

    def do_POST(self) -> None:  # noqa: N802
        self._record()

    def do_GET(self) -> None:  # noqa: N802
        self._record()

    def _record(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks: list[bytes] = []
            while True:
                header = self.rfile.readline().strip().split(b";", 1)[0]
                chunk_size = int(header, 16)
                if chunk_size == 0:
                    # Consume the final CRLF after the terminal chunk.
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(chunk_size))
                self.rfile.read(2)
            body = b"".join(chunks)
        else:
            body = self.rfile.read(length) if length else b""
        type(self).received.append((self.command, self.path, dict(self.headers), body))
        encoded = b"" if self.command == "PUT" else json.dumps(type(self).response_body).encode("utf-8")
        self.send_response(type(self).response_status)
        if encoded:
            self.send_header("Content-Type", "application/json")
        self.send_header("ETag", '"local-protocol-regression"')
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args) -> None:  # type: ignore[no-untyped-def]
        return


@pytest.fixture
def protocol_endpoint():
    ProtocolServer.received = []
    ProtocolServer.response_status = 200
    ProtocolServer.response_body = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), ProtocolServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_lakehouse_writer_signs_and_conditionally_puts_redacted_evidence(protocol_endpoint: str) -> None:
    ProtocolServer.response_status = 200
    writer = BronzeLakehouseWriter(
        LakehouseConfig(
            endpoint_url=protocol_endpoint,
            bucket="umojaflowos-lakehouse",
            access_key_id="local-access-key",
            secret_access_key="local-secret-key",
            allow_insecure_loopback=True,
        )
    )
    manifest, key, outcome = writer.write(
        "service-health",
        [{"service": "payment-engine", "status": "healthy", "observed_at": "2026-08-19T04:00:00Z"}],
    )
    assert outcome == "created"
    assert key.startswith("bronze/service-health/v1/")
    assert manifest.record_count == 1
    method, path, headers, body = ProtocolServer.received[0]
    assert method == "PUT"
    assert path.startswith(f"/umojaflowos-lakehouse/{key}")
    assert headers["If-None-Match"] == "*"
    assert headers["Authorization"].startswith("AWS4-HMAC-SHA256")
    assert json.loads(body.decode("utf-8"))["service"] == "payment-engine"


def test_lakehouse_writer_refuses_sensitive_fields_and_remote_plaintext() -> None:
    with pytest.raises(LakehouseUnavailable, match="loopback only"):
        BronzeLakehouseWriter(
            LakehouseConfig(
                endpoint_url="http://198.51.100.8:9000",
                bucket="umojaflowos-lakehouse",
                access_key_id="key",
                secret_access_key="secret",
                allow_insecure_loopback=True,
            )
        )
    with pytest.raises(LakehouseContractError, match="unapproved"):
        BronzeLakehouseWriter.prepare("service-health", [{"customer_name": "must-not-enter-lakehouse"}])


def test_sedona_livy_submission_uses_only_aggregate_lakehouse_arguments(protocol_endpoint: str) -> None:
    ProtocolServer.response_status = 201
    ProtocolServer.response_body = {"id": 27}
    client = SedonaAggregateJobClient(
        SedonaLivyConfig(
            base_url=protocol_endpoint,
            bearer_token="local-sedona-token",
            aggregate_job_uri="https://artifacts.example.test/sedona-jurisdiction-aggregate.py",
            allow_insecure_loopback=True,
        )
    )
    assert client.submit("s3://umojaflowos-lakehouse/bronze/geospatial-aggregates/input.jsonl", "s3://umojaflowos-lakehouse/silver/geospatial-aggregates/output", "payment_count", 7) == 27
    method, path, headers, raw = ProtocolServer.received[0]
    body = json.loads(raw.decode("utf-8"))
    assert (method, path) == ("POST", "/batches")
    assert headers["Authorization"] == "Bearer local-sedona-token"
    assert body["args"] == [
        "s3://umojaflowos-lakehouse/bronze/geospatial-aggregates/input.jsonl",
        "s3://umojaflowos-lakehouse/silver/geospatial-aggregates/output",
        "payment_count",
        "7",
    ]
    assert body["conf"]["spark.sql.extensions"] == "org.apache.sedona.sql.SedonaSqlExtensions"
    with pytest.raises(SedonaUnavailable, match="S3-compatible"):
        client.submit("https://raw-location.example.test/data", "s3://umojaflowos-lakehouse/out", "payment_count", 7)


def test_geolibre_project_is_compatible_and_contains_only_a_signed_aggregate_url() -> None:
    publication = build_aggregate_project(
        "Nigeria (NGN) aggregate payment activity",
        "https://lakehouse.example.test/signed/jurisdiction-aggregate.geojson?expires=900&signature=redacted",
        "https://maps.example.test",
    )
    assert publication.project["version"] == "0.1.0"
    layer = publication.project["layers"][0]  # type: ignore[index]
    assert layer["source"]["url"].startswith("https://")  # type: ignore[index]
    assert "layout=viewer" in publication.viewer_url
    with pytest.raises(GeoLibrePublicationError, match="credential"):
        build_aggregate_project("Unsafe", "https://lakehouse.example.test/data.geojson?token=must-not-share", "https://maps.example.test")
