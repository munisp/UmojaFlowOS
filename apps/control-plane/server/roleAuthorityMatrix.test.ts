import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTERS = readFileSync(resolve(process.cwd(), "server/routers.ts"), "utf8");
const MATRIX = readFileSync(resolve(process.cwd(), "docs/role-authority-matrix.md"), "utf8");

/**
 * The documented matrix is only useful if it describes the code. These checks
 * bind the two together so a divergence is a test failure rather than a stale
 * document.
 */
describe("documented role authority matrix", () => {
  it("records the resolved administrator delegation decision", () => {
    expect(MATRIX).toContain("delegated access, with two");
    expect(MATRIX).toContain("No self-approval.");
    expect(MATRIX).toContain("No auditor escalation.");
  });

  it("keeps SAR/STR filing compliance-only, excluding administrators", () => {
    // The matrix says administrators may not file. The procedure must agree.
    expect(MATRIX).toMatch(/File and transition SAR\/STR \| No \| Yes \| No \| No \|/);
    const sarProcedures = ROUTERS.match(/\n\s+(createSarStrFiling|transitionSarStrFiling):[^\n]+/g) ?? [];
    expect(sarProcedures.length).toBeGreaterThan(0);
    for (const procedure of sarProcedures) {
      expect(procedure, "SAR/STR filing must use the compliance-only gate").toContain("complianceOnlyProcedure");
    }
  });

  it("keeps counterparty risk escalation administrator-only", () => {
    expect(MATRIX).toMatch(/Escalate counterparty risk \| Yes \| No \| No \| No \|/);
    // Scoped deliberately to counterparty-risk escalation. Other domains have
    // their own escalation semantics: escalating a compliance alert into a case
    // is an investigative step available to compliance officers, and is covered
    // by the compliance alert regressions rather than this administrator rule.
    const escalation = ROUTERS.match(/\n\s+escalateCounterparty[A-Za-z]*:[^\n]+/g) ?? [];
    expect(escalation.length).toBeGreaterThan(0);
    for (const procedure of escalation) {
      expect(procedure).toMatch(/adminProcedure|administratorProcedure/);
    }
  });

  it("grants no write path to auditors anywhere in the router", () => {
    // Every mutation must be gated by something stricter than auditor access.
    const mutations = ROUTERS.match(/\n\s+[a-zA-Z]+: auditorProcedure[^\n]*\.mutation/g) ?? [];
    expect(mutations).toEqual([]);
  });

  it("names all three enforcement layers so an interface gate is never treated as sufficient", () => {
    expect(MATRIX).toContain("consoleActionVisibility.ts");
    expect(MATRIX).toContain("server/routers.ts");
    expect(MATRIX).toContain("least-privilege database grants");
  });
});
