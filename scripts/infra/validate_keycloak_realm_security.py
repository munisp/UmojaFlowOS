#!/usr/bin/env python3
"""Validate the committed Keycloak realm against UmojaFlowOS privileged-access baselines.

This checks the importable realm artefact, not live identity-provider assurance.
A platform security owner must separately prove the imported realm, enrolled users,
phishing-resistant MFA policy, access reviews, and audit retention in production.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REALM_PATH = ROOT / "infra/keycloak/realm-umojaflowos.json"


def fail(message: str) -> None:
    print(f"keycloak realm security validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    realm = json.loads(REALM_PATH.read_text(encoding="utf-8"))
    if realm.get("realm") != "umojaflowos" or realm.get("enabled") is not True:
        fail("expected enabled umojaflowos realm")
    if realm.get("sslRequired") != "external":
        fail("TLS must be required for external access")
    if realm.get("rememberMe") is not False or realm.get("revokeRefreshToken") is not True:
        fail("remember-me must be disabled and refresh-token revocation enabled")
    if realm.get("bruteForceProtected") is not True or realm.get("failureFactor", 0) > 5:
        fail("brute-force protection must be enabled with a failure factor no greater than five")
    if not (60 <= realm.get("accessTokenLifespan", 0) <= 300):
        fail("access-token lifetime must be between one and five minutes")
    if not (300 <= realm.get("ssoSessionIdleTimeout", 0) <= 900):
        fail("SSO idle timeout must be between five and fifteen minutes")
    required = {entry.get("alias"): entry for entry in realm.get("requiredActions", [])}
    totp = required.get("CONFIGURE_TOTP")
    if not totp or totp.get("enabled") is not True or totp.get("defaultAction") is not True:
        fail("TOTP enrolment must be enabled as a default required action")
    if realm.get("otpPolicyType") != "totp" or realm.get("otpPolicyAlgorithm") != "HmacSHA256" or realm.get("otpPolicyDigits") != 6 or realm.get("otpPolicyPeriod") != 30:
        fail("TOTP policy must use HmacSHA256, six digits, and a 30-second period")
    clients = {client.get("clientId"): client for client in realm.get("clients", [])}
    gateway = clients.get("umojaflowos-gateway")
    if not gateway:
        fail("gateway client is missing")
    if gateway.get("publicClient") is not False or gateway.get("directAccessGrantsEnabled") is not False or gateway.get("implicitFlowEnabled") is not False:
        fail("gateway must be confidential and disable direct-password and implicit flows")
    if gateway.get("standardFlowEnabled") is not True or gateway.get("attributes", {}).get("pkce.code.challenge.method") != "S256":
        fail("gateway must use authorization code flow with S256 PKCE")
    print("validated Keycloak privileged-access realm baseline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
