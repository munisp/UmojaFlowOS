import { afterEach, describe, expect, it } from "vitest";
import { postgresTestSchemaOwnerPsqlArguments } from "./testPostgres";

const originalSchemaOwnerUrl = process.env.POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL;

afterEach(() => {
  if (originalSchemaOwnerUrl === undefined) {
    delete process.env.POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL;
  } else {
    process.env.POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL = originalSchemaOwnerUrl;
  }
});

describe("schema-owner PostgreSQL test connection", () => {
  it("rejects cleanup when no explicit schema-owner URL is configured", () => {
    delete process.env.POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL;
    expect(() => postgresTestSchemaOwnerPsqlArguments()).toThrow(
      /POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL is required/,
    );
  });

  it("uses only the explicitly configured schema-owner URL", () => {
    process.env.POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL = "postgresql://schema-owner:secret@db.test/umoja_test";
    expect(postgresTestSchemaOwnerPsqlArguments()).toEqual([
      "postgresql://schema-owner:secret@db.test/umoja_test",
    ]);
  });
});
