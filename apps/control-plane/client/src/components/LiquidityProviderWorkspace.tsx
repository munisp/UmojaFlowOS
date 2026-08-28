import { FormEvent, ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CounterpartyOnboardingControls, type CounterpartyOnboardingRow } from "@/components/CounterpartyOnboardingControls";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";

type LpArchetype = "principal_market_maker" | "regional_liquidity_desk" | "stablecoin_fiat_conversion_desk" | "otc_counterparty";
type LpEvidenceType =
  | "mm_otc_licence" | "incountry_vasp_licence" | "beneficial_ownership_disclosure" | "sanctions_pep_attestation"
  | "audited_financials" | "aml_cft_policy" | "travel_rule_policy" | "mlro_appointment_letter"
  | "market_microstructure_policy" | "reference_list" | "insurance_certificate" | "regulatory_disciplinary_history";

const archetypeLabels: Record<LpArchetype, string> = {
  principal_market_maker: "Principal market maker",
  regional_liquidity_desk: "Regional liquidity desk",
  stablecoin_fiat_conversion_desk: "Stablecoin-fiat conversion desk",
  otc_counterparty: "OTC counterparty",
};

/** OM §5.4's 12-item liquidity-provider evidence pack, verbatim. */
const evidencePack: Array<{ type: LpEvidenceType; label: string }> = [
  { type: "mm_otc_licence", label: "Market-maker / OTC-desk licence (FinCEN MSB, FCA, MAS, etc.)" },
  { type: "incountry_vasp_licence", label: "In-country VASP-equivalent licence or partnership attestation" },
  { type: "beneficial_ownership_disclosure", label: "Beneficial-ownership disclosure to natural-person level (≥ 10%)" },
  { type: "sanctions_pep_attestation", label: "Sanctions & PEP screening attestation — entity + BOs" },
  { type: "audited_financials", label: "Two-year audited financials (or interim if new entity)" },
  { type: "aml_cft_policy", label: "AML/CFT policy document and officer attestation" },
  { type: "travel_rule_policy", label: "Travel-Rule supporting policy (if applicable)" },
  { type: "mlro_appointment_letter", label: "Anti-money-laundering officer (MLRO) appointment letter" },
  { type: "market_microstructure_policy", label: "Market-microstructure policy (last-look, throttling, reject rates)" },
  { type: "reference_list", label: "Reference list — three comparable principals" },
  { type: "insurance_certificate", label: "Insurance certificate (professional indemnity / E&O)" },
  { type: "regulatory_disciplinary_history", label: "Regulatory disciplinary history attestation (5 years)" },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">{label}</span>{children}</label>;
}

type WorkspaceData = {
  counterparty: { id: string; legalName: string; counterpartyType: string; jurisdiction: string; lpArchetype: LpArchetype | null; createdAt: Date };
  evidenceItems: Array<{ id: string; counterpartyId: string; evidenceType: LpEvidenceType; evidenceUri: string; note: string | null; recordedBy: string; recordedAt: Date }>;
  authorizations: Array<{ id: string; counterpartyId: string; legalName: string; regulator: string; licenceReference: string; scopeDescription: string; evidenceUri: string; validFrom: string; validTo: string | null; status: string; verifiedBy: string | null; verifiedAt: Date | null }>;
  onboarding: CounterpartyOnboardingRow | undefined;
  financialSoundnessDecisions: Array<{ id: string; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date; cycleNumber: number }>;
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

function OverviewTab({ workspace }: { workspace: WorkspaceData }) {
  const { counterparty, evidenceItems, authorizations, onboarding, financialSoundnessDecisions } = workspace;
  const documentedCount = evidencePack.filter(item => evidenceItems.some(row => row.evidenceType === item.type)).length;
  const verifiedLicence = authorizations.some(row => row.status === "verified");
  const g2 = financialSoundnessDecisions[0];
  const gates = ["G1 Licence & jurisdiction", "G2 Financial soundness", "G3 Quote & settlement validation", "G4 Go-live posture (90-day shadow)"];

  return <div className="grid gap-5 p-5">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryStat label="Archetype (OM §5.2)" value={counterparty.lpArchetype ? archetypeLabels[counterparty.lpArchetype] : "Not yet structured"} />
      <SummaryStat label="Jurisdiction" value={counterparty.jurisdiction} />
      <SummaryStat label="Evidence items present" value={`${documentedCount} / ${evidencePack.length} (OM §5.4)`} />
      <SummaryStat label="Lifecycle stage" value={onboarding ? onboarding.stage.replaceAll("_", " ") : "Not started"} />
    </div>
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">OM §5.6 gates — this codebase implements G1/G3/G4 generically (legal/technical/pilot) plus a dedicated G2</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="border border-black/10 p-3"><p className="text-xs font-black uppercase">{gates[0]}</p><p className="mt-1 text-sm">{verifiedLicence ? "Licence verified" : "No verified licence yet"} · stage {onboarding?.stage ?? "not started"}</p></div>
        <div className="border border-black/10 p-3"><p className="text-xs font-black uppercase">{gates[1]}</p><p className="mt-1 text-sm">{g2 ? (g2.decision === "approved" ? "Approved" : "Blocked") : "Not evaluated"}{!onboarding && " — requires an onboarding lifecycle first"}</p></div>
        <div className="border border-black/10 p-3"><p className="text-xs font-black uppercase">{gates[2]}</p><p className="mt-1 text-sm">Tracked via the generic technical-readiness gate — requires a verified active integration connection.</p></div>
        <div className="border border-black/10 p-3"><p className="text-xs font-black uppercase">{gates[3]}</p><p className="mt-1 text-sm">No 90-day shadow-window measurement exists in this build; the pilot gate records a decision only.</p></div>
      </div>
    </div>
    <p className="text-xs leading-5 text-black/55">Operational controls the OM specifies for a live LP relationship — concentration cap, spread-drift circuit-breaker, settlement-failure rate cap, kill-switch, per-LP credit exposure — have no representation in this system. This workspace only covers onboarding evidence and gates, not live routing controls.</p>
  </div>;
}

function ArchetypeAndLicensingTab({ workspace, canEdit }: { workspace: WorkspaceData; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const { counterparty, authorizations } = workspace;
  const [archetype, setArchetype] = useState<LpArchetype | "">(counterparty.lpArchetype ?? "");
  const updateArchetype = trpc.postgres.updateCounterpartyLpArchetype.useMutation({
    onSuccess: () => { toast.success("Archetype updated."); void utils.postgres.liquidityProviderWorkspace.invalidate(); void utils.postgres.liquidityProviders.invalidate(); },
    onError: error => toast.error(error.message),
  });

  return <div className="grid gap-6 p-5">
    {canEdit ? <div className="grid gap-3 border border-black/15 bg-black/[0.02] p-4 sm:grid-cols-[1fr_auto]">
      <Field label="Archetype (OM §5.2)">
        <select className="h-10 border border-black/25 bg-white px-2 text-sm" value={archetype} onChange={event => setArchetype(event.target.value as LpArchetype | "")}>
          <option value="">Not set</option>
          {(Object.entries(archetypeLabels) as [LpArchetype, string][]).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
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
  const [evidenceType, setEvidenceType] = useState<LpEvidenceType>("mm_otc_licence");
  const recordEvidence = trpc.postgres.recordCounterpartyEvidenceItem.useMutation({
    onSuccess: () => { toast.success("Evidence item recorded."); void utils.postgres.liquidityProviderWorkspace.invalidate(); void utils.postgres.liquidityProviders.invalidate(); },
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
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">OM §5.4 evidence checklist</p>
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
        <select className="h-10 border border-black/25 bg-white px-2 text-sm" value={evidenceType} onChange={event => setEvidenceType(event.target.value as LpEvidenceType)}>
          {evidencePack.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
        </select>
      </Field>
      <Field label="Evidence URL"><Input name="evidenceUri" type="url" required className="rounded-none" placeholder="https://…" /></Field>
      <Field label="Note (optional)"><Input name="note" className="rounded-none" /></Field>
      <Button type="submit" disabled={recordEvidence.isPending} className="w-fit rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{recordEvidence.isPending ? "Recording…" : "Record evidence"}</Button>
    </form>}
  </div>;
}

function GatesTab({ workspace, role }: { workspace: WorkspaceData; role: OperatorRole | undefined }) {
  const utils = trpc.useUtils();
  const { counterparty, onboarding, financialSoundnessDecisions } = workspace;
  const [rationale, setRationale] = useState("");
  const canDecideG2 = role === "admin" || role === "treasury_operator";

  const invalidate = async () => { await Promise.all([utils.postgres.liquidityProviderWorkspace.invalidate(), utils.postgres.counterpartyOnboardings.invalidate()]); };
  const createOnboarding = trpc.postgres.createCounterpartyOnboarding.useMutation({ onSuccess: () => { toast.success("Onboarding lifecycle started."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideLegal = trpc.postgres.decideCounterpartyOnboardingGate.useMutation({ onSuccess: () => { toast.success("Decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideTechnical = trpc.postgres.decideTechnicalOnboardingGate.useMutation({ onSuccess: () => { toast.success("Decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decidePilot = trpc.postgres.decideTreasuryPilotOnboardingGate.useMutation({ onSuccess: () => { toast.success("Decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });
  const beginRecertification = trpc.postgres.beginCounterpartyRecertification.useMutation({ onSuccess: () => { toast.success("Recertification cycle started."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideG2 = trpc.postgres.decideFinancialSoundnessGate.useMutation({
    onSuccess: () => { toast.success("Financial soundness decision recorded."); setRationale(""); void invalidate(); },
    onError: error => toast.error(error.message),
  });

  const submitG2 = (decision: "approved" | "blocked") => {
    if (!onboarding) return;
    if (rationale.trim().length < 10) { toast.error("A rationale of at least 10 characters is required."); return; }
    decideG2.mutate({ onboardingId: onboarding.id, decision, rationale: rationale.trim() });
  };

  return <div className="grid gap-6 p-5">
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Generic onboarding lifecycle (G1 legal, G3 technical, G4 pilot) — shared with every counterparty type</p>
      <div className="mt-2 border border-black/10">
        <CounterpartyOnboardingControls
          role={role}
          counterparties={[{ id: counterparty.id, legalName: counterparty.legalName, counterpartyType: counterparty.counterpartyType, jurisdiction: counterparty.jurisdiction }]}
          rows={onboarding ? [onboarding] : []}
          loading={false}
          createPending={createOnboarding.isPending}
          decisionPending={decideLegal.isPending || decideTechnical.isPending || decidePilot.isPending}
          recertificationPending={beginRecertification.isPending}
          error={createOnboarding.error?.message ?? decideLegal.error?.message ?? decideTechnical.error?.message ?? decidePilot.error?.message ?? beginRecertification.error?.message ?? null}
          create={createOnboarding.mutate}
          decideLegal={decideLegal.mutate}
          decideTechnical={decideTechnical.mutate}
          decidePilot={decidePilot.mutate}
          beginRecertification={beginRecertification.mutate}
        />
      </div>
    </div>

    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Gate G2 — financial soundness (OM §5.6, Treasury + Finance)</p>
      {!onboarding ? <p className="mt-2 text-sm text-black/55">Start the onboarding lifecycle above before recording a financial-soundness decision.</p> : canDecideG2 ? <div className="mt-2 grid gap-2 border border-black/15 bg-black/[0.02] p-3">
        <textarea value={rationale} onChange={event => setRationale(event.target.value)} minLength={10} placeholder="Decision rationale — audited financials, capital adequacy, insurance proof" className="min-h-[70px] border border-black/25 bg-white px-3 py-2 text-sm" />
        <div className="flex gap-2"><Button type="button" disabled={decideG2.isPending} onClick={() => submitG2("approved")} className="rounded-none bg-black text-xs font-black uppercase hover:bg-[#e11919]">Approve</Button><Button type="button" variant="outline" disabled={decideG2.isPending} onClick={() => submitG2("blocked")} className="rounded-none text-xs font-black uppercase">Block</Button></div>
        <p className="text-xs leading-5 text-black/55">This platform has no distinct Finance role; restricted to treasury/admin as the closest match to the OM's Treasury+Finance ownership. This decision is tracked independently and does not gate the generic lifecycle above.</p>
      </div> : <p className="mt-2 text-sm text-black/55">Recording this decision is a treasury action.</p>}
      {financialSoundnessDecisions.length > 0 && <div className="mt-3 grid gap-2">{financialSoundnessDecisions.map(decision => <div key={decision.id} className="border border-black/10 px-3 py-2 text-sm"><span className={`font-black uppercase ${decision.decision === "approved" ? "text-black" : "text-[#e11919]"}`}>{decision.decision}</span><span className="text-black/55"> · {decision.decidedBy} · {new Date(decision.decidedAt).toLocaleString()}</span><p className="mt-1 text-black/65">{decision.rationale}</p></div>)}</div>}
    </div>
  </div>;
}

function ActivityTab({ workspace }: { workspace: WorkspaceData }) {
  return <div className="grid gap-5 p-5">
    <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Activity (reconstructed from real timestamped rows)</p>
    {workspace.activity.length === 0 ? <p className="mt-2 text-sm text-black/55">No activity recorded yet.</p> : <div className="mt-2 divide-y divide-black/10">{workspace.activity.map(event => <div key={event.id} className="py-2 text-sm"><span className="font-bold">{event.action.replaceAll(/[._]/g, " ")}</span><span className="text-black/55"> · {event.actorSubject} · {new Date(event.occurredAt).toLocaleString()}</span></div>)}</div>}
    <div className="border-t border-black/10 pt-4">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Recertification (OM §5.9)</p>
      <p className="mt-2 text-sm text-black/55">Annual recert exists (see the lifecycle card above once at steady-state). Ad-hoc triggers the OM specifies — licence change, ownership change &gt;10%, sanctions action, settlement-failure incident, persistent spread widening, repeated SLA breach — are not monitored or scheduled anywhere in this build.</p>
    </div>
  </div>;
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return <div className="border border-black/10 p-3"><p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">{label}</p><p className="mt-1 text-sm font-bold">{value}</p></div>;
}

function LiquidityProviderDetail({ counterpartyId, onBack, role }: { counterpartyId: string; onBack: () => void; role: OperatorRole | undefined }) {
  const workspace = trpc.postgres.liquidityProviderWorkspace.useQuery({ counterpartyId });
  const canEdit = role === "admin" || role === "compliance_officer";
  if (workspace.isLoading) return <div className="px-5 py-10 text-sm text-black/55">Loading liquidity provider workspace…</div>;
  if (!workspace.data) return <div className="px-5 py-10 text-sm text-black/55">Counterparty record was not found.</div>;
  const { counterparty } = workspace.data;
  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/20 px-5 py-4">
      <div>
        <button type="button" onClick={onBack} className="text-xs font-bold uppercase tracking-wide text-black/50 hover:text-black">← Liquidity Providers</button>
        <h3 className="mt-1 text-xl font-black tracking-[-0.03em]">{counterparty.legalName}</h3>
        <p className="mt-1 text-xs text-black/55">{counterparty.jurisdiction} · fx liquidity provider</p>
      </div>
    </div>
    <Tabs defaultValue="overview">
      <TabsList className="mx-5 mt-4 h-auto flex-wrap justify-start gap-1 rounded-none bg-transparent p-0">
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="overview">Overview</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="licensing">Archetype &amp; Licensing</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="evidence">Evidence Pack</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="gates">Gates &amp; Decisions</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="overview"><OverviewTab workspace={workspace.data} /></TabsContent>
      <TabsContent value="licensing"><ArchetypeAndLicensingTab workspace={workspace.data} canEdit={canEdit} /></TabsContent>
      <TabsContent value="evidence"><EvidenceTab workspace={workspace.data} canEdit={canEdit} /></TabsContent>
      <TabsContent value="gates"><GatesTab workspace={workspace.data} role={role} /></TabsContent>
      <TabsContent value="activity"><ActivityTab workspace={workspace.data} /></TabsContent>
    </Tabs>
  </div>;
}

export function LiquidityProviderWorkspace({ role }: { role: OperatorRole | undefined }) {
  const providers = trpc.postgres.liquidityProviders.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const rows = providers.data ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(row => row.legalName.toLowerCase().includes(query) || row.jurisdiction.toLowerCase().includes(query));
  }, [providers.data, search]);

  if (role !== "admin" && role !== "compliance_officer" && role !== "auditor" && role !== "treasury_operator") {
    return <section className="uf-panel"><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Liquidity Providers</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.045em]">Liquidity Providers</h2></div><div className="px-5 py-8 text-sm text-black/55">This role has no access to liquidity provider records.</div></section>;
  }

  if (selectedId) {
    return <section className="uf-panel min-w-0"><LiquidityProviderDetail counterpartyId={selectedId} onBack={() => setSelectedId(null)} role={role} /></section>;
  }

  return <section className="uf-panel min-w-0">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-black/20 px-5 py-4">
      <div><p className="uf-kicker">OM §5 · Liquidity Providers &amp; Market Makers</p><h2 className="mt-1 text-lg font-black tracking-[-0.045em] uppercase">Liquidity Providers</h2></div>
    </div>
    <p className="border-b border-black/10 px-5 py-3 text-xs leading-5 text-black/55">New liquidity providers are recorded from the Counterparties &amp; Licences tab (type: fx liquidity provider). This workspace covers OM §5 archetype, evidence pack, and gate tracking for providers already registered.</p>
    <div className="border-b border-black/10 px-5 py-3">
      <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by legal name or jurisdiction" className="h-9 max-w-md rounded-none border-black/25" aria-label="Search liquidity providers" />
    </div>
    {providers.isLoading ? <div className="px-5 py-8 text-sm text-black/55">Loading liquidity providers…</div> : filtered.length === 0 ? <div className="px-5 py-10"><p className="text-sm font-bold">No liquidity providers recorded</p><p className="mt-2 max-w-xl text-sm leading-6 text-black/55">Register a counterparty of type "fx liquidity provider" from the Counterparties &amp; Licences tab to begin its OM §5 evidence trail.</p></div> : <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr className="border-b border-black/20 text-left text-[10px] font-black uppercase tracking-[0.12em] text-black/50"><th className="py-2 pl-5">Legal name</th><th className="py-2">Jurisdiction</th><th className="py-2">Archetype</th><th className="py-2">Evidence</th><th className="py-2">Recorded</th><th className="py-2 pr-5" /></tr></thead><tbody>{filtered.map(row => <tr key={row.id} className="border-b border-black/10 hover:bg-black/[0.02]"><td className="py-2 pl-5 font-bold">{row.legalName}</td><td className="py-2 text-black/65">{row.jurisdiction}</td><td className="py-2 text-black/65">{row.lpArchetype ? archetypeLabels[row.lpArchetype] : <span className="text-black/35">Not yet structured</span>}</td><td className="py-2 text-black/65">{row.evidenceCount}/12 items</td><td className="py-2 text-black/50">{new Date(row.createdAt).toLocaleDateString()}</td><td className="py-2 pr-5 text-right"><Button variant="outline" onClick={() => setSelectedId(row.id)} className="rounded-none text-[10px] font-black uppercase">Open</Button></td></tr>)}</tbody></table></div>}
  </section>;
}
