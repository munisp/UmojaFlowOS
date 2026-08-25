from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import ssl
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

HANDLER_PATH = Path(__file__).parents[1] / "infra/wazuh/custom-umoja-sod-incident.py"
SPEC = importlib.util.spec_from_file_location("umoja_sod_incident", HANDLER_PATH)
assert SPEC and SPEC.loader
handler_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(handler_module)


class ReceiverHandler(BaseHTTPRequestHandler):
    requests: list[tuple[bytes, str]] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers["Content-Length"])
        body = self.rfile.read(length)
        self.__class__.requests.append((body, self.headers.get("X-Umoja-Signature", "")))
        self.send_response(202)
        self.end_headers()
        self.wfile.write(b"accepted")

    def log_message(self, *_args: object) -> None:
        return


@pytest.fixture
def mock_pagerduty(tmp_path: Path):
    key_path = tmp_path / "server.key"
    cert_path = tmp_path / "server.crt"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key_path), "-out", str(cert_path), "-days", "1",
            "-subj", "/CN=localhost",
        ],
        check=True,
        capture_output=True,
    )
    ReceiverHandler.requests = []
    server = HTTPServer(("127.0.0.1", 0), ReceiverHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=cert_path, keyfile=key_path)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server, cert_path
    server.shutdown()
    thread.join(timeout=2)
    server.server_close()


def write_alert(path: Path, rule_id: str, data: dict) -> None:
    path.write_text(
        json.dumps({"rule": {"id": rule_id, "level": 12}, "data": data}),
        encoding="utf-8",
    )


def invoke(monkeypatch: pytest.MonkeyPatch, alert_path: Path, endpoint: str, secret_path: Path) -> int:
    monkeypatch.setenv("UMOJA_SOD_INCIDENT_ENDPOINT", endpoint)
    monkeypatch.setenv("UMOJA_SOD_INCIDENT_HMAC_SECRET_FILE", str(secret_path))
    return handler_module.main.__wrapped__() if hasattr(handler_module.main, "__wrapped__") else handler_module.main()


def test_exception_alert_is_signed_and_received(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mock_pagerduty,
) -> None:
    server, cert_path = mock_pagerduty
    secret = b"ci-only-test-secret"
    secret_path = tmp_path / "incident.secret"
    secret_path.write_bytes(secret)
    alert_path = tmp_path / "alert.json"
    payload = {
        "event": "sod_monitor_evaluation",
        "evaluationState": "exceptions_detected",
        "exceptionDigest": "a" * 64,
        "exceptionCount": 1,
        "correlationId": "11111111-1111-1111-1111-111111111111",
    }
    write_alert(alert_path, "100810", payload)

    trusted_context = ssl.create_default_context(cafile=cert_path)
    monkeypatch.setattr(handler_module.ssl, "create_default_context", lambda: trusted_context)
    monkeypatch.setattr(handler_module.sys, "argv", [str(HANDLER_PATH), str(alert_path)])
    monkeypatch.setenv("UMOJA_SOD_INCIDENT_ENDPOINT", f"https://localhost:{server.server_port}/v2/enqueue")
    monkeypatch.setenv("UMOJA_SOD_INCIDENT_HMAC_SECRET_FILE", str(secret_path))

    assert handler_module.main() == 0
    assert len(ReceiverHandler.requests) == 1
    body, signature = ReceiverHandler.requests[0]
    expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    assert hmac.compare_digest(signature, expected)
    received = json.loads(body)
    assert received["correlationId"] == payload["correlationId"]
    assert received["exceptionDigest"] == payload["exceptionDigest"]


def test_audit_tamper_rule_is_forwarded_and_invalid_path_is_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mock_pagerduty,
) -> None:
    server, cert_path = mock_pagerduty
    secret_path = tmp_path / "incident.secret"
    secret_path.write_bytes(b"ci-only-test-secret")
    alert_path = tmp_path / "tamper.json"
    write_alert(alert_path, "100820", {"syscheck": {"path": "/var/log/umoja/sod-audit.jsonl"}})
    trusted_context = ssl.create_default_context(cafile=cert_path)
    monkeypatch.setattr(handler_module.ssl, "create_default_context", lambda: trusted_context)
    monkeypatch.setattr(handler_module.sys, "argv", [str(HANDLER_PATH), str(alert_path)])
    monkeypatch.setenv("UMOJA_SOD_INCIDENT_ENDPOINT", f"https://localhost:{server.server_port}/v2/enqueue")
    monkeypatch.setenv("UMOJA_SOD_INCIDENT_HMAC_SECRET_FILE", str(secret_path))
    assert handler_module.main() == 0
    assert len(ReceiverHandler.requests) == 1

    write_alert(alert_path, "100820", {"syscheck": {"path": "/tmp/not-the-audit-log"}})
    assert handler_module.main() == 1
    assert len(ReceiverHandler.requests) == 1
