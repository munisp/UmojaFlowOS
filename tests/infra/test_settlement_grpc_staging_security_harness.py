import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts/infra/test_settlement_grpc_staging_security.py"
SPEC = importlib.util.spec_from_file_location("settlement_security_harness", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class StructuredEnvoyAssertionsTest(unittest.TestCase):
    def test_json_parser_ignores_non_json_lines(self):
        records = MODULE._json_access_log_lines(
            'not-json\n{"response_code":200,"response_code_details":"via_upstream"}\n'
        )
        self.assertEqual(records, [{"response_code": 200, "response_code_details": "via_upstream"}])

    def test_allowlisted_200_is_accepted(self):
        MODULE._assert_envoy_status(
            [{"response_code": 200, "response_code_details": "via_upstream", "response_flags": "-"}],
            200,
            denied=False,
        )

    def test_allowlisted_rbac_denial_is_rejected(self):
        with self.assertRaises(MODULE.CheckFailure):
            MODULE._assert_envoy_status(
                [{"response_code": 200, "response_code_details": "rbac_access_denied_matched"}],
                200,
                denied=False,
            )

    def test_streaming_sample_is_bounded_and_stops_after_both_classes(self):
        def lines():
            yield '{"response_code": 200, "response_code_details": "via_upstream"}'
            yield '{"response_code": 403, "response_code_details": "rbac_access_denied_matched"}'
            raise AssertionError("stream should stop after required evidence classes")

        sample, saw_allow, saw_deny = MODULE._inspect_envoy_logs(lines(), max_samples=1)
        self.assertTrue(saw_allow)
        self.assertTrue(saw_deny)
        self.assertLessEqual(len(sample), 1)

    def test_403_requires_rbac_signal(self):
        with self.assertRaises(MODULE.CheckFailure):
            MODULE._assert_envoy_status(
                [{"response_code": 403, "response_code_details": "upstream_reset_before_response_started"}],
                403,
                denied=True,
            )
        MODULE._assert_envoy_status(
            [{"response_code": 403, "response_code_details": "rbac_access_denied_matched"}],
            403,
            denied=True,
        )


if __name__ == "__main__":
    unittest.main()
