from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from umojaflowos_reporting.regulatory_submission import (
    AuthorisedRegulatoryChannel,
    RegulatorySubmissionRequest,
    RegulatorySubmissionUnavailable,
)


class _Response:
    status = 202

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self, _limit: int) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def request() -> RegulatorySubmissionRequest:
    return RegulatorySubmissionRequest(
        regulator="CBN",
        report_type="monthly-return",
        regulated_entity_id="entity-001",
        artifact_uri="https://evidence.example/reports/monthly-return.json",
        artifact_digest="a" * 64,
        evidence_manifest={"record_count": 1, "source_hash": "b" * 64},
        correlation_id="report-001",
    )


class RegulatorySubmissionTests(unittest.TestCase):
    def test_requires_https_channel(self) -> None:
        with self.assertRaises(RegulatorySubmissionUnavailable):
            AuthorisedRegulatoryChannel(endpoint="http://channel.example/submit", api_key="x" * 16, channel_reference="cbn-channel")

    def test_records_only_an_attributable_receipt(self) -> None:
        channel = AuthorisedRegulatoryChannel(endpoint="https://channel.example/submit", api_key="x" * 16, channel_reference="cbn-channel")
        body = json.dumps({"external_reference": "CBN-ACK-1001", "state": "accepted"}).encode("utf-8")
        with patch("umojaflowos_reporting.regulatory_submission.urlopen", return_value=_Response(body)) as opener:
            receipt = channel.submit(request())
        self.assertEqual(receipt.external_reference, "CBN-ACK-1001")
        self.assertEqual(receipt.state, "accepted")
        self.assertEqual(len(receipt.response_evidence_sha256), 64)
        outbound = opener.call_args.args[0]
        self.assertEqual(outbound.get_header("X-umoja-correlation-id"), "report-001")

    def test_refuses_receipt_without_external_reference(self) -> None:
        channel = AuthorisedRegulatoryChannel(endpoint="https://channel.example/submit", api_key="x" * 16, channel_reference="cbn-channel")
        with patch("umojaflowos_reporting.regulatory_submission.urlopen", return_value=_Response(b'{"state":"accepted"}')):
            with self.assertRaises(RegulatorySubmissionUnavailable):
                channel.submit(request())


if __name__ == "__main__":
    unittest.main()
