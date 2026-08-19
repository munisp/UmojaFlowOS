import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeProviderEndpoint, resolveCredential } from "./providerHealthCheck";

/**
 * The probe is exercised against a real HTTP server rather than a mocked fetch,
 * because the behaviour that matters — what happens on a 401, a redirect, a
 * timeout, a closed socket — lives in the network layer, and a mock would only
 * confirm the assumptions already encoded in the code under test.
 *
 * Note these use plain HTTP on loopback. The https requirement is enforced when
 * the endpoint is *stored*, which is where it belongs; the probe's job is to
 * report what a request returned.
 */
let server: Server | undefined;

async function serve(handler: (status: number) => number, options: { delayMs?: number } = {}): Promise<string> {
  server = createServer((req, res) => {
    const respond = () => {
      const status = handler(200);
      if (status >= 300 && status < 400) {
        res.writeHead(status, { Location: "https://elsewhere.example.com" });
        res.end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 400 }));
    };
    if (options.delayMs) setTimeout(respond, options.delayMs);
    else respond();
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return `http://127.0.0.1:${address.port}/health`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
  delete process.env.TEST_PROVIDER_CREDENTIAL;
});

describe("provider health check probe", () => {
  it("reports unreachable when the named deployment secret is absent", async () => {
    const endpoint = await serve(() => 200);
    // No credential is set, so no authenticated request can be made. This must
    // be reported rather than silently sending an empty Authorization header.
    const outcome = await probeProviderEndpoint({ endpoint, secretReference: "ABSENT_PROVIDER_SECRET" });
    expect(outcome.reachable).toBe(false);
    expect(outcome.httpStatus).toBeNull();
    expect(outcome.detail).toMatch(/ABSENT_PROVIDER_SECRET is not present/);
  });

  it("treats a whitespace-only secret as absent", () => {
    process.env.TEST_PROVIDER_CREDENTIAL = "   ";
    expect(resolveCredential("TEST_PROVIDER_CREDENTIAL")).toBeNull();
  });

  it("reports a successful response", async () => {
    process.env.TEST_PROVIDER_CREDENTIAL = "real-value";
    const endpoint = await serve(() => 200);
    const outcome = await probeProviderEndpoint({ endpoint, secretReference: "TEST_PROVIDER_CREDENTIAL" });
    expect(outcome.reachable).toBe(true);
    expect(outcome.httpStatus).toBe(200);
  });

  it("distinguishes a rejected credential from a provider fault", async () => {
    process.env.TEST_PROVIDER_CREDENTIAL = "wrong-value";
    const rejected = await probeProviderEndpoint({ endpoint: await serve(() => 401), secretReference: "TEST_PROVIDER_CREDENTIAL" });
    expect(rejected.httpStatus).toBe(401);
    expect(rejected.detail).toMatch(/rejected the supplied credential/);

    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;

    const faulted = await probeProviderEndpoint({ endpoint: await serve(() => 503), secretReference: "TEST_PROVIDER_CREDENTIAL" });
    expect(faulted.httpStatus).toBe(503);
    expect(faulted.detail).toMatch(/returned 503/);
  });

  it("does not follow a redirect, which could send the credential elsewhere", async () => {
    process.env.TEST_PROVIDER_CREDENTIAL = "real-value";
    const outcome = await probeProviderEndpoint({ endpoint: await serve(() => 302), secretReference: "TEST_PROVIDER_CREDENTIAL" });
    expect(outcome.httpStatus).toBe(302);
    expect(outcome.detail).toMatch(/redirected/);
  });

  it("reports a timeout rather than hanging", async () => {
    process.env.TEST_PROVIDER_CREDENTIAL = "real-value";
    const endpoint = await serve(() => 200, { delayMs: 2_000 });
    const outcome = await probeProviderEndpoint({ endpoint, secretReference: "TEST_PROVIDER_CREDENTIAL", timeoutMs: 150 });
    expect(outcome.reachable).toBe(false);
    expect(outcome.detail).toMatch(/did not respond within 150ms/);
  });

  it("reports an unreachable endpoint with a stated reason", async () => {
    process.env.TEST_PROVIDER_CREDENTIAL = "real-value";
    // Port 1 on loopback refuses connections.
    const outcome = await probeProviderEndpoint({ endpoint: "http://127.0.0.1:1/health", secretReference: "TEST_PROVIDER_CREDENTIAL" });
    expect(outcome.reachable).toBe(false);
    expect(outcome.detail).toMatch(/unreachable/);
  });

  it("never returns the credential in its outcome", async () => {
    process.env.TEST_PROVIDER_CREDENTIAL = "super-secret-value";
    const outcome = await probeProviderEndpoint({ endpoint: await serve(() => 200), secretReference: "TEST_PROVIDER_CREDENTIAL" });
    expect(JSON.stringify(outcome)).not.toContain("super-secret-value");
  });
});
