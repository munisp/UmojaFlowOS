import { Fragment, FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";

type EngagementPhase = "engagement_letter" | "access_provisioning" | "audit_fieldwork" | "annual_review";
type EngagementRecord = {
  id: string;
  auditorFirmName: string;
  engagementReference: string;
  phase: EngagementPhase;
  engagementLetterUri: string | null;
  engagementLetterSignedAt: string | Date | null;
  scopeNote: string | null;
  auditorSubject: string | null;
  accessProvisionedAt: string | Date | null;
  accessProvisionedBy: string | null;
  fieldworkNote: string | null;
  fieldworkStartedAt: string | Date | null;
  fieldworkCompletedAt: string | Date | null;
  lastAnnualReviewAt: string | Date | null;
  nextAnnualReviewDueAt: string | Date | null;
  createdAt: string | Date;
};

const phaseLabels: Record<EngagementPhase, string> = {
  engagement_letter: "Engagement letter",
  access_provisioning: "Access provisioning",
  audit_fieldwork: "Audit fieldwork",
  annual_review: "Annual review",
};

/**
 * OM Ch.10's own text isn't in the shared export beyond its title and one
 * sentence -- this panel is built from the "Auditors & regulators" lane of
 * the Fig 3.1 cross-stakeholder map instead. Only two of its four phases
 * are legible in the source (engagement letter/scope; read-only access
 * provisioning); the other two are a conservative inference from the
 * audit-engagement lifecycle shape, not a transcription. Scoped to the
 * external-auditor archetype only -- regulator engagement is already
 * covered by the CBN Sandbox module (dossiers, test plans, incidents).
 */
function EngagementPanel({ engagement, canManage, onChanged }: { engagement: EngagementRecord; canManage: boolean; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const [letterUri, setLetterUri] = useState("");
  const [scopeNote, setScopeNote] = useState("");
  const [auditorSubject, setAuditorSubject] = useState("");
  const [fieldworkNote, setFieldworkNote] = useState("");
  const [nextReviewDueAt, setNextReviewDueAt] = useState("");

  const invalidate = () => { void utils.postgres.auditorEngagements.invalidate(); onChanged(); };
  const recordLetter = trpc.postgres.recordEngagementLetter.useMutation({ onSuccess: () => { toast.success("Engagement letter recorded."); setLetterUri(""); setScopeNote(""); invalidate(); }, onError: error => toast.error(error.message) });
  const provisionAccess = trpc.postgres.recordAccessProvisioning.useMutation({ onSuccess: () => { toast.success("Access provisioning recorded."); setAuditorSubject(""); invalidate(); }, onError: error => toast.error(error.message) });
  const recordFieldwork = trpc.postgres.recordAuditFieldwork.useMutation({ onSuccess: () => { toast.success("Fieldwork recorded."); setFieldworkNote(""); invalidate(); }, onError: error => toast.error(error.message) });
  const recordReview = trpc.postgres.recordAnnualReview.useMutation({ onSuccess: () => { toast.success("Annual review recorded."); setNextReviewDueAt(""); invalidate(); }, onError: error => toast.error(error.message) });

  const submitLetter = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!letterUri.trim() || scopeNote.trim().length < 10) { toast.error("A letter URL and a scope note of at least 10 characters are required."); return; } recordLetter.mutate({ engagementId: engagement.id, engagementLetterUri: letterUri.trim(), scopeNote: scopeNote.trim() }); };
  const submitAccess = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!auditorSubject.trim()) { toast.error("The auditor's platform subject is required."); return; } provisionAccess.mutate({ engagementId: engagement.id, auditorSubject: auditorSubject.trim() }); };
  const submitFieldwork = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (fieldworkNote.trim().length < 10) { toast.error("A fieldwork note of at least 10 characters is required."); return; } recordFieldwork.mutate({ engagementId: engagement.id, fieldworkNote: fieldworkNote.trim() }); };
  const submitReview = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!nextReviewDueAt) { toast.error("A next review due date is required."); return; } recordReview.mutate({ engagementId: engagement.id, nextAnnualReviewDueAt: new Date(nextReviewDueAt) }); };

  return <div className="grid gap-3 border border-black/15 bg-black/[0.02] p-3 text-sm">
    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Current phase: {phaseLabels[engagement.phase]}</p>

    {engagement.phase === "engagement_letter" && (canManage ? <form className="grid gap-2" onSubmit={submitLetter}>
      <Input value={letterUri} onChange={event => setLetterUri(event.target.value)} type="url" placeholder="Engagement letter URL" className="h-8 rounded-none border-black/25 text-xs" />
      <textarea value={scopeNote} onChange={event => setScopeNote(event.target.value)} minLength={10} placeholder="Scope note" className="min-h-[50px] border border-black/25 bg-white px-2 py-1.5 text-xs" />
      <Button type="submit" disabled={recordLetter.isPending} className="w-fit h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{recordLetter.isPending ? "Recording…" : "Record engagement letter"}</Button>
    </form> : <p className="text-xs text-black/55">Recording the engagement letter is an admin action.</p>)}

    {engagement.phase === "access_provisioning" && (canManage ? <form className="grid gap-2" onSubmit={submitAccess}>
      <Input value={auditorSubject} onChange={event => setAuditorSubject(event.target.value)} placeholder="Auditor's platform subject (granted via Admins page)" className="h-8 rounded-none border-black/25 text-xs" />
      <Button type="submit" disabled={provisionAccess.isPending} className="w-fit h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{provisionAccess.isPending ? "Recording…" : "Record access provisioning"}</Button>
    </form> : <p className="text-xs text-black/55">Recording access provisioning is an admin action.</p>)}

    {engagement.phase === "audit_fieldwork" && (canManage ? <form className="grid gap-2" onSubmit={submitFieldwork}>
      <textarea value={fieldworkNote} onChange={event => setFieldworkNote(event.target.value)} minLength={10} placeholder="Fieldwork note" className="min-h-[50px] border border-black/25 bg-white px-2 py-1.5 text-xs" />
      <Button type="submit" disabled={recordFieldwork.isPending} className="w-fit h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{recordFieldwork.isPending ? "Recording…" : "Record fieldwork"}</Button>
    </form> : <p className="text-xs text-black/55">Recording fieldwork is an admin action.</p>)}

    {engagement.phase === "annual_review" && <div className="grid gap-2">
      <p className="text-xs text-black/55">{engagement.lastAnnualReviewAt ? `Last reviewed ${new Date(engagement.lastAnnualReviewAt).toLocaleDateString()}.` : "No annual review recorded yet."} {engagement.nextAnnualReviewDueAt ? `Next review due ${new Date(engagement.nextAnnualReviewDueAt).toLocaleDateString()}.` : ""}</p>
      {canManage && <form className="flex flex-wrap items-end gap-2" onSubmit={submitReview}>
        <label className="grid gap-1"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Next review due</span><Input type="date" value={nextReviewDueAt} onChange={event => setNextReviewDueAt(event.target.value)} className="h-8 rounded-none border-black/25 text-xs" /></label>
        <Button type="submit" disabled={recordReview.isPending} className="h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{recordReview.isPending ? "Recording…" : "Record annual review"}</Button>
      </form>}
    </div>}

    <div className="border-t border-black/10 pt-2 text-[11px] leading-5 text-black/45">
      {engagement.engagementLetterSignedAt && <p>Engagement letter signed {new Date(engagement.engagementLetterSignedAt).toLocaleDateString()}. Scope: {engagement.scopeNote}</p>}
      {engagement.accessProvisionedAt && <p>Read-only access provisioned to {engagement.auditorSubject} on {new Date(engagement.accessProvisionedAt).toLocaleDateString()} by {engagement.accessProvisionedBy}.</p>}
      {engagement.fieldworkCompletedAt && <p>Fieldwork recorded {new Date(engagement.fieldworkCompletedAt).toLocaleDateString()}: {engagement.fieldworkNote}</p>}
    </div>
  </div>;
}

export function AuditorEngagementWorkspace({ role }: { role: OperatorRole | undefined }) {
  const engagements = trpc.postgres.auditorEngagements.useQuery();
  const utils = trpc.useUtils();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [firmName, setFirmName] = useState("");
  const [engagementReference, setEngagementReference] = useState("");
  const canManage = role === "admin";

  const start = trpc.postgres.startAuditorEngagement.useMutation({
    onSuccess: () => { toast.success("Engagement started."); setFirmName(""); setEngagementReference(""); void utils.postgres.auditorEngagements.invalidate(); },
    onError: error => toast.error(error.message),
  });

  if (role !== "admin") {
    return <section className="uf-panel"><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Auditor Engagements</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.045em]">Auditor Engagements</h2></div><div className="px-5 py-8 text-sm text-black/55">Only administrators may view or manage auditor engagement records.</div></section>;
  }

  const submitNewEngagement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!firmName.trim() || !engagementReference.trim()) { toast.error("A firm name and engagement reference are required."); return; }
    start.mutate({ auditorFirmName: firmName.trim(), engagementReference: engagementReference.trim() });
  };

  return <section className="uf-panel min-w-0">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-black/20 px-5 py-4">
      <div><p className="uf-kicker">OM Ch.10 · Auditors and Regulators</p><h2 className="mt-1 text-lg font-black tracking-[-0.045em] uppercase">Auditor Engagements</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">Tracks the external-auditor engagement lifecycle only: engagement letter/scope, read-only access provisioning, audit fieldwork, annual review. Regulator engagement (CBN, CBK, SARB, SEC) is not tracked here — see the CBN Sandbox module, which already covers supervised, by-exception regulator access.</p></div>
    </div>
    <div className="border-b border-black/10 px-5 py-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={submitNewEngagement}>
        <label className="grid gap-1"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Auditor firm</span><Input value={firmName} onChange={event => setFirmName(event.target.value)} className="h-9 rounded-none border-black/25" placeholder="e.g. KPMG Nigeria" /></label>
        <label className="grid gap-1"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Engagement reference</span><Input value={engagementReference} onChange={event => setEngagementReference(event.target.value)} className="h-9 rounded-none border-black/25" placeholder="e.g. FY2026 external audit" /></label>
        <Button type="submit" disabled={start.isPending} className="h-9 rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{start.isPending ? "Starting…" : "Start engagement"}</Button>
      </form>
    </div>
    {engagements.isLoading ? <div className="px-5 py-8 text-sm text-black/55">Loading auditor engagements…</div> : (engagements.data ?? []).length === 0 ? <div className="px-5 py-10 text-sm text-black/55">No auditor engagements recorded yet.</div> : <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr className="border-b border-black/20 text-left text-[10px] font-black uppercase tracking-[0.12em] text-black/50"><th className="py-2 pl-5">Firm</th><th className="py-2">Engagement</th><th className="py-2">Phase</th><th className="py-2 pr-5">Started</th></tr></thead><tbody>{(engagements.data ?? []).map(row => { const isExpanded = expandedId === row.id; return <Fragment key={row.id}>
      <tr className="border-b border-black/10 align-top hover:bg-black/[0.02]"><td className="py-3 pl-5 font-bold">{row.auditorFirmName}</td><td className="py-3 text-black/65">{row.engagementReference}</td><td className="py-3"><button type="button" onClick={() => setExpandedId(isExpanded ? null : row.id)} className="border border-black/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide hover:bg-black hover:text-white">{phaseLabels[row.phase]}</button></td><td className="py-3 pr-5 text-xs text-black/50">{new Date(row.createdAt).toLocaleDateString()}</td></tr>
      {isExpanded && <tr className="border-b border-black/10 bg-black/[0.01]"><td colSpan={4} className="px-5 py-3"><EngagementPanel engagement={row} canManage={canManage} onChanged={() => void engagements.refetch()} /></td></tr>}
    </Fragment>; })}</tbody></table></div>}
  </section>;
}
