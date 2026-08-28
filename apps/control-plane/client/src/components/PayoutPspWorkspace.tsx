import { FormEvent, ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CounterpartyOnboardingRow } from "@/components/CounterpartyOnboardingControls";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";

type PspArchetype = "bank_instant_rail" | "mobile_money" | "virtual_card_issuer" | "otc_cash_pickup" | "aggregator_psp";
type PspEvidenceType =
  | "psp_licence" | "mobile_money_authorisation" | "aggregator_licence" | "sanctions_pep_attestation"
  | "aml_cft_policy" | "beneficial_ownership_disclosure" | "cutoff_settlement_calendar" | "fee_schedule_fx_margin"
  | "reconciliation_file_format_spec" | "dispute_recall_channel_sla" | "audited_financials" | "cyber_bcp_attestation";
type PspGate = "licence_rail_coverage" | "settlement_cutoff_validation" | "bounded_live" | "failover_rail";
type Corridor = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";

const archetypeLabels: Record<PspArchetype, string> = {
  bank_instant_rail: "Bank-instant rail (NIBSS / PesaLink / RTGS)",
  mobile_money: "Mobile money (M-Pesa / MoMo / Airtel / Orange)",
  virtual_card_issuer: "Virtual-card issuer",
  otc_cash_pickup: "OTC / cash pickup",
  aggregator_psp: "Aggregator PSP",
};

const corridorLabel: Record<Corridor, string> = { NIGERIA_NGN: "Nigeria (NGN)", KENYA_KES: "Kenya (KES)", SOUTH_AFRICA_ZAR: "South Africa (ZAR)" };

/** OM §7.4's 12-item payout-PSP evidence pack, verbatim. */
const evidencePack: Array<{ type: PspEvidenceType; label: string }> = [
  { type: "psp_licence", label: "PSP licence per country (CBN PSP · CMA-CBK · FSCA-PFS/NBFI)" },
  { type: "mobile_money_authorisation", label: "Mobile-money operator authorisation per country" },
  { type: "aggregator_licence", label: "Aggregator licence (where PSP operates as aggregator)" },
  { type: "sanctions_pep_attestation", label: "Sanctions & PEP process attestation" },
  { type: "aml_cft_policy", label: "AML/CFT policy document and officer attestation" },
  { type: "beneficial_ownership_disclosure", label: "Beneficial-ownership disclosure (≥ 10%)" },
  { type: "cutoff_settlement_calendar", label: "Cutoff / settlement calendar per destination corridor" },
  { type: "fee_schedule_fx_margin", label: "Fee schedule and FX-margin policy" },
  { type: "reconciliation_file_format_spec", label: "Reconciliation file format specification (sample supplied)" },
  { type: "dispute_recall_channel_sla", label: "Dispute / recall channel and SLA" },
  { type: "audited_financials", label: "Two-year audited financials" },
  { type: "cyber_bcp_attestation", label: "Cyber posture + most recent BCP attestation" },
];

const gateLabels: Record<PspGate, string> = {
  licence_rail_coverage: "G1 Licence & rail coverage",
  settlement_cutoff_validation: "G2 Settlement & cutoff validation",
  bounded_live: "G3 Bounded-live",
  failover_rail: "G4 Failover rail",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">{label}</span>{children}</label>;
}

type WorkspaceData = {
  counterparty: { id: string; legalName: string; counterpartyType: string; jurisdiction: string; pspArchetype: PspArchetype | null; createdAt: Date };
  evidenceItems: Array<{ id: string; counterpartyId: string; evidenceType: PspEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>;
  authorizations: Array<{ id: string; counterpartyId: string; legalName: string; regulator: string; licenceReference: string; scopeDescription: string; evidenceUri: string; validFrom: string; validTo: string | null; status: string; verifiedBy: string | null; verifiedAt: Date | null }>;
  onboarding: CounterpartyOnboardingRow | undefined;
  gateDecisions: Array<{ id: string; gate: PspGate; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date; cycleNumber: number }>;
  activity: Array<{ id: string; actorSubject: string; actorRole: string; action: string; objectType: string; objectId: string; metadata: unknown; occurredAt: Date }>;
};

function relativeTime(iso: string | Date) {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function latestByGate(decisions: WorkspaceData["gateDecisions"], gate: PspGate) {
  return decisions.find(decision => decision.gate === gate);
}

function OverviewTab({ workspace }: { workspace: WorkspaceData }) {
  const { counterparty, evidenceItems, authorizations, onboarding, gateDecisions } = workspace;
  const documentedCount = evidencePack.filter(item => evidenceItems.some(row => row.evidenceType === item.type)).length;
  const verifiedLicence = authorizations.some(row => row.status === "verified");
  const gates: PspGate[] = ["licence_rail_coverage", "settlement_cutoff_validation", "bounded_live", "failover_rail"];

  return <div className="grid gap-5 p-5">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryStat label="Archetype (OM §7.2)" value={counterparty.pspArchetype ? archetypeLabels[counterparty.pspArchetype] : "Not yet structured"} />
      <SummaryStat label="Jurisdiction" value={counterparty.jurisdiction} />
      <SummaryStat label="Evidence items present" value={`${documentedCount} / ${evidencePack.length} (OM §7.4)`} />
      <SummaryStat label="Onboarding record" value={onboarding ? `Cycle ${onboarding.cycleNumber} started` : "Not started"} />
    </div>
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">OM §7.6 gates — all four are payout-PSP specific; none reuse the shared legal/technical/pilot lifecycle</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {gates.map(gate => {
          const decision = latestByGate(gateDecisions, gate);
          return <div key={gate} className="border border-black/10 p-3"><p className="text-xs font-black uppercase">{gateLabels[gate]}</p><p className="mt-1 text-sm">{decision ? (decision.decision === "approved" ? "Approved" : "Blocked") : "Not evaluated"}{!onboarding && " — requires an onboarding record first"}</p></div>;
        })}
      </div>
      <p className="mt-2 text-xs text-black/50">{verifiedLicence ? "A licence authorisation is verified for this partner." : "No verified licence authorisation yet."}</p>
    </div>
    <p className="text-xs leading-5 text-black/55">Operational controls the OM specifies for a live PSP relationship — per-rail failure-rate monitoring, cutoff-violation auto-reroute, reconciliation-break investigation, dispute-backlog ageing, PSP-outage MTTR — have no representation in this system. This workspace only covers onboarding evidence and gates, not live payout routing.</p>
  </div>;
}

function ArchetypeAndCoverageTab({ workspace, canEdit }: { workspace: WorkspaceData; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const { counterparty, authorizations } = workspace;
  const [archetype, setArchetype] = useState<PspArchetype | "">(counterparty.pspArchetype ?? "");
  const updateArchetype = trpc.postgres.updateCounterpartyPspArchetype.useMutation({
    onSuccess: () => { toast.success("Archetype updated."); void utils.postgres.payoutPspWorkspace.invalidate(); void utils.postgres.payoutPsps.invalidate(); },
    onError: error => toast.error(error.message),
  });

  return <div className="grid gap-6 p-5">
    {canEdit ? <div className="grid gap-3 border border-black/15 bg-black/[0.02] p-4 sm:grid-cols-[1fr_auto]">
      <Field label="Archetype (OM §7.2)">
        <select className="h-10 border border-black/25 bg-white px-2 text-sm" value={archetype} onChange={event => setArchetype(event.target.value as PspArchetype | "")}>
          <option value="">Not set</option>
          {(Object.entries(archetypeLabels) as [PspArchetype, string][]).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </Field>
      <Button disabled={!archetype || updateArchetype.isPending} onClick={() => archetype && updateArchetype.mutate({ counterpartyId: counterparty.id, archetype })} className="h-10 self-end rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{updateArchetype.isPending ? "Saving…" : "Save"}</Button>
    </div> : <p className="text-sm text-black/55">Setting the archetype is a compliance action.</p>}

    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Licence authorisations ({authorizations.length})</p>
      {authorizations.length === 0 ? <p className="mt-2 text-sm text-black/55">No licence authorisation recorded yet. Record one from the Counterparties &amp; Licences tab in the Registry module.</p> : <div className="mt-2 divide-y divide-black/10">{authorizations.map(row => <div key={row.id} className="grid grid-cols-[1fr_auto] gap-2 py-2 text-sm"><div><p className="font-bold">{row.regulator} · {row.licenceReference}</p><p className="text-xs text-black/55">{row.scopeDescription}</p></div><span className="self-center border border-black/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide">{row.status.replaceAll("_", " ")}</span></div>)}</div>}
    </div>
  </div>;
}

function EvidenceTab({ workspace, canEdit }: { workspace: WorkspaceData; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const { counterparty, evidenceItems } = workspace;
  const [evidenceType, setEvidenceType] = useState<PspEvidenceType>("psp_licence");
  const recordEvidence = trpc.postgres.recordPspEvidenceItem.useMutation({
    onSuccess: () => { toast.success("Evidence item recorded."); void utils.postgres.payoutPspWorkspace.invalidate(); void utils.postgres.payoutPsps.invalidate(); },
    onError: error => toast.error(error.message),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const evidenceUri = String(data.get("evidenceUri") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    if (!evidenceUri) return;
    recordEvidence.mutate({ counterpartyId: counterparty.id, evidenceType, evidenceUri, note: note || undefined });
    event.currentTarget.reset();
  };

  return <div className="grid gap-6 p-5">
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">OM §7.4 evidence checklist</p>
      <div className="mt-2 overflow-x-auto"><table className="w-full border-collapse text-sm"><tbody>
        {evidencePack.map(item => {
          const present = evidenceItems.some(row => row.evidenceType === item.type);
          return <tr key={item.type} className="border-b border-black/10"><td className="py-2 pr-3">{item.label}</td><td className="py-2 text-right"><span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${present ? "bg-black text-white" : "bg-black/5 text-black/45"}`}>{present ? "Present" : "Not yet structured"}</span></td></tr>;
        })}
      </tbody></table></div>
    </div>

    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Recorded evidence ({evidenceItems.length})</p>
      {evidenceItems.length === 0 ? <p className="mt-2 text-sm text-black/55">No evidence recorded yet.</p> : <div className="mt-2 divide-y divide-black/10">{evidenceItems.map(row => <div key={row.id} className="py-2 text-sm"><p className="font-bold">{evidencePack.find(item => item.type === row.evidenceType)?.label ?? row.evidenceType}</p><p className="text-xs text-black/55">{row.evidenceUri} · recorded {relativeTime(row.recordedAt)} by {row.recordedBy}</p>{row.note && <p className="mt-1 text-xs text-black/65">{row.note}</p>}</div>)}</div>}
    </div>

    {canEdit && <form className="grid gap-3 border border-black/15 bg-black/[0.02] p-4" onSubmit={submit}>
      <p className="text-sm font-black uppercase tracking-[-0.02em]">Record an evidence item</p>
      <Field label="Evidence type">
        <select className="h-10 border border-black/25 bg-white px-2 text-sm" value={evidenceType} onChange={event => setEvidenceType(event.target.value as PspEvidenceType)}>
          {evidencePack.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
        </select>
      </Field>
      <Field label="Evidence URL"><Input name="evidenceUri" type="url" required className="rounded-none" placeholder="https://…" /></Field>
      <Field label="Note (optional)"><Input name="note" className="rounded-none" /></Field>
      <Button type="submit" disabled={recordEvidence.isPending} className="w-fit rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{recordEvidence.isPending ? "Recording…" : "Record evidence"}</Button>
    </form>}
  </div>;
}

function StartOnboardingForm({ counterpartyId, pending, create }: { counterpartyId: string; pending: boolean; create: (input: { counterpartyId: string; countryOverlays: Corridor[]; legalEvidenceUri: string; recertificationDueAt: Date }) => void }) {
  const [overlays, setOverlays] = useState<Corridor[]>(["NIGERIA_NGN"]);
  const toggleOverlay = (overlay: Corridor) => setOverlays(current => current.includes(overlay) ? current.filter(value => value !== overlay) : [...current, overlay]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!overlays.length) { toast.error("At least one country overlay is required."); return; }
    const data = new FormData(event.currentTarget);
    create({ counterpartyId, countryOverlays: overlays, legalEvidenceUri: String(data.get("legalEvidenceUri")), recertificationDueAt: new Date(String(data.get("recertificationDueAt"))) });
  };

  return <form className="grid gap-3 border border-black/15 bg-black/[0.02] p-4" onSubmit={submit}>
    <p className="text-sm font-black uppercase tracking-[-0.02em]">Start onboarding record</p>
    <p className="text-xs leading-5 text-black/55">Every counterparty gets one onboarding record on this platform. For payout PSPs it exists as an anchor for the four OM §7.6 gate decisions below — it is not decided via the generic legal/technical/pilot buttons used elsewhere, since none of this chapter's gates match those criteria.</p>
    <fieldset className="grid gap-2"><legend className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Country overlays</legend><div className="flex flex-wrap gap-3">{(Object.keys(corridorLabel) as Corridor[]).map(overlay => <Label key={overlay} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overlays.includes(overlay)} onChange={() => toggleOverlay(overlay)} />{corridorLabel[overlay]}</Label>)}</div></fieldset>
    <Field label="Legal evidence URL"><Input name="legalEvidenceUri" type="url" required className="rounded-none" placeholder="https://…" /></Field>
    <Field label="Next recertification due"><Input name="recertificationDueAt" type="datetime-local" required className="rounded-none" /></Field>
    <Button type="submit" disabled={pending} className="w-fit rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{pending ? "Starting…" : "Start onboarding record"}</Button>
  </form>;
}

function GateSection({ gate, ownershipNote, canDecide, decisions, decide, pending }: { gate: PspGate; ownershipNote: string; canDecide: boolean; decisions: WorkspaceData["gateDecisions"]; decide: (decision: "approved" | "blocked", rationale: string) => void; pending: boolean }) {
  const [rationale, setRationale] = useState("");
  const gateDecisions = decisions.filter(decision => decision.gate === gate);

  const submit = (decision: "approved" | "blocked") => {
    if (rationale.trim().length < 10) { toast.error("A rationale of at least 10 characters is required."); return; }
    decide(decision, rationale.trim());
    setRationale("");
  };

  return <div className="border border-black/10 p-4">
    <p className="text-xs font-black uppercase tracking-[0.1em]">{gateLabels[gate]}</p>
    {canDecide ? <div className="mt-2 grid gap-2">
      <textarea value={rationale} onChange={event => setRationale(event.target.value)} minLength={10} placeholder="Decision rationale" className="min-h-[60px] border border-black/25 bg-white px-3 py-2 text-sm" />
      <div className="flex gap-2"><Button type="button" disabled={pending} onClick={() => submit("approved")} className="rounded-none bg-black text-xs font-black uppercase hover:bg-[#e11919]">Approve</Button><Button type="button" variant="outline" disabled={pending} onClick={() => submit("blocked")} className="rounded-none text-xs font-black uppercase">Block</Button></div>
    </div> : <p className="mt-2 text-sm text-black/55">Recording this decision requires a different role.</p>}
    <p className="mt-2 text-xs leading-5 text-black/55">{ownershipNote}</p>
    {gateDecisions.length > 0 && <div className="mt-3 grid gap-2">{gateDecisions.map(decision => <div key={decision.id} className="border border-black/10 px-3 py-2 text-sm"><span className={`font-black uppercase ${decision.decision === "approved" ? "text-black" : "text-[#e11919]"}`}>{decision.decision}</span><span className="text-black/55"> · {decision.decidedBy} · {new Date(decision.decidedAt).toLocaleString()}</span><p className="mt-1 text-black/65">{decision.rationale}</p></div>)}</div>}
  </div>;
}

function GatesTab({ workspace, role }: { workspace: WorkspaceData; role: OperatorRole | undefined }) {
  const utils = trpc.useUtils();
  const { counterparty, onboarding, gateDecisions } = workspace;

  const invalidate = async () => { await Promise.all([utils.postgres.payoutPspWorkspace.invalidate(), utils.postgres.counterpartyOnboardings.invalidate()]); };
  const createOnboarding = trpc.postgres.createCounterpartyOnboarding.useMutation({ onSuccess: () => { toast.success("Onboarding record started."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideG1 = trpc.postgres.decidePspLicenceRailGate.useMutation({ onSuccess: () => { toast.success("Decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideG2 = trpc.postgres.decidePspSettlementCutoffGate.useMutation({ onSuccess: () => { toast.success("Decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideG3 = trpc.postgres.decidePspBoundedLiveGate.useMutation({ onSuccess: () => { toast.success("Decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideG4 = trpc.postgres.decidePspFailoverGate.useMutation({ onSuccess: () => { toast.success("Decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });

  return <div className="grid gap-6 p-5">
    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">OM §7.6 — four payout-PSP specific gates, decided independently of the shared legal/technical/pilot lifecycle used by other counterparty types</p>

    {!onboarding ? <StartOnboardingForm counterpartyId={counterparty.id} pending={createOnboarding.isPending} create={createOnboarding.mutate} /> : <div className="grid gap-4">
      <GateSection
        gate="licence_rail_coverage"
        ownershipNote="OM ownership: Compliance + Country Lead. This platform has no distinct Country Lead role; restricted to compliance/admin as the closest match."
        canDecide={role === "admin" || role === "compliance_officer"}
        decisions={gateDecisions}
        pending={decideG1.isPending}
        decide={(decision, rationale) => decideG1.mutate({ onboardingId: onboarding.id, decision, rationale })}
      />
      <GateSection
        gate="settlement_cutoff_validation"
        ownershipNote="OM ownership: Operations + Treasury. This platform has no distinct Operations role; restricted to treasury/admin as the closest match."
        canDecide={role === "admin" || role === "treasury_operator"}
        decisions={gateDecisions}
        pending={decideG2.isPending}
        decide={(decision, rationale) => decideG2.mutate({ onboardingId: onboarding.id, decision, rationale })}
      />
      <GateSection
        gate="bounded_live"
        ownershipNote="OM ownership: Operations + Compliance. This platform has no distinct Operations role; restricted to compliance/admin as the closest match. The OM's 30-day minimum window and ≤1% failure-rate threshold are not separately measured anywhere in this build — this records a decision only."
        canDecide={role === "admin" || role === "compliance_officer"}
        decisions={gateDecisions}
        pending={decideG3.isPending}
        decide={(decision, rationale) => decideG3.mutate({ onboardingId: onboarding.id, decision, rationale })}
      />
      <GateSection
        gate="failover_rail"
        ownershipNote="OM ownership: Operations + Country Lead. Neither role exists on this platform; restricted to admin only. No failover rail testing exists anywhere in this build — this records a decision only."
        canDecide={role === "admin"}
        decisions={gateDecisions}
        pending={decideG4.isPending}
        decide={(decision, rationale) => decideG4.mutate({ onboardingId: onboarding.id, decision, rationale })}
      />
    </div>}
  </div>;
}

function ActivityTab({ workspace }: { workspace: WorkspaceData }) {
  return <div className="grid gap-5 p-5">
    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Activity (reconstructed from real timestamped rows)</p>
    {workspace.activity.length === 0 ? <p className="mt-2 text-sm text-black/55">No activity recorded yet.</p> : <div className="mt-2 divide-y divide-black/10">{workspace.activity.map(event => <div key={event.id} className="py-2 text-sm"><span className="font-bold">{event.action.replaceAll(/[._]/g, " ")}</span><span className="text-black/55"> · {event.actorSubject} · {new Date(event.occurredAt).toLocaleString()}</span></div>)}</div>}
    <div className="border-t border-black/10 pt-4">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Recertification (OM §7.9)</p>
      <p className="mt-2 text-sm text-black/55">Annual licence/fee-schedule refresh and quarterly performance review exist only as a manual re-review, not a scheduled trigger. Weekly sanctions-list refresh checks and quarterly failover test events the OM specifies are not monitored or scheduled anywhere in this build.</p>
    </div>
  </div>;
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return <div className="border border-black/10 p-3"><p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">{label}</p><p className="mt-1 text-sm font-bold">{value}</p></div>;
}

function PayoutPspDetail({ counterpartyId, onBack, role }: { counterpartyId: string; onBack: () => void; role: OperatorRole | undefined }) {
  const workspace = trpc.postgres.payoutPspWorkspace.useQuery({ counterpartyId });
  const canEdit = role === "admin" || role === "compliance_officer";
  if (workspace.isLoading) return <div className="px-5 py-10 text-sm text-black/55">Loading payout PSP workspace…</div>;
  if (!workspace.data) return <div className="px-5 py-10 text-sm text-black/55">Counterparty record was not found.</div>;
  const { counterparty } = workspace.data;
  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/20 px-5 py-4">
      <div>
        <button type="button" onClick={onBack} className="text-xs font-bold uppercase tracking-wide text-black/50 hover:text-black">← Payout PSPs</button>
        <h3 className="mt-1 text-xl font-black tracking-[-0.03em]">{counterparty.legalName}</h3>
        <p className="mt-1 text-xs text-black/55">{counterparty.jurisdiction} · licensed PSP</p>
      </div>
    </div>
    <Tabs defaultValue="overview">
      <TabsList className="mx-5 mt-4 h-auto flex-wrap justify-start gap-1 rounded-none bg-transparent p-0">
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="overview">Overview</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="coverage">Archetype &amp; Coverage</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="evidence">Evidence Pack</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="gates">Gates &amp; Decisions</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="overview"><OverviewTab workspace={workspace.data} /></TabsContent>
      <TabsContent value="coverage"><ArchetypeAndCoverageTab workspace={workspace.data} canEdit={canEdit} /></TabsContent>
      <TabsContent value="evidence"><EvidenceTab workspace={workspace.data} canEdit={canEdit} /></TabsContent>
      <TabsContent value="gates"><GatesTab workspace={workspace.data} role={role} /></TabsContent>
      <TabsContent value="activity"><ActivityTab workspace={workspace.data} /></TabsContent>
    </Tabs>
  </div>;
}

export function PayoutPspWorkspace({ role }: { role: OperatorRole | undefined }) {
  const psps = trpc.postgres.payoutPsps.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const rows = psps.data ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(row => row.legalName.toLowerCase().includes(query) || row.jurisdiction.toLowerCase().includes(query));
  }, [psps.data, search]);

  if (role !== "admin" && role !== "compliance_officer" && role !== "auditor" && role !== "treasury_operator") {
    return <section className="uf-panel"><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Payout PSPs</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.045em]">Payout PSPs</h2></div><div className="px-5 py-8 text-sm text-black/55">This role has no access to payout PSP records.</div></section>;
  }

  if (selectedId) {
    return <section className="uf-panel min-w-0"><PayoutPspDetail counterpartyId={selectedId} onBack={() => setSelectedId(null)} role={role} /></section>;
  }

  return <section className="uf-panel min-w-0">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-black/20 px-5 py-4">
      <div><p className="uf-kicker">OM §7 · Payout PSPs &amp; Mobile-Money Operators</p><h2 className="mt-1 text-lg font-black tracking-[-0.045em] uppercase">Payout PSPs</h2></div>
    </div>
    <p className="border-b border-black/10 px-5 py-3 text-xs leading-5 text-black/55">New payout PSPs are recorded from the Counterparties &amp; Licences tab (type: licensed PSP). This workspace covers OM §7 archetype, evidence pack, and gate tracking for PSPs already registered.</p>
    <div className="border-b border-black/10 px-5 py-3">
      <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by legal name or jurisdiction" className="h-9 max-w-md rounded-none border-black/25" aria-label="Search payout PSPs" />
    </div>
    {psps.isLoading ? <div className="px-5 py-8 text-sm text-black/55">Loading payout PSPs…</div> : filtered.length === 0 ? <div className="px-5 py-10"><p className="text-sm font-bold">No payout PSPs recorded</p><p className="mt-2 max-w-xl text-sm leading-6 text-black/55">Register a counterparty of type "licensed PSP" from the Counterparties &amp; Licences tab to begin its OM §7 evidence trail.</p></div> : <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr className="border-b border-black/20 text-left text-[10px] font-black uppercase tracking-[0.12em] text-black/50"><th className="py-2 pl-5">Legal name</th><th className="py-2">Jurisdiction</th><th className="py-2">Archetype</th><th className="py-2">Evidence</th><th className="py-2">Recorded</th><th className="py-2 pr-5" /></tr></thead><tbody>{filtered.map(row => <tr key={row.id} className="border-b border-black/10 hover:bg-black/[0.02]"><td className="py-2 pl-5 font-bold">{row.legalName}</td><td className="py-2 text-black/65">{row.jurisdiction}</td><td className="py-2 text-black/65">{row.pspArchetype ? archetypeLabels[row.pspArchetype] : <span className="text-black/35">Not yet structured</span>}</td><td className="py-2 text-black/65">{row.evidenceCount}/12 items</td><td className="py-2 text-black/50">{new Date(row.createdAt).toLocaleDateString()}</td><td className="py-2 pr-5 text-right"><Button variant="outline" onClick={() => setSelectedId(row.id)} className="rounded-none text-[10px] font-black uppercase">Open</Button></td></tr>)}</tbody></table></div>}
  </section>;
}
