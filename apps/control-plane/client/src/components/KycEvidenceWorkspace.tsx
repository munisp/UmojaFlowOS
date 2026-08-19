import { KycEvidenceLedger, KycEvidenceNotice, ReviewerDecisionForm, ReviewerDecisionHistory } from "@/components/KycEvidenceControls";

import type { OperatorRole as ConsoleRole } from "@/lib/roleCapabilities";

type AnalysisJob = {
  id: string;
  caseKind: string;
  documentClass: string;
  sourceSha256: string;
  state: string;
  submittedBy: string;
  submittedAt: Date;
};

type EvidenceRow = {
  id: string;
  caseKind: string;
  documentClass: string;
  kind: string;
  disposition: string;
  engineName: string;
  engineVersion: string;
  modelTag: string | null;
  modelDigest: string | null;
  signals: unknown[];
  limitations: unknown[];
  createdAt: Date;
};

type ReviewerDecision = {
  id: string;
  caseKind: string;
  documentClass: string;
  disposition: string;
  rationale: string;
  decidedBy: string;
  decidedAt: Date;
};

/** Roles permitted to record a manual KYC/KYB reviewer disposition. */
export const REVIEW_DECISION_ROLES: ConsoleRole[] = ["compliance_officer", "admin"];

/** Roles permitted to read persisted KYC/KYB evidence and decision history. */
export const EVIDENCE_READER_ROLES: ConsoleRole[] = ["admin", "compliance_officer", "treasury_operator", "auditor"];

export function canRecordReviewerDecision(role: ConsoleRole | undefined): boolean {
  return role !== undefined && REVIEW_DECISION_ROLES.includes(role);
}

export function canReadKycEvidence(role: ConsoleRole | undefined): boolean {
  return role !== undefined && EVIDENCE_READER_ROLES.includes(role);
}

/**
 * The role-aware KYC/KYB evidence workspace rendered inside the compliance
 * module. Reviewer decisions are compliance-only, evidence reads follow the
 * auditor-readable boundary, and an unauthenticated visitor receives no
 * evidence surface at all rather than an empty-looking one.
 */
export function KycEvidenceWorkspace({
  role,
  jobs,
  evidence,
  decisions,
  loadingEvidence,
  loadingDecisions,
  pendingDecision,
  submitDecision,
}: {
  role: ConsoleRole | undefined;
  jobs: AnalysisJob[];
  evidence: EvidenceRow[];
  decisions: ReviewerDecision[];
  loadingEvidence: boolean;
  loadingDecisions: boolean;
  pendingDecision: boolean;
  submitDecision: (input: {
    analysisJobId: string;
    disposition: "approved" | "rejected" | "needs_information" | "escalated";
    rationale: string;
  }) => void;
}) {
  if (!canReadKycEvidence(role)) {
    return (
      <div className="px-5 py-8" data-testid="kyc-evidence-unauthorised">
        <p className="font-bold">Sign-in required for evidence access</p>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-black/55">
          KYC and KYB evidence, model provenance, and reviewer decisions are visible only to an authenticated operator with an
          assigned role. No document, signal, or disposition is shown to an unauthenticated visitor.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-5" data-testid="kyc-evidence-workspace">
      <KycEvidenceNotice />
      {canRecordReviewerDecision(role) ? (
        <div data-testid="kyc-reviewer-decision-form">
          <ReviewerDecisionForm jobs={jobs} pending={pendingDecision} submit={submitDecision} />
        </div>
      ) : (
        <div className="px-5 py-6" data-testid="kyc-reviewer-decision-readonly">
          <p className="font-bold">Read-only evidence access</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-black/55">
            Only compliance officers may record a manual KYC or KYB reviewer decision. This role may inspect persisted evidence
            and decision history when present.
          </p>
        </div>
      )}
      <div data-testid="kyc-evidence-ledger">
        <KycEvidenceLedger evidence={evidence} loading={loadingEvidence} />
      </div>
      <div data-testid="kyc-reviewer-decision-history">
        <ReviewerDecisionHistory decisions={decisions} loading={loadingDecisions} />
      </div>
    </div>
  );
}
