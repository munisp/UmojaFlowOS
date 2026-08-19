#!/usr/bin/env python3
"""Negative controls for the APISIX/open-appsec edge-policy validator."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_edge_policy import CONFIG, validate  # noqa: E402


class EdgePolicyValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.valid = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))

    def test_approved_configuration_passes(self) -> None:
        self.assertEqual(validate(self.valid), [])

    def test_missing_oidc_plugin_is_detected(self) -> None:
        invalid = copy.deepcopy(self.valid)
        invalid["routes"][0]["plugins"] = {}
        errors = validate(invalid)
        self.assertTrue(any("missing openid-connect gateway guard" in error for error in errors), errors)

    def test_insecure_oidc_tls_is_detected(self) -> None:
        invalid = copy.deepcopy(self.valid)
        invalid["routes"][0]["plugins"]["openid-connect"]["ssl_verify"] = False
        errors = validate(invalid)
        self.assertTrue(any("TLS verification" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
