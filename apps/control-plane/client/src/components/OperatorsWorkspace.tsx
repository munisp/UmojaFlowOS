import { Fragment, FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";

type OnboardingPhase = "role_access_request" | "lms_enrolment" | "shadow_period" | "steady_state";
type OnboardingRecord = {
  id: string;
  subject: string;
  phase: OnboardingPhase;
  sodMatrixReviewed: boolean;
  sodMatrixReviewedBy: string | null;
  sodMatrixReviewedAt: string | Date | null;
  sodMatrixNote: string | null;
  lmsCertReference: string | null;
  lmsCertAssignedAt: string | Date | null;
  shadowPeriodSupervisedBy: string | null;
  shadowPeriodStartedAt: string | Date | null;
  shadowPeriodEndedAt: string | Date | null;
  steadyStateActivatedAt: string | Date | null;
  nextRecertDueAt: string | Date | null;
};

const phaseLabels: Record<OnboardingPhase, string> = {
  role_access_request: "Role & access request",
  lms_enrolment: "LMS enrolment",
  shadow_period: "Shadow period",
  steady_state: "Steady state",
};

type CoreRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";
const coreRoles: CoreRole[] = ["admin", "compliance_officer", "treasury_operator", "auditor"];
const roleLabels: Record<string, string> = {
  admin: "Admin",
  compliance_officer: "Compliance officer",
  treasury_operator: "Treasury operator",
  auditor: "Auditor",
  provider_contact: "Provider contact",
  cbn_liaison: "CBN liaison",
};

function RoleBadge({ role, status }: { role: string | null; status: "assigned" | "suspended" | null }) {
  if (!role) return <span className="border border-dashed border-black/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-black/40">No role</span>;
  const tone = status === "suspended" ? "bg-black/10 text-black/45 line-through" : role === "admin" ? "bg-[#e11919] text-white" : "bg-black text-white";
  return <span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${tone}`}>{roleLabels[role] ?? role}{status === "suspended" ? " (suspended)" : ""}</span>;
}

function RowActions({ operator, currentSubject, onChanged }: { operator: { keycloakUserId: string; subject: string; name: string; role: string | null; enabled: boolean }; currentSubject: string | undefined; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<CoreRole>((coreRoles.includes(operator.role as CoreRole) ? operator.role : "compliance_officer") as CoreRole);
  const [deactivating, setDeactivating] = useState(false);
  const [reason, setReason] = useState("");

  const changeRole = trpc.postgres.changeOperatorRole.useMutation({
    onSuccess: () => { toast.success(`${operator.name} is now ${roleLabels[role]}.`); setEditing(false); void utils.postgres.operators.invalidate(); onChanged(); },
    onError: error => toast.error(error.message),
  });
  const deactivate = trpc.postgres.deactivateOperator.useMutation({
    onSuccess: () => { toast.success(`${operator.name}'s access has been revoked and the account disabled.`); setDeactivating(false); setReason(""); void utils.postgres.operators.invalidate(); onChanged(); },
    onError: error => toast.error(error.message),
  });

  const isSelf = operator.subject === currentSubject;

  return <div className="grid gap-2">
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setEditing(current => !current)} className="rounded-none text-[10px] font-black uppercase">{editing ? "Cancel" : "Change role"}</Button>
      {operator.enabled && !isSelf && <Button variant="outline" onClick={() => setDeactivating(current => !current)} className="rounded-none text-[10px] font-black uppercase text-[#e11919] hover:bg-[#e11919] hover:text-white">{deactivating ? "Cancel" : "Deactivate"}</Button>}
      {!operator.enabled && <span className="self-center text-[10px] font-black uppercase tracking-wide text-black/40">Account disabled</span>}
      {isSelf && <span className="self-center text-[10px] uppercase tracking-wide text-black/35">This is you</span>}
    </div>
    {editing && <div className="flex flex-wrap items-center gap-2 border border-black/15 bg-black/[0.02] p-2">
      <select className="h-8 border border-black/25 bg-white px-2 text-xs" value={role} onChange={event => setRole(event.target.value as CoreRole)}>
        {coreRoles.map(value => <option key={value} value={value}>{roleLabels[value]}</option>)}
      </select>
      <Button disabled={changeRole.isPending} onClick={() => changeRole.mutate({ subject: operator.subject, role })} className="h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{changeRole.isPending ? "Saving…" : "Confirm"}</Button>
    </div>}
    {deactivating && <div className="grid gap-2 border border-[#e11919]/30 bg-[#e11919]/5 p-2">
      <textarea value={reason} onChange={event => setReason(event.target.value)} minLength={10} placeholder="Reason for deactivation (kept in the audit trail)" className="min-h-[60px] border border-black/25 bg-white px-2 py-1.5 text-xs" />
      <Button disabled={deactivate.isPending || reason.trim().length < 10} onClick={() => deactivate.mutate({ keycloakUserId: operator.keycloakUserId, subject: operator.subject, reason: reason.trim() })} className="w-fit h-8 rounded-none bg-[#e11919] text-[10px] font-black uppercase hover:bg-black">{deactivate.isPending ? "Deactivating…" : "Confirm deactivation"}</Button>
    </div>}
  </div>;
}

/**
 * OM Ch.11's own text isn't in the shared export beyond its title -- this
 * panel is built from the "Internal ops users" lane of the Fig 3.1
 * cross-stakeholder map instead: role+access request/SoD matrix, LMS
 * enrolment/cert assignment, shadow period/first-ticket supervision, annual
 * recert/access review. Inferred, not sourced verbatim like every other
 * chapter's build in this series.
 */
function OnboardingLifecyclePanel({ subject, record, canManage, onChanged }: { subject: string; record: OnboardingRecord | undefined; canManage: boolean; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const [sodNote, setSodNote] = useState("");
  const [certReference, setCertReference] = useState("");
  const [supervisedBy, setSupervisedBy] = useState("");
  const [recertDueAt, setRecertDueAt] = useState("");

  const invalidate = () => { void utils.postgres.operatorOnboardingRecords.invalidate(); onChanged(); };
  const start = trpc.postgres.startOperatorOnboarding.useMutation({ onSuccess: () => { toast.success("Onboarding record started."); invalidate(); }, onError: error => toast.error(error.message) });
  const reviewSod = trpc.postgres.recordSodMatrixReview.useMutation({ onSuccess: () => { toast.success("SoD matrix review recorded."); setSodNote(""); invalidate(); }, onError: error => toast.error(error.message) });
  const enrolLms = trpc.postgres.recordLmsEnrolment.useMutation({ onSuccess: () => { toast.success("LMS enrolment recorded."); setCertReference(""); invalidate(); }, onError: error => toast.error(error.message) });
  const superviseShadow = trpc.postgres.recordShadowPeriodSupervision.useMutation({ onSuccess: () => { toast.success("Shadow-period supervision recorded."); setSupervisedBy(""); invalidate(); }, onError: error => toast.error(error.message) });
  const recertify = trpc.postgres.recordOperatorRecertification.useMutation({ onSuccess: () => { toast.success("Recertification recorded."); setRecertDueAt(""); invalidate(); }, onError: error => toast.error(error.message) });

  if (!record) {
    return <div className="border border-black/15 bg-black/[0.02] p-3">
      <p className="text-xs leading-5 text-black/55">No onboarding lifecycle record yet for this operator.</p>
      {canManage && <Button disabled={start.isPending} onClick={() => start.mutate({ subject })} className="mt-2 h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{start.isPending ? "Starting…" : "Start onboarding record"}</Button>}
    </div>;
  }

  const submitSod = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (sodNote.trim().length < 10) { toast.error("A note of at least 10 characters is required."); return; } reviewSod.mutate({ onboardingId: record.id, note: sodNote.trim() }); };
  const submitLms = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!certReference.trim()) { toast.error("A certification reference is required."); return; } enrolLms.mutate({ onboardingId: record.id, certReference: certReference.trim() }); };
  const submitShadow = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!supervisedBy.trim()) { toast.error("A supervising operator is required."); return; } superviseShadow.mutate({ onboardingId: record.id, supervisedBy: supervisedBy.trim() }); };
  const submitRecert = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!recertDueAt) { toast.error("A next recertification date is required."); return; } recertify.mutate({ onboardingId: record.id, nextRecertDueAt: new Date(recertDueAt) }); };

  return <div className="grid gap-3 border border-black/15 bg-black/[0.02] p-3 text-sm">
    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Current phase: {phaseLabels[record.phase]}</p>

    {record.phase === "role_access_request" && (canManage ? <form className="grid gap-2" onSubmit={submitSod}>
      <textarea value={sodNote} onChange={event => setSodNote(event.target.value)} minLength={10} placeholder="SoD matrix review note" className="min-h-[50px] border border-black/25 bg-white px-2 py-1.5 text-xs" />
      <Button type="submit" disabled={reviewSod.isPending} className="w-fit h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{reviewSod.isPending ? "Recording…" : "Record SoD matrix review"}</Button>
    </form> : <p className="text-xs text-black/55">SoD matrix review is an admin action.</p>)}

    {record.phase === "lms_enrolment" && (canManage ? <form className="grid gap-2" onSubmit={submitLms}>
      <Input value={certReference} onChange={event => setCertReference(event.target.value)} placeholder="Certification / LMS reference" className="h-8 rounded-none border-black/25 text-xs" />
      <Button type="submit" disabled={enrolLms.isPending} className="w-fit h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{enrolLms.isPending ? "Recording…" : "Record LMS enrolment"}</Button>
    </form> : <p className="text-xs text-black/55">LMS enrolment is a compliance action.</p>)}

    {record.phase === "shadow_period" && (canManage ? <form className="grid gap-2" onSubmit={submitShadow}>
      <Input value={supervisedBy} onChange={event => setSupervisedBy(event.target.value)} placeholder="Supervising operator" className="h-8 rounded-none border-black/25 text-xs" />
      <Button type="submit" disabled={superviseShadow.isPending} className="w-fit h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{superviseShadow.isPending ? "Recording…" : "Record first-ticket supervision"}</Button>
    </form> : <p className="text-xs text-black/55">Shadow-period supervision is an admin action.</p>)}

    {record.phase === "steady_state" && <div className="grid gap-2">
      <p className="text-xs text-black/55">Steady state since {record.steadyStateActivatedAt ? new Date(record.steadyStateActivatedAt).toLocaleDateString() : "—"}. {record.nextRecertDueAt ? `Next recertification due ${new Date(record.nextRecertDueAt).toLocaleDateString()}.` : "No recertification due date set yet."}</p>
      {canManage && <form className="flex flex-wrap items-end gap-2" onSubmit={submitRecert}>
        <label className="grid gap-1"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Next recert due</span><Input type="date" value={recertDueAt} onChange={event => setRecertDueAt(event.target.value)} className="h-8 rounded-none border-black/25 text-xs" /></label>
        <Button type="submit" disabled={recertify.isPending} className="h-8 rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{recertify.isPending ? "Recording…" : "Record recertification"}</Button>
      </form>}
    </div>}

    <div className="border-t border-black/10 pt-2 text-[11px] leading-5 text-black/45">
      {record.sodMatrixReviewed && <p>SoD matrix reviewed by {record.sodMatrixReviewedBy} on {record.sodMatrixReviewedAt && new Date(record.sodMatrixReviewedAt).toLocaleDateString()}.</p>}
      {record.lmsCertAssignedAt && <p>LMS cert "{record.lmsCertReference}" assigned {new Date(record.lmsCertAssignedAt).toLocaleDateString()}.</p>}
      {record.shadowPeriodEndedAt && <p>Shadow period supervised by {record.shadowPeriodSupervisedBy}, ended {new Date(record.shadowPeriodEndedAt).toLocaleDateString()}.</p>}
    </div>
  </div>;
}

export function OperatorsWorkspace({ role, currentSubject }: { role: OperatorRole | undefined; currentSubject: string | undefined }) {
  const operators = trpc.postgres.operators.useQuery();
  const onboardingRecords = trpc.postgres.operatorOnboardingRecords.useQuery();
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
  const canManage = role === "admin";

  const latestOnboardingBySubject = useMemo(() => {
    const map = new Map<string, OnboardingRecord>();
    for (const record of (onboardingRecords.data ?? []) as OnboardingRecord[]) if (!map.has(record.subject)) map.set(record.subject, record);
    return map;
  }, [onboardingRecords.data]);

  const filtered = useMemo(() => {
    const rows = operators.data ?? [];
    const query = search.trim().toLowerCase();
    return rows.filter(row => {
      if (roleFilter !== "all" && (row.role ?? "none") !== roleFilter) return false;
      if (!query) return true;
      return row.name.toLowerCase().includes(query) || row.email.toLowerCase().includes(query);
    });
  }, [operators.data, search, roleFilter]);

  const adminCount = (operators.data ?? []).filter(row => row.role === "admin").length;

  if (role !== "admin") {
    return <section className="uf-panel"><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Admins</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.045em]">Admins</h2></div><div className="px-5 py-8 text-sm text-black/55">Only administrators may view or manage operator accounts.</div></section>;
  }

  return <section className="uf-panel min-w-0">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-black/20 px-5 py-4">
      <div><p className="uf-kicker">Identity provider directory</p><h2 className="mt-1 text-lg font-black tracking-[-0.045em] uppercase">Admins &amp; Operators</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">Every account in the identity provider, cross-referenced with its current role. {adminCount} account{adminCount === 1 ? "" : "s"} currently hold admin. Changing a role here revokes the old grant before recording the new one — never both at once.</p></div>
    </div>
    <div className="flex flex-wrap gap-3 border-b border-black/10 px-5 py-3">
      <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name or email" className="h-9 max-w-xs rounded-none border-black/25" aria-label="Search operators" />
      <select aria-label="Filter by role" className="h-9 border border-black/25 bg-white px-2 text-sm" value={roleFilter} onChange={event => setRoleFilter(event.target.value)}>
        <option value="all">All roles</option>
        {coreRoles.map(value => <option key={value} value={value}>{roleLabels[value]}</option>)}
        <option value="provider_contact">Provider contact</option>
        <option value="cbn_liaison">CBN liaison</option>
        <option value="none">No role</option>
      </select>
    </div>
    {operators.isLoading ? <div className="px-5 py-8 text-sm text-black/55">Loading the operator directory…</div> : operators.error ? <div className="px-5 py-8 text-sm text-black/55">{operators.error.message}</div> : filtered.length === 0 ? <div className="px-5 py-10 text-sm text-black/55">No accounts match this filter.</div> : <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr className="border-b border-black/20 text-left text-[10px] font-black uppercase tracking-[0.12em] text-black/50"><th className="py-2 pl-5">Name</th><th className="py-2">Email</th><th className="py-2">Role</th><th className="py-2">Assigned</th><th className="py-2">Onboarding</th><th className="py-2 pr-5">Actions</th></tr></thead><tbody>{filtered.map(row => { const onboarding = latestOnboardingBySubject.get(row.subject); const isExpanded = expandedSubject === row.subject; return <Fragment key={row.keycloakUserId}>
      <tr className="border-b border-black/10 align-top hover:bg-black/[0.02]"><td className="py-3 pl-5 font-bold">{row.name}{!row.enabled && <span className="ml-2 text-[10px] font-black uppercase text-[#e11919]">disabled</span>}</td><td className="py-3 text-black/65">{row.email}</td><td className="py-3"><RoleBadge role={row.role} status={row.roleStatus} /></td><td className="py-3 text-xs text-black/50">{row.assignedAt ? <>{new Date(row.assignedAt).toLocaleDateString()}<br />by {row.assignedBy}</> : "—"}</td><td className="py-3"><button type="button" onClick={() => setExpandedSubject(isExpanded ? null : row.subject)} className="border border-black/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide hover:bg-black hover:text-white">{onboarding ? phaseLabels[onboarding.phase] : "Not started"}</button></td><td className="py-3 pr-5">{canManage ? <RowActions operator={row} currentSubject={currentSubject} onChanged={() => void utils.postgres.operators.invalidate()} /> : null}</td></tr>
      {isExpanded && <tr className="border-b border-black/10 bg-black/[0.01]"><td colSpan={6} className="px-5 py-3"><OnboardingLifecyclePanel subject={row.subject} record={onboarding} canManage={canManage} onChanged={() => void onboardingRecords.refetch()} /></td></tr>}
    </Fragment>; })}</tbody></table></div>}
    <p className="border-t border-black/10 px-5 py-3 text-[11px] leading-5 text-black/45">Provider contact and CBN liaison roles are scoped to a specific counterparty or CBN dossier and can't be reassigned from here — see Counterparties or CBN Sandbox. Deactivating an account disables Keycloak sign-in and revokes every active role grant; it does not delete the account or its history.</p>
  </section>;
}
