import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = resolve(import.meta.dirname, "../template.json");

describe("portable deployment template", () => {
  it("contains only provider-neutral, open-source runtime contracts", () => {
    const source = readFileSync(templatePath, "utf8");
    const template = JSON.parse(source) as {
      runtime: Record<string, string>;
      configuration: { required_environment: string[]; secrets_policy: string };
    };

    expect(source.toLowerCase()).not.toMatch(/manus|mysql|drizzle|invokeLLM|listLLMModels/);
    expect(template.runtime.database).toMatch(/PostgreSQL/i);
    expect(template.runtime.identity).toMatch(/Keycloak.*OpenID Connect/i);
    expect(template.runtime.object_storage).toMatch(/MinIO|S3-compatible/i);
    expect(template.configuration.required_environment).toContain("POSTGRES_DATABASE_URL");
    expect(template.configuration.secrets_policy).toMatch(/no default credentials/i);
  });
});
