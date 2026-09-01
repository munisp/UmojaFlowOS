import { describe, expect, it } from "vitest";
import { credentials } from "@grpc/grpc-js";
import { createHash } from "node:crypto";
import { SettlementClient, SettlementRequest, SettlementQueryRequest } from "../../../sdk/typescript/umoja/settlement/v1/settlement";

describe("typed settlement gRPC cross-language contract", () => {
  it("executes and queries against the local CI settlement service", async () => {
    if (process.env.SETTLEMENT_GRPC_CI !== "1") return;
    const target = process.env.SETTLEMENT_GRPC_TARGET ?? "127.0.0.1:18443";
    const client = new SettlementClient(target, credentials.createInsecure());
    const payload = Buffer.from('{"intent":"ci"}');
    const digest = createHash("sha256").update(payload).digest("hex");
    const request: SettlementRequest = {
      intentId: "ci-intent",
      idempotencyKey: "ci-idempotency",
      tenantId: "ci-tenant",
      direction: "onramp",
      asset: "USDC",
      fiat: "NGN",
      amountMinor: 100,
      destination: "ci-destination",
      canonicalPayload: payload,
      payloadSha256: digest,
      expiresAtRfc3339: "2099-01-01T00:00:00Z",
    };
    const result = await new Promise<any>((resolve, reject) => client.execute(request, (err, value) => err ? reject(err) : resolve(value)));
    expect(result.state).toBe("settled");
    expect(result.payloadSha256).toBe(digest);
    const queried = await new Promise<any>((resolve, reject) => client.query({
      intentId: "ci-intent", idempotencyKey: "ci-idempotency", tenantId: "ci-tenant",
      asset: "USDC", fiat: "NGN", payloadSha256: digest,
    } as SettlementQueryRequest, (err, value) => err ? reject(err) : resolve(value)));
    expect(queried.reference).toBe("ci-reference");
    expect(queried.payloadSha256).toBe(digest);
    client.close();
  });
});
