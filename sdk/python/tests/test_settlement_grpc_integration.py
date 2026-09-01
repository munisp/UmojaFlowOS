import hashlib
import os
import unittest

try:
    import grpc
    from umoja.settlement.v1 import settlement_pb2, settlement_pb2_grpc
except ImportError:  # pragma: no cover
    grpc = None


@unittest.skipUnless(grpc is not None and os.getenv("SETTLEMENT_GRPC_CI") == "1", "requires CI gRPC server and grpcio")
class SettlementGrpcIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.channel = grpc.insecure_channel(os.getenv("SETTLEMENT_GRPC_TARGET", "127.0.0.1:18443"))
        self.client = settlement_pb2_grpc.SettlementStub(self.channel)
        self.payload = b'{"intent":"ci"}'

    def tearDown(self):
        self.channel.close()

    def test_execute_and_query_typed_contract(self):
        digest = hashlib.sha256(self.payload).hexdigest()
        request = settlement_pb2.SettlementRequest(
            intent_id="ci-intent",
            idempotency_key="ci-idempotency",
            tenant_id="ci-tenant",
            direction="onramp",
            asset="USDC",
            fiat="NGN",
            amount_minor=100,
            destination="ci-destination",
            canonical_payload=self.payload,
            payload_sha256=digest,
            expires_at_rfc3339="2099-01-01T00:00:00Z",
        )
        result = self.client.Execute(request)
        self.assertEqual(result.state, "settled")
        self.assertEqual(result.payload_sha256, digest)
        queried = self.client.Query(settlement_pb2.SettlementQueryRequest(
            intent_id="ci-intent", idempotency_key="ci-idempotency", tenant_id="ci-tenant",
            asset="USDC", fiat="NGN", payload_sha256=digest,
        ))
        self.assertEqual(queried.reference, "ci-reference")
        self.assertEqual(queried.payload_sha256, digest)


if __name__ == "__main__":
    unittest.main()
