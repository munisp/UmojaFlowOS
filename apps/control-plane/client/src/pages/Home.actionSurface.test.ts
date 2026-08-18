import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The rendered privileged surface must come from one regression-covered
 * component. This guard fails if any module reintroduces an ad-hoc gated
 * button, which would let the visible surface drift from the role policy.
 */
describe("managed console action surface", () => {
  const source = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");

  it("renders every module action row through the shared visibility component", () => {
    expect(source).toContain('import { ConsoleModuleActions } from "@/components/ConsoleModuleActions"');
    for (const module of ["registry", "integrations", "governance", "treasury", "markets", "compliance", "reports", "alerts"]) {
      expect(source).toContain(`moduleActions("${module}"`);
    }
  });

  it("no longer defines a local per-button role gate", () => {
    expect(source).not.toContain("const button = (label: string");
    expect(source.match(/\bbutton\("/g)).toBeNull();
  });

  it("keeps the fail-closed markets controls disabled rather than silently active", () => {
    expect(source).toContain('moduleActions("markets", ["market", "rate-lock"])');
  });
});
