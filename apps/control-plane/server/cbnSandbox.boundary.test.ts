import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../database/postgresql/0015_cbn_sandbox_readiness.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("./cbnSandbox.ts", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");

describe("CBN Cohort 2 sandbox readiness boundary", () => {
  it("stores a draft/readiness dossier rather than an admission, licence, or provider-activation state", () => {
    expect(migration).toContain("CREATE TYPE cbn_sandbox_dossier_status AS ENUM ('draft', 'ready_for_external_submission', 'external_submission_pending')");
    expect(migration).not.toMatch(/admitted|licensed|provider_active/i);
  });

  it("requires one-way evidence hashes, HTTPS references, a documented wind-down, and explicit non-submission statuses", () => {
    expect(migration).toContain("evidence_sha256 CHAR(64) NOT NULL");
    expect(migration).toContain("wind_down_uri TEXT NOT NULL CHECK (wind_down_uri ~ '^https://')");
    expect(migration).toContain("notification_status cbn_sandbox_notification_status NOT NULL DEFAULT 'not_submitted'");
    expect(migration).toContain("submission_status cbn_sandbox_notification_status NOT NULL DEFAULT 'not_submitted'");
  });

  it("reports incomplete evidence honestly and never presents an external claim as true", () => {
    expect(repository).toContain('readiness: missing.length === 0 && Boolean(plan.rows[0]) ? "evidence_complete_pending_external_review" : "incomplete"');
    expect(repository).toContain("externalSubmission: false, admission: false, licence: false, providerActivation: false");
  });

  it("records test parameters without issuing an execution or settlement instruction", () => {
    expect(repository).toContain("executionPermitted: false, settlementPermitted: false, externalApprovalAsserted: false");
    expect(repository).not.toMatch(/POST\s+\/payments|initiateTransfer|settle\(/);
  });

  it("uses administrator and compliance procedures, with no treasury or public sandbox mutation", () => {
    const sandboxSection = routerSource.slice(routerSource.indexOf("cbnSandboxDossiers"), routerSource.indexOf("counterparties:"));
    expect(sandboxSection).toContain("createCbnSandboxDossier: adminProcedure");
    expect(sandboxSection).toContain("recordCbnSandboxEvidence: complianceProcedure");
    expect(sandboxSection).toContain("recordCbnSandboxIncident: complianceProcedure");
    expect(sandboxSection).not.toContain("treasuryProcedure");
    expect(sandboxSection).not.toContain("publicProcedure");
  });
});
