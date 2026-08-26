import { describe, expect, it } from "vitest";

import { normaliseProviderEndpoint, providerEndpointAllowedHosts } from "./postgres";

const approved = { UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS: "provider.example.com,api.channel.example" };

describe("provider credential-bearing endpoint boundary", () => {
  it("accepts an exact approved HTTPS DNS host", () => {
    expect(normaliseProviderEndpoint("https://provider.example.com/v1/health", approved)).toBe(
      "https://provider.example.com/v1/health",
    );
  });

  it.each([
    "https://127.0.0.1/metadata",
    "https://10.0.0.1/health",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/health",
  ])("rejects IP-literal target %s", endpoint => {
    expect(() => normaliseProviderEndpoint(endpoint, approved)).toThrow(/not an IP literal/i);
  });

  it("rejects an unapproved DNS destination", () => {
    expect(() => normaliseProviderEndpoint("https://attacker.example/health", approved)).toThrow(
      /host is not approved/i,
    );
  });

  it("fails closed when the deployment allow-list is absent or malformed", () => {
    expect(() => providerEndpointAllowedHosts({})).toThrow(/must list approved provider DNS hosts/i);
    expect(() => providerEndpointAllowedHosts({ UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS: "127.0.0.1" })).toThrow(
      /invalid DNS host/i,
    );
  });
});
