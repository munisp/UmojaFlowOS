from __future__ import annotations

import json
from types import SimpleNamespace

import scripts.infra.monitor_keycloak_token_compliance as monitor


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


def cfg(**overrides):
    values = dict(
        base_url="https://keycloak.test",
        realm="umoja",
        client_id="evidence-publisher",
        client_secret="secret",
        expected_audience="evidence-publisher",
        expected_issuer="https://keycloak.test/realms/umoja",
        max_ttl=300,
        min_ttl=60,
        timeout=1.0,
        revoke_canary=False,
    )
    values.update(overrides)
    return monitor.Config(**values)


def test_successful_ttl_and_introspection(monkeypatch):
    responses = iter([
        Response({"access_token": "opaque", "expires_in": 120}),
        Response({"active": True, "iss": "https://keycloak.test/realms/umoja", "aud": ["evidence-publisher"]}),
    ])
    monkeypatch.setattr(monitor.urllib.request, "urlopen", lambda *_args, **_kwargs: next(responses))
    code, output = monitor.run(cfg())
    assert code == 0
    assert "umoja_keycloak_token_monitor_up{realm=\"umoja\",client_id=\"evidence-publisher\"} 1" in output
    assert "opaque" not in output


def test_ttl_outside_policy_fails_closed(monkeypatch):
    monkeypatch.setattr(monitor.urllib.request, "urlopen", lambda *_args, **_kwargs: Response({"access_token": "opaque", "expires_in": 301}))
    code, output = monitor.run(cfg())
    assert code == 1
    assert "monitor_up" in output and " 0" in output
    assert "monitor_failures_total" in output


def test_issuer_mismatch_fails_closed(monkeypatch):
    responses = iter([
        Response({"access_token": "opaque", "expires_in": 120}),
        Response({"active": True, "iss": "https://wrong.example/realms/umoja", "aud": ["evidence-publisher"]}),
    ])
    monkeypatch.setattr(monitor.urllib.request, "urlopen", lambda *_args, **_kwargs: next(responses))
    code, _ = monitor.run(cfg())
    assert code == 1


def test_revocation_canary_requires_inactive_introspection(monkeypatch):
    responses = iter([
        Response({"access_token": "opaque", "expires_in": 120}),
        Response({"active": True, "iss": "https://keycloak.test/realms/umoja", "aud": ["evidence-publisher"]}),
        Response({}),
        Response({"active": True, "iss": "https://keycloak.test/realms/umoja", "aud": ["evidence-publisher"]}),
    ])
    monkeypatch.setattr(monitor.urllib.request, "urlopen", lambda *_args, **_kwargs: next(responses))
    code, output = monitor.run(cfg(revoke_canary=True))
    assert code == 1
    assert "monitor_failures_total" in output
