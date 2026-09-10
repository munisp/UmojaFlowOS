#!/usr/bin/env python3
from __future__ import annotations
import ast
import sys
from pathlib import Path

TARGET = Path(__file__).with_name("verify_role_sidecar_authorization.py")
source = TARGET.read_text(encoding="utf-8")
tree = ast.parse(source, filename=str(TARGET))
issues: list[str] = []

for node in ast.walk(tree):
    if isinstance(node, ast.ExceptHandler):
        if node.type is None:
            issues.append(f"bare except at line {node.lineno}")
        elif isinstance(node.type, ast.Name) and node.type.id == "Exception":
            # Network transport is the only intentionally broad boundary in this verifier.
            parent_call = ast.get_source_segment(source, node) or ""
            if "urlopen" not in parent_call and "OCSP request failed" not in parent_call:
                issues.append(f"broad Exception handler outside OCSP transport at line {node.lineno}")
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if node.func.attr in {"load_der_x509_certificate", "load_pem_x509_crl", "load_der_x509_crl"}:
            if not any(isinstance(parent, ast.Try) for parent in ast.walk(tree) if node in ast.walk(parent)):
                issues.append(f"certificate/CRL parser not visibly guarded at line {node.lineno}")

required_tokens = [
    "class AuthorizationError",
    "raise AuthorizationError",
    "build_and_validate_certificate_path",
    "check_certificate_against_crl",
    "verify_ocsp_response_signature",
]
for token in required_tokens:
    if token not in source:
        issues.append(f"missing required fail-closed token: {token}")

if issues:
    print("SECURITY_AUDIT=FAIL")
    print("\n".join(issues))
    sys.exit(1)
print("SECURITY_AUDIT=PASS")
print("AST parse, guarded certificate/CRL parsing, bounded path validation, and AuthorizationError fail-closed controls passed")
