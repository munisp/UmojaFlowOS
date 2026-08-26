import os
from pathlib import Path

import pytest

os.environ["RETENTION_WORKER_IMPORT_ONLY"] = "1"
from simulators.retention_gateway.worker_service import HTTPOpenSearchClient


class Response:
    status_code = 404

    def raise_for_status(self):
        return None


def make_files(tmp_path):
    paths = {}
    for name in ("ca.pem", "client.crt", "client.key"):
        path = tmp_path / name
        path.write_text(name)
        paths[name] = str(path)
    return paths


def test_client_requires_https_and_certificate_files(tmp_path):
    files = make_files(tmp_path)
    with pytest.raises(RuntimeError, match="HTTPS"):
        HTTPOpenSearchClient("http://opensearch:9200", files["ca.pem"], files["client.crt"], files["client.key"], lambda *_: "a" * 64)
    with pytest.raises(RuntimeError, match="client key"):
        HTTPOpenSearchClient("https://opensearch:9200", files["ca.pem"], files["client.crt"], str(tmp_path / "missing"), lambda *_: "a" * 64)


def test_client_passes_ca_and_mtls_pair_to_requests(tmp_path, monkeypatch):
    files = make_files(tmp_path)
    captured = {}

    def fake_request(method, url, **kwargs):
        captured.update(method=method, url=url, kwargs=kwargs)
        return Response()

    monkeypatch.setattr("simulators.retention_gateway.worker_service.requests.request", fake_request)
    client = HTTPOpenSearchClient("https://opensearch:9200", files["ca.pem"], files["client.crt"], files["client.key"], lambda *_: "a" * 64)
    client._request("GET", "/_cluster/health")
    assert captured["method"] == "GET"
    assert captured["url"] == "https://opensearch:9200/_cluster/health"
    assert captured["kwargs"]["verify"] == files["ca.pem"]
    assert captured["kwargs"]["cert"] == (files["client.crt"], files["client.key"])
    assert captured["kwargs"]["timeout"] == 10
