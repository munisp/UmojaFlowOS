#!/usr/bin/env python3
"""Fail a repository check when committed files contain credential material.

This is intentionally narrower than a generic entropy scanner. It protects the
paths most likely to leak an operational secret while avoiding false positives
for public certificates, deterministic digests, code examples, and named
deployment-secret references. The scanner examines tracked files only; local
uploaded material and deployment secret stores are deliberately outside its
scope.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[2]

PRIVATE_KEY = re.compile(r"-----BEGIN(?: [A-Z0-9]+){0,3} PRIVATE KEY-----")
LITERAL_BEARER = re.compile(
    r"(?i)authorization\s*:\s*bearer\s+(?!\$\{|<|REPLACE_WITH|example|test|dummy)[A-Za-z0-9._~+/=-]{20,}"
)
SENSITIVE_ASSIGNMENT = re.compile(
    r"""(?im)^
        \s*(?P<key>[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|CLIENT_SECRET|SASL_PASS)[A-Z0-9_]*)
        \s*[:=]\s*
        (?P<value>[^\s#]+)
        \s*$
    """,
    re.VERBOSE,
)

CONFIG_SUFFIXES = {".env", ".template", ".yaml", ".yml", ".json", ".md", ".toml", ".ini", ".conf"}
SAFE_VALUE_PREFIXES = ("${", "$", "<", "REPLACE_WITH", "example", "test", "dummy")
SAFE_REFERENCE_SUFFIXES = ("_REF", "_REFERENCE")


def tracked_paths(repository: Path) -> list[Path]:
    output = subprocess.check_output(
        ["git", "-C", str(repository), "ls-files", "-z"], text=False
    )
    return [repository / raw.decode("utf-8") for raw in output.split(b"\0") if raw]


def line_number(contents: str, offset: int) -> int:
    return contents.count("\n", 0, offset) + 1


def is_safe_secret_assignment(key: str, value: str) -> bool:
    upper_value = value.upper()
    return (
        key.endswith(SAFE_REFERENCE_SUFFIXES)
        or not value
        or upper_value.startswith(SAFE_VALUE_PREFIXES)
    )


def find_violations(repository: Path, paths: Iterable[Path]) -> list[str]:
    violations: list[str] = []
    for path in paths:
        if not path.is_file() or path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".pdf", ".zip"}:
            continue
        try:
            contents = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        relative = path.relative_to(repository)

        private_key = PRIVATE_KEY.search(contents)
        if private_key:
            violations.append(f"{relative}:{line_number(contents, private_key.start())}: committed private-key material")

        bearer = LITERAL_BEARER.search(contents)
        if bearer:
            violations.append(f"{relative}:{line_number(contents, bearer.start())}: committed bearer credential")

        if path.suffix.lower() not in CONFIG_SUFFIXES:
            continue
        for assignment in SENSITIVE_ASSIGNMENT.finditer(contents):
            key = assignment.group("key")
            value = assignment.group("value").strip('"\'')
            if not is_safe_secret_assignment(key, value):
                violations.append(
                    f"{relative}:{line_number(contents, assignment.start())}: {key} must use a named deployment-secret reference"
                )
    return violations


def main() -> int:
    violations = find_violations(REPO_ROOT, tracked_paths(REPO_ROOT))
    for violation in violations:
        print(violation, file=sys.stderr)
    if violations:
        print(f"{len(violations)} secret-material violation(s) found", file=sys.stderr)
        return 1
    print("validated tracked source contains no private-key or literal credential material")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
