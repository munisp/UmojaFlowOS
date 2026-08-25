from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from simulators.production_dependencies.aml_client import AmlScreeningClient


class ResponseHandler(BaseHTTPRequestHandler):
    response_body = {"decision": "clear", "provider": "simulated-secondary"}
    delay_seconds = 0.0
    status = 200

    def do_POST(self) -> None:  # noqa: N802
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        body = json.dumps(self.response_body).encode()
        self.send_response(self.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


def run_server(handler: type[ResponseHandler]) -> tuple[ThreadingHTTPServer, threading.Thread]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def test_timeout_fails_over_to_secondary_provider() -> None:
    class SlowPrimary(ResponseHandler):
        delay_seconds = 0.25
        response_body = {"decision": "clear", "provider": "primary"}

    class HealthySecondary(ResponseHandler):
        response_body = {"decision": "hit", "provider": "secondary"}

    primary, _ = run_server(SlowPrimary)
    secondary, _ = run_server(HealthySecondary)
    try:
        client = AmlScreeningClient(
            [
                f"http://127.0.0.1:{primary.server_port}/v1/aml/screen",
                f"http://127.0.0.1:{secondary.server_port}/v1/aml/screen",
            ],
            timeout_seconds=0.05,
        )
        started = time.monotonic()
        result = client.screen({"subject_id": "subject-1", "email": "x@example.test"})
        elapsed = time.monotonic() - started
        assert result.decision == "hit"
        assert result.review_required is True
        assert result.provider == "secondary"
        assert result.attempts == 2
        assert elapsed < 0.20
    finally:
        primary.shutdown()
        secondary.shutdown()


def test_dual_provider_outage_is_indeterminate_and_review_required() -> None:
    class DownstreamFailure(ResponseHandler):
        status = 503
        response_body = {"error": "unavailable"}

    first, _ = run_server(DownstreamFailure)
    second, _ = run_server(DownstreamFailure)
    try:
        client = AmlScreeningClient(
            [
                f"http://127.0.0.1:{first.server_port}/v1/aml/screen",
                f"http://127.0.0.1:{second.server_port}/v1/aml/screen",
            ],
            timeout_seconds=0.10,
        )
        result = client.screen({"subject_id": "subject-2"})
        assert result.decision == "indeterminate"
        assert result.review_required is True
        assert result.provider == "unavailable"
        assert result.attempts == 2
    finally:
        first.shutdown()
        second.shutdown()
