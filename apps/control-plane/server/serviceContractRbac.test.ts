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
