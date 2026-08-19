#!/usr/bin/env python3
"""Regression tests for the tracked-source secret-material guard."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_secret_material.py")
SPEC = importlib.util.spec_from_file_location("secret_material", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SecretMaterialGuardTests(unittest.TestCase):
    def scan(self, files: dict[str, str]) -> list[str]:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths: list[Path] = []
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
                paths.append(path)
            return MODULE.find_violations(root, paths)

    def test_allows_public_certificate_and_named_secret_reference(self) -> None:
        violations = self.scan(
            {
                "infra/example.env.template": "UMOJA_PROVIDER_TOKEN_SECRET_REF=REPLACE_WITH_SECRET_REFERENCE\n",
                "docs/trust.md": "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----\n",
            }
        )
        self.assertEqual([], violations)

    def test_rejects_private_key_material(self) -> None:
        marker = "-----BEGIN " + "PRIVATE KEY-----"
        violations = self.scan({"docs/unsafe.md": marker + "\nnot-a-key\n"})
        self.assertEqual(1, len(violations))
        self.assertIn("private-key material", violations[0])

    def test_rejects_literal_bearer_credential(self) -> None:
        header = "Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz012345"
        violations = self.scan({"docs/unsafe.md": header + "\n"})
        self.assertEqual(1, len(violations))
        self.assertIn("bearer credential", violations[0])

    def test_rejects_literal_template_credential(self) -> None:
        violations = self.scan({"infra/unsafe.env.template": "KAFKA_SASL_PASSWORD=not-a-reference\n"})
        self.assertEqual(1, len(violations))
        self.assertIn("deployment-secret reference", violations[0])

    def test_rejects_literal_credential_assignment_in_source(self) -> None:
        literal = "abcdefghijklmnopqrstuvwxyz012345"
        violations = self.scan({"src/unsafe.ts": f'const providerToken = "{literal}";\n'})
        self.assertEqual(1, len(violations))
        self.assertIn("literal credential in source", violations[0])

    def test_allows_environment_derived_source_assignment(self) -> None:
        violations = self.scan({"src/safe.ts": "const providerToken = process.env.PROVIDER_TOKEN;\n"})
        self.assertEqual([], violations)


if __name__ == "__main__":
    unittest.main()
