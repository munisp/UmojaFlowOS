import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The service-contract parsers are provider-independent, but they must remain
 * compliance-gated: an auditor is a read-only role and must not be able to push
 * an envelope into the control plane, and a treasury operator has no compliance
 * interpretation authority. This asserts the gate at the router source level so
 * a future refactor cannot silently widen access.
 */
const routerSource = readFileSync(join(process.cwd(), "server", "routers.ts"), "utf8");

const CONTRACT_PROCEDURES = [
  "parseGoPaymentOrderValidated",
  "parseRustPolicyDecision",
  "parsePythonBronzeManifest",
  "parseGoAuditTrail",
  "parseRustMonitoringResult",
  "parseRustCounterpartyRisk",
  "parsePythonAssembledReport",
  "parsePythonStablecoinExposure",
  "parseRustLedgerValidation",
  "parseRustLedgerReconciliation",
];

describe("service contract procedure gates", () => {
  it("exposes every contract parser through the compliance gate only", () => {
    for (const name of CONTRACT_PROCEDURES) {
      const pattern = new RegExp(`${name}:\\s*complianceProcedure`);
      expect(routerSource, `${name} must use complianceProcedure`).toMatch(pattern);
    }
  });

  it("does not expose any contract parser through a public or auditor-readable gate", () => {
    for (const name of CONTRACT_PROCEDURES) {
      expect(routerSource).not.toMatch(new RegExp(`${name}:\\s*publicProcedure`));
      expect(routerSource).not.toMatch(new RegExp(`${name}:\\s*auditorProcedure`));
      expect(routerSource).not.toMatch(new RegExp(`${name}:\\s*treasuryProcedure`));
    }
  });

  it("registers the newly added service contracts, not only the original three", () => {
    // Guards against the newer boundaries being defined but never wired up.
    for (const name of [
      "parseGoAuditTrail",
      "parseRustMonitoringResult",
      "parseRustCounterpartyRisk",
      "parsePythonAssembledReport",
      "parsePythonStablecoinExposure",
      "parseRustLedgerValidation",
      "parseRustLedgerReconciliation",
    ]) {
      expect(routerSource).toContain(`${name}:`);
    }
  });
});

/**
 * Bridge mutations must be gated at least as tightly as the parsers, because
 * invoking one reaches out to a real service rather than inspecting a payload
 * the caller already holds.
 */
const BRIDGE_MUTATIONS = [
  "evaluateMonitoringViaService",
  "assessCounterpartyRiskViaService",
  "validateLedgerPostingsViaService",
  "reconcileLedgerProjectionViaService",
];

describe("service bridge procedure gates", () => {
  it("exposes every bridge mutation through the compliance gate only", () => {
    for (const name of BRIDGE_MUTATIONS) {
      expect(routerSource, `${name} must be registered`).toContain(`${name}:`);
      expect(routerSource, `${name} must use complianceProcedure`).toMatch(
        new RegExp(`${name}:\\s*complianceProcedure`),
      );
    }
  });

  it("does not expose any bridge mutation to a read-only or treasury role", () => {
    for (const name of BRIDGE_MUTATIONS) {
      expect(routerSource).not.toMatch(new RegExp(`${name}:\\s*publicProcedure`));
      expect(routerSource).not.toMatch(new RegExp(`${name}:\\s*auditorProcedure`));
      expect(routerSource).not.toMatch(new RegExp(`${name}:\\s*treasuryProcedure`));
    }
  });

  it("keeps the bridge configuration read auditor-visible but read-only", () => {
    // An auditor may confirm which services are configured; that is evidence, not
    // an action, and it must not become a mutation.
    expect(routerSource).toMatch(/serviceConfiguration:\s*auditorProcedure/);
    expect(routerSource).not.toMatch(/serviceConfiguration:\s*\w*Procedure\.input/);
  });
});
