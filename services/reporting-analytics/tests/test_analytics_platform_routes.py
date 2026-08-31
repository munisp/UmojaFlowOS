import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi.testclient import TestClient

from umojaflowos_reporting.service import app


class IntegrationProtocolHandler(BaseHTTPRequestHandler):
    seen: list[tuple[str, str, dict[str, str], bytes]] = []

    def do_PUT(self) -> None:  # noqa: N802
        self._handle()

    def do_POST(self) -> None:  # noqa: N802
        self._handle()

    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        type(self).seen.append((self.command, self.path, dict(self.headers), body))
        if self.path == "/batches":
            payload = json.dumps({"id": 51}).encode("utf-8")
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
        else:
            payload = b""
            self.send_response(200)
            self.send_header("ETag", '"route-regression"')
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:  # type: ignore[no-untyped-def]
        return


def live_protocol_endpoint():
    IntegrationProtocolHandler.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), IntegrationProtocolHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_port}"


def test_analytics_routes_are_explicitly_unavailable_without_deployment_configuration(monkeypatch) -> None:
    for key in (
        "UMOJA_LAKEHOUSE_ENDPOINT",
        "UMOJA_LAKEHOUSE_BUCKET",
        "UMOJA_LAKEHOUSE_ACCESS_KEY_ID",
        "UMOJA_LAKEHOUSE_SECRET_ACCESS_KEY",
        "UMOJA_SEDONA_LIVY_URL",
        "UMOJA_SEDONA_LIVY_BEARER_TOKEN",
        "UMOJA_SEDONA_AGGREGATE_JOB_URI",
        "UMOJA_GEOLIBRE_VIEWER_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    with TestClient(app) as client:
        bronze = client.post("/v1/lakehouse/bronze", json={"dataset": "service-health", "records": []})
        sedona = client.post(
            "/v1/geospatial/sedona/submit",
            json={"input_uri": "s3://bucket/in", "output_uri": "s3://bucket/out", "metric_name": "payment_count", "h3_resolution": 7},
        )
        geolibre = client.post("/v1/geospatial/geolibre-project", json={"project_name": "Kenya aggregate", "aggregate_object_key": "silver/geospatial-aggregates/kenya.geojson"})
        assert (bronze.status_code, sedona.status_code, geolibre.status_code) == (503, 503, 503)
        assert "configured" in bronze.json()["detail"]
        assert "configured" in sedona.json()["detail"]


def test_configured_routes_use_real_protocol_requests_and_return_aggregate_only_results(monkeypatch) -> None:
    server, thread, endpoint = live_protocol_endpoint()
    client = None
    try:
        monkeypatch.setenv("UMOJA_LAKEHOUSE_ENDPOINT", endpoint)
        monkeypatch.setenv("UMOJA_LAKEHOUSE_BUCKET", "umojaflowos-lakehouse")
        monkeypatch.setenv("UMOJA_LAKEHOUSE_ACCESS_KEY_ID", "local-access-key")
        monkeypatch.setenv("UMOJA_LAKEHOUSE_SECRET_ACCESS_KEY", "local-secret-key")
        monkeypatch.setenv("UMOJA_LAKEHOUSE_ALLOW_INSECURE_LOOPBACK", "true")
        monkeypatch.setenv("UMOJA_SEDONA_LIVY_URL", endpoint)
        monkeypatch.setenv("UMOJA_SEDONA_LIVY_BEARER_TOKEN", "local-sedona-token")
        monkeypatch.setenv("UMOJA_SEDONA_AGGREGATE_JOB_URI", "https://artifacts.example.test/sedona_jurisdiction_aggregate.py")
        monkeypatch.setenv("UMOJA_SEDONA_ALLOW_INSECURE_LOOPBACK", "true")
        monkeypatch.setenv("UMOJA_GEOLIBRE_VIEWER_URL", "https://maps.example.test")
        client = TestClient(app)

        bronze = client.post("/v1/lakehouse/bronze", json={"dataset": "service-health", "records": [{"service": "risk-core", "status": "healthy"}]})
        assert bronze.status_code == 200
        assert bronze.json()["status"] == "created"
        assert bronze.json()["object_key"].startswith("bronze/service-health/")

        sedona = client.post(
            "/v1/geospatial/sedona/submit",
            json={"input_uri": "s3://umojaflowos-lakehouse/bronze/geospatial-aggregates/input", "output_uri": "s3://umojaflowos-lakehouse/silver/geospatial-aggregates/output", "metric_name": "payment_count", "h3_resolution": 7},
        )
        assert sedona.status_code == 200
        assert sedona.json()["livy_batch_id"] == 51

        # A browser-facing GeoLibre project must never be given the local HTTP
        # object-store endpoint used by this protocol test. Generating a signed
        # URL does not make a request, so this switches only the publication
        # base to the production HTTPS invariant before the project route runs.
        monkeypatch.setenv("UMOJA_LAKEHOUSE_ENDPOINT", "https://lakehouse.example.test")
        monkeypatch.delenv("UMOJA_LAKEHOUSE_ALLOW_INSECURE_LOOPBACK", raising=False)
        project = client.post("/v1/geospatial/geolibre-project", json={"project_name": "Kenya (KES) aggregate", "aggregate_object_key": "silver/geospatial-aggregates/kenya.geojson"})
        assert project.status_code == 200
        assert project.json()["data_policy"] == "aggregate_only"
        assert project.json()["project"]["version"] == "0.1.0"
        assert project.json()["project"]["layers"][0]["source"]["url"].startswith("http")

        methods_paths = {(method, path) for method, path, _, _ in IntegrationProtocolHandler.seen}
        assert any(method == "PUT" and "/umojaflowos-lakehouse/bronze/service-health/" in path for method, path in methods_paths)
        assert ("POST", "/batches") in methods_paths
    finally:
        if client is not None:
            client.close()
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()
