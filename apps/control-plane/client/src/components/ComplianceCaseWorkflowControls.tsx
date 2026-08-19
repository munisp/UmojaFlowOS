import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormEvent, useState } from "react";
import { SubmitFeedback, useSubmitFeedback } from "@/components/SubmitFeedback";

type CaseStatus = "open" | "under_review" | "cleared" | "escalated" | "reported" | "closed";

/**
 * Statuses a disposition may target. "open" is the initial state a case is
 * created in, so it is never a disposition target.
 */
type DispositionStatus = Exclude<CaseStatus, "open">;

export type ComplianceCaseRow = {
  id: string;
  caseType: string;
  status: string;
  severity: string;
  sourceReference: string;
  openedAt: Date;
};

/**
 * Allowed dispositions per current state, mirroring the server lifecycle guard.
 * The console never offers a transition the server would refuse, and a closed
 * case offers nothing at all.
 */
const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ["under_review", "closed"],
  under_review: ["cleared", "escalated", "reported", "closed"],
  escalated: ["reported", "cleared", "closed"],
  cleared: ["closed"],
  reported: ["closed"],
  closed: [],
};

const STATUS_LABELS: Record<CaseStatus, string> = {
  open: "Open",
  under_review: "Under review",
  cleared: "Cleared",
  escalated: "Escalated",
  reported: "Reported",
  closed: "Closed",
};

export function allowedCaseTransitions(status: string): CaseStatus[] {
  return CASE_TRANSITIONS[status as CaseStatus] ?? [];
}

function dispositionTargets(status: string): DispositionStatus[] {
  return allowedCaseTransitions(status).filter((next): next is DispositionStatus => next !== "open");
}

export function VerificationConsentForm({
  canCapture,
  pending,
  submit, error }: {
  canCapture: boolean;
  pending: boolean;
  submit: (input: { scope: "kyc" | "kyb"; subjectReference: string; consentVersion: string; purpose: string; grantedAt: Date }) => void; error?: string | null }) {
  const feedback = useSubmitFeedback(pending, error);
  const [scope, setScope] = useState<"kyc" | "kyb">("kyc");
  if (!canCapture) {
    return <div className="px-5 py-8 text-sm leading-6 text-black/55">Consent capture is restricted to compliance officers. This view is read-only.</div>;
  }
  return <form
    className="grid gap-4 px-5 py-5"
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      submit({
        scope,
        subjectReference: String(data.get("subjectReference")),
        consentVersion: String(data.get("consentVersion")),
        purpose: String(data.get("purpose")),
        grantedAt: new Date(),
      });
    }}
  >
    <p className="max-w-3xl text-xs leading-5 text-black/60">Consent is recorded before any document is analysed. It states the scope, the version of the notice the subject accepted, and the specific purpose. No analysis job can exist without an active, scope-matched consent.</p>
    <Label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Verification scope</span>
      <Select value={scope} onValueChange={value => setScope(value as typeof scope)}>
        <SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="kyc">KYC — natural person</SelectItem>
          <SelectItem value="kyb">KYB — legal entity</SelectItem>
        </SelectContent>
      </Select>
    </Label>
    <Label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Subject reference</span>
      <Input name="subjectReference" required minLength={3} maxLength={255} className="rounded-none border-black/25" placeholder="Customer or entity identifier held on record" />
    </Label>
    <Label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Consent notice version</span>
      <Input name="consentVersion" required minLength={1} maxLength={128} className="rounded-none border-black/25" placeholder="Version of the privacy notice accepted" />
    </Label>
    <Label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Stated purpose</span>
      <Input name="purpose" required minLength={10} maxLength={1000} className="rounded-none border-black/25" placeholder="Specific processing purpose the subject consented to" />
    </Label>
    <SubmitFeedback state={feedback} /><Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Recording…" : "Record verification consent"}</Button>
  </form>;
}

export function ComplianceCaseDispositionControls({
  cases,
  canDispose,
  pending,
  dispose,
}: {
  cases: ComplianceCaseRow[];
  canDispose: boolean;
  pending: boolean;
  dispose: (input: { complianceCaseId: string; status: DispositionStatus; decisionReason: string }) => void;
}) {
  if (!cases.length) {
    return <div className="px-5 py-8"><p className="font-bold">No compliance cases</p><p className="mt-1 text-sm leading-6 text-black/55">A case is opened from recorded evidence. This console does not manufacture a case, an alert, or a screening result.</p></div>;
  }
  return <div className="divide-y divide-black/10">{cases.map(row => {
    const transitions = dispositionTargets(row.status);
    return <div className="px-5 py-4" key={row.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge className="rounded-none border-0 bg-black text-[10px] font-bold uppercase text-white">{row.caseType.replaceAll("_", " ")}</Badge>
          <span className="text-xs font-bold uppercase">{STATUS_LABELS[row.status as CaseStatus] ?? row.status}</span>
          <span className="text-[10px] uppercase tracking-wide text-black/45">Severity {row.severity}</span>
        </div>
        <span className="text-[10px] text-black/50">{new Date(row.openedAt).toLocaleString()}</span>
      </div>
      <p className="mt-2 break-all font-mono text-[10px] text-black/50">{row.sourceReference}</p>
      {!canDispose
        ? <p className="mt-3 text-xs leading-5 text-black/55">Case disposition is restricted to compliance officers.</p>
        : transitions.length === 0
          ? <p className="mt-3 text-xs leading-5 text-black/55">This case is closed. A closed case is never reopened; open a new case instead so the earlier attestation stays intact.</p>
          : <form
              className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                dispose({
                  complianceCaseId: row.id,
                  status: String(data.get("status")) as DispositionStatus,
                  decisionReason: String(data.get("decisionReason")),
                });
              }}
            >
              <Label className="grid gap-1.5">
                <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Disposition</span>
                <Select name="status" defaultValue={transitions[0]}>
                  <SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger>
                  <SelectContent>{transitions.map(status => <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>)}</SelectContent>
                </Select>
              </Label>
              <Label className="grid gap-1.5">
                <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Attributable rationale</span>
                <Input name="decisionReason" required minLength={20} maxLength={4000} className="rounded-none border-black/25" placeholder="State the basis and the evidence relied upon" />
              </Label>
              <Button type="submit" disabled={pending} className="rounded-none bg-black font-black uppercase tracking-wide hover:bg-[#e11919]">{pending ? "Recording…" : "Record disposition"}</Button>
            </form>}
    </div>;
  })}</div>;
}
