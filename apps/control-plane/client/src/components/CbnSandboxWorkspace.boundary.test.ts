import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("./CbnSandboxWorkspace.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("../pages/Home.tsx", import.meta.url), "utf8");
const navigation = readFileSync(new URL("./DashboardLayout.tsx", import.meta.url), "utf8");

describe("CBN sandbox console workspace boundary", () => {
  it("makes the dedicated workspace reachable from navigation and routing", () => {
    expect(navigation).toContain('{ icon: ClipboardCheck, label: "CBN Sandbox", path: "/console/sandbox" }');
    expect(home).toContain('module === "sandbox" && <CbnSandboxWorkspace');
  });

  it("keeps the non-licensing, non-execution, and non-submission boundary visible to the operator", () => {
    for (const claim of ["does not submit to CBN", "prove admission or licensing", "initiate a payment", "settle value", "not submitted", "not claimed", "non-executable", "cannot determine CBN eligibility"]) {
      expect(workspace).toContain(claim);
    }
  });

  it("offers controlled records only to the designated administrator and compliance roles", () => {
    expect(workspace).toContain('const canAdmin = role === "admin"');
    expect(workspace).toContain('const canCompliance = role === "compliance_officer" || role === "admin"');
    expect(workspace).not.toContain('treasury_operator');
  });

  it("binds every visible write action to its typed CBN sandbox tRPC procedure", () => {
    for (const procedure of ["createCbnSandboxDossier", "recordCbnSandboxEvidence", "assessCbnSandboxEvidenceCompleteness", "createCbnSandboxTestPlan", "recordCbnSandboxConsumerRecord", "recordCbnSandboxIncident", "createCbnSandboxReportingPack"]) {
      expect(workspace).toContain(`trpc.postgres.${procedure}.useMutation`);
    }
  });
});
