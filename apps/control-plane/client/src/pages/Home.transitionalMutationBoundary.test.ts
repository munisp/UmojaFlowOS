import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("managed transitional mutation boundary", () => {
  it("does not bind migrated registry, party, or payment actions to the MySQL/TiDB router", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");

    expect(source).not.toContain("trpc.umoja.registry.create.useMutation");
    expect(source).not.toContain("trpc.umoja.registry.createAuthorization.useMutation");
    expect(source).not.toContain("trpc.umoja.registry.transitionAuthorization.useMutation");
    expect(source).toContain("trpc.postgres.transitionCounterpartyAuthorization.useMutation");
    expect(source).not.toMatch(/trpc\.umoja\.parties\.[A-Za-z0-9_]+\.useMutation/);
    expect(source).not.toMatch(/trpc\.umoja\.payments\.[A-Za-z0-9_]+\.useMutation/);
    // The console is fully migrated: no transitional namespace mutation remains.
    expect(source).not.toMatch(/trpc\.umoja\.[A-Za-z0-9_.]+\.useMutation/);
  });
});
