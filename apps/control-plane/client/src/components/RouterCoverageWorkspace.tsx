import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";

/**
 * Router coverage workspace.
 *
 * Guarantees every server procedure has a reachable UI surface. Each panel is
 * a thin, honest shell over one canonical tRPC procedure: queries run on
 * demand with an optional JSON input, mutations submit a JSON payload and
 * render the server's verbatim result or refusal. Server-side RBAC remains
 * authoritative — the role gate below only mirrors it so an operator is not
 * offered actions their role cannot complete. Input hints list the zod field
 * names declared by the procedure; validation errors are shown, never hidden.
 *
 * The generic hook access is intentionally untyped at the call site (the
 * procedure table is data-driven); the server contract is unchanged.
 */

type ProcKind = "query" | "mutation";
type ProcDef = { router: string; name: string; kind: ProcKind; roles: OperatorRole[] | "public"; hint: string };

const PROCS: ProcDef[] = [
  { router: "stakeholder", name: "requestAccount", kind: "mutation", roles: "public", hint: "username, displayName, password, requestedRole, notificationEmail" },
  { router: "stakeholder", name: "accounts", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "status" },
  { router: "stakeholder", name: "decideAdministratorApproval", kind: "mutation", roles: ["admin"], hint: "decision" },
  { router: "stakeholder", name: "transitionAccount", kind: "mutation", roles: ["admin"], hint: "target, reason" },
  { router: "stakeholder", name: "assignSuperAdministrator", kind: "mutation", roles: ["admin"], hint: "subject" },
  { router: "stakeholder", name: "revokeSuperAdministrator", kind: "mutation", roles: ["admin"], hint: "subject, reason" },
  { router: "stakeholder", name: "superAdministrators", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "stakeholder", name: "governanceAudit", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "stakeholder", name: "sessions", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "stakeholder", name: "revokeSession", kind: "mutation", roles: ["admin"], hint: "reason" },
  { router: "stakeholder", name: "notificationPreferences", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "stakeholder", name: "updateNotificationPreferences", kind: "mutation", roles: ["admin"], hint: "emailKycRemindersEnabled" },
  { router: "stakeholder", name: "securityMessages", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "stakeholder", name: "kycReminderDeliveries", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "administratorKyc", name: "workspace", kind: "query", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "administratorKyc", name: "uploadPolicy", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "administratorKyc", name: "updateUploadPolicy", kind: "mutation", roles: ["admin"], hint: "maxFileBytes, reason" },
  { router: "administratorKyc", name: "uploadPolicyAudit", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "administratorKyc", name: "createUploadIntent", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "evidenceKind, jurisdictionCode, originalFilename, mimeType, sizeBytes, storageKey, ttlMinutes" },
  { router: "administratorKyc", name: "finalizeUploadIntent", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "administratorKyc", name: "recordOversizeException", kind: "mutation", roles: ["compliance_officer"], hint: "jurisdictionCode, exceptionRationale" },
  { router: "administratorKyc", name: "submitEvidence", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "evidenceKind, jurisdictionCode" },
  { router: "administratorKyc", name: "recordReview", kind: "mutation", roles: ["compliance_officer"], hint: "outcome" },
  { router: "administratorKyc", name: "createEvidenceRequest", kind: "mutation", roles: ["compliance_officer"], hint: "requestSummary, dueAt" },
  { router: "administratorKyc", name: "transitionEvidenceRequest", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "target" },
  { router: "administratorKyc", name: "raiseEscalation", kind: "mutation", roles: ["compliance_officer"], hint: "reason" },
  { router: "administratorKyc", name: "recordReviewEntry", kind: "mutation", roles: ["compliance_officer"], hint: "reviewSequence, outcome" },
  { router: "tradeControl", name: "cases", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "tradeControl", name: "workspace", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "tradeControl", name: "createCase", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "caseReference, corridor, purchaseCurrency, purchaseAmount, intendedSettlementCurrency, purposeSummary" },
  { router: "tradeControl", name: "transitionCase", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "targetStatus" },
  { router: "tradeControl", name: "assignStakeholder", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "stakeholderRole, stakeholderSubject" },
  { router: "tradeControl", name: "revokeStakeholder", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "no input" },
  { router: "tradeControl", name: "submitEvidence", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "evidenceKind" },
  { router: "tradeControl", name: "reviewEvidence", kind: "mutation", roles: ["compliance_officer"], hint: "decision, rationale" },
  { router: "tradeControl", name: "configureRoute", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "routeKind, sourceCurrency, targetCurrency" },
  { router: "tradeControl", name: "transitionRoute", kind: "mutation", roles: ["compliance_officer"], hint: "readinessState" },
  { router: "tradeControl", name: "recordApproval", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "approvalRole, decision" },
  { router: "tradeControl", name: "raiseException", kind: "mutation", roles: ["admin", "compliance_officer", "treasury_operator"], hint: "exceptionKind" },
  { router: "tradeControl", name: "resolveException", kind: "mutation", roles: ["compliance_officer"], hint: "decision" },
  { router: "tradeControl", name: "recordReconciliation", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "referenceKind, status" },
  { router: "enterpriseGovernance", name: "workspace", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "enterpriseGovernance", name: "registerGovernedBankAccount", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "countryCode, currency" },
  { router: "enterpriseGovernance", name: "recordLiquidityPolicy", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "countryCode, currency, concentrationLimitPercent, approvalThresholdAmount" },
  { router: "enterpriseGovernance", name: "recordStablecoinMandate", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "asset, maximumExposure, requiresTravelRule, requiresBeneficiaryEvidence" },
  { router: "enterpriseGovernance", name: "registerSupplyChainProgramme", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "programmeReference" },
  { router: "enterpriseGovernance", name: "registerSpendCardProgramme", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "programmeReference, countryCode, currency" },
  { router: "enterpriseGovernance", name: "recordSpendPolicyRule", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "ruleKind, ruleValue" },
  { router: "enterpriseGovernance", name: "spendPolicyRules", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "enterpriseGovernance", name: "recordReview", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "moduleKind, decision" },
  { router: "controlAssurance", name: "recordAssessment", kind: "mutation", roles: ["admin", "auditor"], hint: "assessmentKind, subjectType, subjectId, outcome, findingCodes" },
  { router: "controlAssurance", name: "recordAdapterCertification", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "adapterKind, certificationState, corridor, asset, controlledTestReference" },
  { router: "controlAssurance", name: "recordAuditPacket", kind: "mutation", roles: ["admin", "auditor"], hint: "packetScope, scopeReference, evidenceCount" },
  { router: "controlAssurance", name: "assessments", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "subjectType, subjectId" },
  { router: "controlAssurance", name: "adapterCertifications", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "controlAssurance", name: "auditPackets", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "packetScope, scopeReference" },
  { router: "executionRehearsal", name: "configureStablecoinRoute", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "corridor, asset, requiresTravelRule, beneficiaryEvidenceRequired" },
  { router: "executionRehearsal", name: "reviewStablecoinRoute", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "decision" },
  { router: "executionRehearsal", name: "stablecoinRoutes", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "corridor" },
  { router: "executionRehearsal", name: "recordAuthorisedTest", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "corridor, status" },
  { router: "executionRehearsal", name: "recordRehearsal", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "outcome, prerequisiteSnapshot" },
  { router: "executionRehearsal", name: "rehearsals", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "executionRehearsal", name: "recordExecutionEvidence", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "evidenceKind" },
  { router: "executionRehearsal", name: "executionEvidence", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "executionRehearsal", name: "recordSettlementAttempt", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "idempotencyKey, direction, asset, fiatCurrency, amountMinor, providerReference" },
  { router: "executionRehearsal", name: "settlementAttempts", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "ledgerReconciliation", name: "recordPostingIntent", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "postingIdentity, correlationId, currency, amountMinor, debitAccountId, creditAccountId, expectedTransferId" },
  { router: "ledgerReconciliation", name: "transitionPostingIntent", kind: "mutation", roles: ["admin", "treasury_operator"], hint: "postingIdentity, intentState, expectedTransferId" },
  { router: "ledgerReconciliation", name: "recordRun", kind: "mutation", roles: ["admin", "auditor"], hint: "runReference, windowStart, windowEnd, status, intentCount, factCount, discrepancyCount, sourceIdentity, errorSummary" },
  { router: "ledgerReconciliation", name: "recordDiscrepancy", kind: "mutation", roles: ["admin", "auditor"], hint: "postingIdentity, tigerbeetleTransferId, discrepancyCode, expected, observed" },
  { router: "ledgerReconciliation", name: "postingIntents", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "intentState" },
  { router: "ledgerReconciliation", name: "runs", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "status" },
  { router: "ledgerReconciliation", name: "discrepancies", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "livePipelines", name: "recordProviderSend", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "providerReference, providerStatus" },
  { router: "livePipelines", name: "transitionProviderSend", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "finalityState, providerFinalityReference, reconciliationReference" },
  { router: "livePipelines", name: "providerSends", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "livePipelines", name: "recordRegulatorySubmission", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "channelReference, attemptState, externalReference" },
  { router: "livePipelines", name: "regulatorySubmissions", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "contracts", name: "parseGoPaymentOrderValidated", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parseRustPolicyDecision", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parsePythonBronzeManifest", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parseGoAuditTrail", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parseRustMonitoringResult", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parseRustCounterpartyRisk", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parsePythonAssembledReport", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parsePythonStablecoinExposure", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parseRustLedgerValidation", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "parseRustLedgerReconciliation", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "serviceConfiguration", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "contracts", name: "evaluateMonitoringViaService", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "assessCounterpartyRiskViaService", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "validateLedgerPostingsViaService", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "contracts", name: "reconcileLedgerProjectionViaService", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "no input" },
  { router: "postgres", name: "readiness", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "no input" },
  { router: "postgres", name: "rejectReadinessAssuranceEvidence", kind: "mutation", roles: ["admin", "auditor"], hint: "dossierId, area, rationale" },
  { router: "postgres", name: "validateVaspOwnerAssignments", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "dossierId, assignments[]" },
  { router: "postgres", name: "validateVaspEvidenceManifest", kind: "query", roles: ["admin", "compliance_officer", "treasury_operator", "auditor"], hint: "dossierId, manifest[]" },
  { router: "postgres", name: "captureServiceHealthSample", kind: "mutation", roles: ["admin"], hint: "no input" },
  { router: "postgres", name: "persistDocumentAnalysisEvidence", kind: "mutation", roles: ["admin", "compliance_officer"], hint: "analysisJobId, kind, disposition, engineName, engineVersion, modelTag, modelDigest, promptPolicyVersion, evidenceSha256, signals, limitations" },
];

const ROUTER_LABELS: Record<string, string> = {
  stakeholder: "Stakeholder accounts & sessions",
  administratorKyc: "Administrator KYC evidence",
  tradeControl: "Trade payment control",
  enterpriseGovernance: "Enterprise governance",
  controlAssurance: "Control assurance hub",
  executionRehearsal: "Execution rehearsal (no live execution)",
  ledgerReconciliation: "Ledger reconciliation",
  livePipelines: "Live control pipelines",
  contracts: "Go / Rust / Python service contracts",
  postgres: "Platform operations (PostgreSQL router)",
};

function roleAllowed(roles: OperatorRole[] | "public", role: OperatorRole | undefined) {
  if (roles === "public") return true;
  return role !== undefined && roles.includes(role);
}

function JsonResult({ value }: { value: unknown }) {
  if (value === undefined) return null;
  const text = useMemo(() => {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }, [value]);
  const count = Array.isArray(value) ? `${value.length} record(s)` : "result";
  return <div className="border-t border-black/10">
    <p className="px-3 pt-2 text-[10px] font-black uppercase tracking-wide text-black/45">{count}</p>
    <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-4 text-black/75">{text}</pre>
  </div>;
}

function QueryPanel({ def, role }: { def: ProcDef; role: OperatorRole | undefined }) {
  const [raw, setRaw] = useState("{}");
  const [run, setRun] = useState(false);
  const parsed = useMemo(() => { try { return JSON.parse(raw); } catch { return undefined; } }, [raw]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (trpc as any)[def.router][def.name].useQuery(parsed, { enabled: run && parsed !== undefined, retry: false });
  const allowed = roleAllowed(def.roles, role);
  return <div className="border border-black/15">
    <div className="flex items-center justify-between gap-3 border-b border-black/10 px-3 py-2">
      <p className="font-mono text-xs font-bold">{def.router}.{def.name}</p>
      <span className="text-[9px] font-black uppercase tracking-wide text-black/40">query</span>
    </div>
    {!allowed ? <p className="px-3 py-3 text-xs text-black/55">Read access is not assigned to your role for this procedure. The server enforces this independently of this console.</p> : <>
      <div className="grid gap-2 px-3 py-2">
        <textarea aria-label="Query input (JSON)" value={raw} onChange={e => { setRaw(e.target.value); setRun(false); }} className="min-h-12 border border-black/25 bg-white px-2 py-1 font-mono text-[11px]" />
        <p className="text-[10px] text-black/45">Input fields: {def.hint}</p>
        {parsed === undefined && <p className="text-[10px] font-bold text-red-700">Input is not valid JSON.</p>}
        <Button disabled={parsed === undefined || query.isFetching} onClick={() => { setRun(true); void query.refetch(); }} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{query.isFetching ? "Running…" : "Run query"}</Button>
      </div>
      {query.error && <p className="border-t border-black/10 px-3 py-2 text-xs font-bold text-red-700">{query.error.message}</p>}
      {run && <JsonResult value={query.data} />}
    </>}
  </div>;
}

function MutationPanel({ def, role }: { def: ProcDef; role: OperatorRole | undefined }) {
  const [raw, setRaw] = useState("{}");
  const parsed = useMemo(() => { try { return JSON.parse(raw); } catch { return undefined; } }, [raw]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutation = (trpc as any)[def.router][def.name].useMutation({
    onError: (error: { message: string }) => toast.error(error.message),
  });
  const allowed = roleAllowed(def.roles, role);
  const submit = () => {
    if (parsed === undefined) { toast.error("Payload is not valid JSON."); return; }
    mutation.mutate(parsed);
  };
  return <div className="border border-black/15">
    <div className="flex items-center justify-between gap-3 border-b border-black/10 px-3 py-2">
      <p className="font-mono text-xs font-bold">{def.router}.{def.name}</p>
      <span className="text-[9px] font-black uppercase tracking-wide text-[#e11919]">mutation</span>
    </div>
    {!allowed ? <p className="px-3 py-3 text-xs text-black/55">This action is not assigned to your role. The server enforces this independently of this console.</p> : <>
      <div className="grid gap-2 px-3 py-2">
        <textarea aria-label="Mutation payload (JSON)" value={raw} onChange={e => setRaw(e.target.value)} className="min-h-16 border border-black/25 bg-white px-2 py-1 font-mono text-[11px]" />
        <p className="text-[10px] text-black/45">Payload fields: {def.hint}</p>
        {parsed === undefined && <p className="text-[10px] font-bold text-red-700">Payload is not valid JSON.</p>}
        <Button disabled={mutation.isPending} onClick={submit} className="rounded-none bg-[#e11919] text-[10px] font-black uppercase hover:bg-black">{mutation.isPending ? "Submitting…" : "Submit attributable record"}</Button>
      </div>
      {mutation.error && <p className="border-t border-black/10 px-3 py-2 text-xs font-bold text-red-700">{mutation.error.message}</p>}
      {mutation.isSuccess && <p className="border-t border-black/10 px-3 py-2 text-xs font-bold text-emerald-700">Server accepted the record.</p>}
      <JsonResult value={mutation.data} />
    </>}
  </div>;
}

export function RouterCoverageWorkspace({ role }: { role: OperatorRole | undefined }) {
  const routers = useMemo(() => {
    const order: string[] = [];
    for (const def of PROCS) if (!order.includes(def.router)) order.push(def.router);
    return order;
  }, []);
  return <div className="grid gap-6">
    <p className="max-w-4xl text-sm leading-6 text-black/65">
      Every procedure below writes or reads through the canonical server router — no fabricated rows, no client-side state.
      Mutations record immutable activity evidence server-side; refusals (validation, RBAC, guard rails) are displayed verbatim.
    </p>
    {routers.map(router => {
      const defs = PROCS.filter(d => d.router === router);
      const queries = defs.filter(d => d.kind === "query");
      const mutations = defs.filter(d => d.kind === "mutation");
      return <section key={router} className="uf-panel">
        <header className="border-b border-black/20 px-5 py-4">
          <p className="uf-kicker">{router}</p>
          <h3 className="mt-1 text-sm font-black uppercase tracking-wide">{ROUTER_LABELS[router] ?? router}</h3>
          <p className="mt-1 text-xs text-black/50">{defs.length} procedure(s): {queries.length} read, {mutations.length} write</p>
        </header>
        <div className="grid gap-4 p-5 lg:grid-cols-2">
          <div className="grid content-start gap-3"><p className="text-[10px] font-black uppercase tracking-wide text-black/45">Reads</p>{queries.map(d => <QueryPanel key={d.name} def={d} role={role} />)}</div>
          <div className="grid content-start gap-3"><p className="text-[10px] font-black uppercase tracking-wide text-black/45">Writes</p>{mutations.map(d => <MutationPanel key={d.name} def={d} role={role} />)}</div>
        </div>
      </section>;
    })}
  </div>;
}
