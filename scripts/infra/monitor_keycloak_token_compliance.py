#!/usr/bin/env python3
"""Monitor Keycloak client-credentials TTL and revocation behavior.

The monitor never prints tokens. Revocation tests must use a dedicated canary client.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Config:
    base_url: str
    realm: str
    client_id: str
    client_secret: str
    expected_audience: str
    expected_issuer: str
    max_ttl: int
    min_ttl: int
    timeout: float
    revoke_canary: bool


def post_form(url: str, values: dict[str, str], timeout: float) -> dict:
    body = urllib.parse.urlencode(values).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def token(cfg: Config) -> dict:
    return post_form(
        f"{cfg.base_url}/realms/{cfg.realm}/protocol/openid-connect/token",
        {
            "grant_type": "client_credentials",
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
            "scope": "evidence.publish",
        },
        cfg.timeout,
    )


def introspect(cfg: Config, access_token: str) -> dict:
    return post_form(
        f"{cfg.base_url}/realms/{cfg.realm}/protocol/openid-connect/token/introspect",
        {
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
            "token": access_token,
            "token_type_hint": "access_token",
        },
        cfg.timeout,
    )


def revoke(cfg: Config, access_token: str) -> None:
    post_form(
        f"{cfg.base_url}/realms/{cfg.realm}/protocol/openid-connect/revoke",
        {
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
            "token": access_token,
            "token_type_hint": "access_token",
        },
        cfg.timeout,
    )


def metric(name: str, value: int | float, labels: dict[str, str] | None = None) -> str:
    encoded = ""
    if labels:
        encoded = "{" + ",".join(f'{k}="{v.replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"' for k, v in labels.items()) + "}"
    return f"{name}{encoded} {value}\n"


def run(cfg: Config) -> tuple[int, str]:
    started = time.monotonic()
    labels = {"realm": cfg.realm, "client_id": cfg.client_id}
    lines = [
        "# HELP umoja_keycloak_token_monitor_up Whether the last compliance check passed.",
        "# TYPE umoja_keycloak_token_monitor_up gauge",
    ]
    try:
        issued = token(cfg)
        access_token = issued.get("access_token")
        expires_in = int(issued.get("expires_in", 0))
        if not isinstance(access_token, str) or not access_token:
            raise RuntimeError("Keycloak token response did not contain an access token")
        if not cfg.min_ttl <= expires_in <= cfg.max_ttl:
            raise RuntimeError(f"token TTL {expires_in}s outside [{cfg.min_ttl},{cfg.max_ttl}]s")

        active = introspect(cfg, access_token)
        if active.get("active") is not True:
            raise RuntimeError("newly issued token is not active under introspection")
        if active.get("iss") != cfg.expected_issuer:
            raise RuntimeError("introspection issuer mismatch")
        audience = active.get("aud", [])
        if isinstance(audience, str):
            audience = [audience]
        if cfg.expected_audience not in audience:
            raise RuntimeError("introspection audience mismatch")
        if cfg.revoke_canary:
            revoke(cfg, access_token)
            revoked = introspect(cfg, access_token)
            if revoked.get("active") is not False:
                raise RuntimeError("revocation canary token remained active")

        lines.append(metric("umoja_keycloak_token_monitor_up", 1, labels).rstrip("\n"))
        lines.append(metric("umoja_keycloak_token_ttl_seconds", expires_in, labels).rstrip("\n"))
        lines.append(metric("umoja_keycloak_token_revocation_check", 1 if cfg.revoke_canary else 0, labels).rstrip("\n"))
        return 0, "".join(lines) + metric("umoja_keycloak_token_monitor_failures_total", 0, labels)
    except Exception as exc:  # noqa: BLE001 - monitor must turn all failures into metrics
        lines.append(metric("umoja_keycloak_token_monitor_up", 0, labels).rstrip("\n"))
        lines.append(metric("umoja_keycloak_token_monitor_failures_total", 1, labels).rstrip("\n"))
        lines.append(metric("umoja_keycloak_token_monitor_duration_seconds", time.monotonic() - started, labels).rstrip("\n"))
        return 1, "".join(lines) + f"# monitor_error={type(exc).__name__}\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revoke-canary", action="store_true", help="revoke a dedicated canary token and verify inactive")
    parser.add_argument("--metrics-file", type=Path)
    args = parser.parse_args()
    base_url = os.environ["KEYCLOAK_BASE_URL"].rstrip("/")
    realm = os.environ["KEYCLOAK_REALM"]
    cfg = Config(
        base_url=base_url,
        realm=realm,
        client_id=os.environ["KEYCLOAK_CLIENT_ID"],
        client_secret=os.environ["KEYCLOAK_CLIENT_SECRET"],
        expected_audience=os.getenv("KEYCLOAK_EXPECTED_AUDIENCE", os.environ["KEYCLOAK_CLIENT_ID"]),
        expected_issuer=os.getenv("KEYCLOAK_EXPECTED_ISSUER", f"{base_url}/realms/{realm}"),
        max_ttl=int(os.getenv("KEYCLOAK_MAX_TOKEN_TTL_SECONDS", "300")),
        min_ttl=int(os.getenv("KEYCLOAK_MIN_TOKEN_TTL_SECONDS", "1")),
        timeout=float(os.getenv("KEYCLOAK_HTTP_TIMEOUT_SECONDS", "5")),
        revoke_canary=args.revoke_canary,
    )
    code, output = run(cfg)
    if args.metrics_file:
        args.metrics_file.parent.mkdir(parents=True, exist_ok=True)
        args.metrics_file.write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
