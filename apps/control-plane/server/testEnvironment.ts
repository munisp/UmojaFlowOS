// Test-only environment contract. Production must provide every security-relevant
// setting explicitly through its managed deployment configuration.
process.env.UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS ??= "provider.example.com,channel.example,other.example.com";
