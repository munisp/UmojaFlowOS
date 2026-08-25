#!/usr/bin/env python3
"""Validates the fail-closed activation contract of every middleware template.

Each middleware component under ``infra/`` ships an environment template that
must be safe to commit and safe to deploy unchanged. This validator enforces
that contract mechanically so a template cannot drift into a state where a
component is enabled by default, a placeholder is mistaken for a credential, or
a security control is silently switched off.

The rules are deliberately conservative:

1. Every template declares an explicit ``*_ENABLED`` flag and it must be false.
2. No template contains a literal secret; credentials are secret references
   named either ``*_SECRET_REF`` or ``*_REFERENCE``.
3. Every secret reference is either explicitly unset or carries the replacement
   placeholder; it may never carry an inline credential value.
4. Any TLS, verification, or fail-closed control present must be true.

Exit status is non-zero when any rule is violated, so this runs in CI.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INFRA_ROOT = REPO_ROOT / "infra"
PLACEHOLDER = "REPLACE_WITH"

# Controls that, when present, must be enabled. Disabling any of them changes
# the security posture and must therefore be a reviewed code change rather than
# an unnoticed template edit.
MUST_BE_TRUE_SUFFIXES = (
    "_TLS_REQUIRED",
    "_TLS_VERIFY",
    "_FAIL_CLOSED",
    "_REQUIRED",
)

# Keys that legitimately hold a non-secret value even though their name could
# suggest otherwise.
ALLOWED_NON_SECRET_KEYS = {
    "OPENAPPSEC_MODE",
    "MOJALOOP_SCHEME_AUTHORISATION_REFERENCE",
    "MOJALOOP_PARTICIPANT_ID",
    # Keycloak is matched by SECRETISH because its name contains "KEY", but
    # issuer, audience and its activation controls are public OIDC metadata.
    # Any private client secret still has to use the normal *_SECRET_REF form.
    "UMOJA_KEYCLOAK_ENABLED",
    "UMOJA_KEYCLOAK_ISSUER",
    "UMOJA_KEYCLOAK_AUDIENCE",
    "UMOJA_KEYCLOAK_TLS_REQUIRED",
    "UMOJA_KEYCLOAK_FAIL_CLOSED",
    "KEYCLOAK_OIDC_DISCOVERY_URL",
    "UMOJA_KEYCLOAK_INTERNAL_HTTPS_PORT",
}

SECRETISH = re.compile(r"(PASSWORD|TOKEN|SECRET|KEY|CREDENTIAL)")

# Both naming conventions in the repository denote an indirection to a managed
# secret rather than an inline value.
SECRET_REFERENCE_SUFFIXES = ("_SECRET_REF", "_REFERENCE")


def parse_template(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def validate(path: Path, values: dict[str, str]) -> list[str]:
    failures: list[str] = []
    relative = path.relative_to(REPO_ROOT)

    enabled_keys = [key for key in values if key.endswith("_ENABLED")]
    if not enabled_keys:
        failures.append(f"{relative}: no *_ENABLED activation flag is declared")
    for key in enabled_keys:
        if values[key].lower() != "false":
            failures.append(f"{relative}: {key} must be false in a committed template, found {values[key]!r}")

    for key, value in values.items():
        if key.endswith(SECRET_REFERENCE_SUFFIXES):
            # An empty value is the strongest possible committed state: nothing
            # is configured at all. A placeholder is equally safe. Anything else
            # would mean a real reference (or worse, a literal) was committed.
            if value and PLACEHOLDER not in value:
                failures.append(
                    f"{relative}: {key} must be empty or hold the {PLACEHOLDER} placeholder, found {value!r}"
                )
            continue

        if SECRETISH.search(key) and key not in ALLOWED_NON_SECRET_KEYS:
            # A secret-shaped key that is not a reference and not an explicit
            # placeholder would mean a literal credential is committed.
            if PLACEHOLDER not in value and not key.endswith(("_ID", "_PATH", "_CODE")):
                failures.append(
                    f"{relative}: {key} looks like a credential; use a *_SECRET_REF or *_REFERENCE indirection instead"
                )

        if key.endswith(MUST_BE_TRUE_SUFFIXES) and value.lower() != "true":
            failures.append(f"{relative}: {key} must be true, found {value!r}")

    return failures


def main() -> int:
    templates = sorted(INFRA_ROOT.rglob("*.env.template"))
    if not templates:
        print("no middleware environment templates were found", file=sys.stderr)
        return 2

    failures: list[str] = []
    for path in templates:
        failures.extend(validate(path, parse_template(path)))

    for failure in failures:
        print(failure, file=sys.stderr)

    print(f"validated {len(templates)} middleware activation templates")
    if failures:
        print(f"{len(failures)} activation-contract violation(s) found", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
