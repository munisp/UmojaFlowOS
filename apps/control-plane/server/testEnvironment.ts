import { afterAll } from "vitest";
import { closeRegisteredTestResources } from "./testResourceRegistry";

// Test-only environment contract. Production must provide every security-relevant
// setting explicitly through its managed deployment configuration.
process.env.UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS ??= "provider.example.com,channel.example,other.example.com";

afterAll(async () => {
  await closeRegisteredTestResources();
});
