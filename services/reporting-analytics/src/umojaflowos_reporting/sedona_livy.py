"""Apache Sedona aggregate-job client over a configured Livy endpoint."""

from __future__ import annotations

import json
import socket
import ssl
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class SedonaUnavailable(RuntimeError):
    pass


def _loopback(host: str | None) -> bool:
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    if not host:
        return False
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class SedonaLivyConfig:
    base_url: str
    bearer_token: str
    aggregate_job_uri: str
    allow_insecure_loopback: bool = False

    def validate(self) -> None:
        parsed = urlparse(self.base_url)
        job_uri = urlparse(self.aggregate_job_uri)
        if not parsed.hostname or parsed.username or parsed.password or not job_uri.scheme:
            raise SedonaUnavailable("Sedona endpoint and job artifact must be absolute credential-free URLs")
        if parsed.scheme == "https":
            pass
        elif parsed.scheme == "http" and self.allow_insecure_loopback and _loopback(parsed.hostname):
            pass
        else:
            raise SedonaUnavailable("Sedona Livy transport must be HTTPS outside the explicit loopback exception")
        if not self.bearer_token:
            raise SedonaUnavailable("Sedona Livy bearer token is required")
        if job_uri.scheme != "https":
            raise SedonaUnavailable("Sedona aggregate job artifact must be HTTPS")


class SedonaAggregateJobClient:
    def __init__(self, config: SedonaLivyConfig) -> None:
        config.validate()
        self._config = config

    def submit(self, input_uri: str, output_uri: str, metric_name: str, h3_resolution: int) -> int:
        if not input_uri.startswith("s3://") or not output_uri.startswith("s3://"):
            raise SedonaUnavailable("Sedona inputs and outputs must be S3-compatible lakehouse URIs")
        if not metric_name.strip() or not 5 <= h3_resolution <= 9:
            raise SedonaUnavailable("Sedona aggregate metric and H3 resolution are invalid")
        payload = json.dumps(
            {
                "file": self._config.aggregate_job_uri,
                "className": "org.apache.spark.deploy.PythonRunner",
                "args": [input_uri, output_uri, metric_name, str(h3_resolution)],
                "conf": {
                    "spark.sql.extensions": "org.apache.sedona.sql.SedonaSqlExtensions",
                    "spark.serializer": "org.apache.spark.serializer.KryoSerializer",
                    "spark.kryo.registrator": "org.apache.sedona.core.serde.SedonaKryoRegistrator",
                },
            },
            separators=(",", ":"),
        ).encode("utf-8")
        request = Request(
            f"{self._config.base_url.rstrip('/')}/batches",
            method="POST",
            data=payload,
            headers={"Authorization": f"Bearer {self._config.bearer_token}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
                if response.status not in {200, 201}:
                    raise SedonaUnavailable(f"Sedona Livy returned status {response.status}")
                body: dict[str, Any] = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise SedonaUnavailable(f"Sedona Livy returned status {exc.code}") from exc
        except (URLError, socket.timeout, TimeoutError, ssl.SSLError, json.JSONDecodeError) as exc:
            raise SedonaUnavailable("Sedona Livy endpoint is unavailable") from exc
        batch_id = body.get("id")
        if not isinstance(batch_id, int) or batch_id < 0:
            raise SedonaUnavailable("Sedona Livy response omitted its batch id")
        return batch_id
