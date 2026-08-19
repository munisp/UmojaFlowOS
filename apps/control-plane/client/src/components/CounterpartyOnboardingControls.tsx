import { FormEvent, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorRole } from "@/lib/roleCapabilities";
import { SubmitFeedback, useRetryableSubmit, useSubmitFeedback } from "@/components/SubmitFeedback";

type Corridor = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";
type Stage = "legal_onboarding" | "technical_readiness" | "pilot" | "steady_state" | "recertification_due" | "blocked";
type Gate = "legal" | "technical" | "pilot";
type Decision = "approved" | "blocked";

export type CounterpartyOnboardingRow = {
  id: string;
  counterpartyId: string;
  legalName: string;
  counterpartyType: string;
  jurisdiction: string;
  countryOverlays: Corridor[];
  stage: Stage;
  cycleNumber: number;
  legalEvidenceUri: string;
  technicalEvidenceUri: string | null;
  pilotEvidenceUri: string | null;
  recertificationDueAt: Date | null;
  currentReason: string | null;
  decisions: Array<{ gate: Gate; decision: Decision; decidedBy: string; decidedRole: OperatorRole; decidedAt: Date }>;
};

type Counterparty = { id: string; legalName: string; counterpartyType: string; jurisdiction: string };

type Props = {
  role: OperatorRole | undefined;
  counterparties: Counterparty[];
  rows: CounterpartyOnboardingRow[];
  loading: boolean;
  createPending: boolean;
  decisionPending: boolean;
  recertificationPending: boolean;
  error: string | null;
  create: (input: { counterpartyId: string; countryOverlays: Corridor[]; legalEvidenceUri: string; recertificationDueAt: Date }) => void;
  decideLegal: (input: { onboardingId: string; gate: "legal" | "pilot"; decision: Decision; evidenceUri: string; rationale: string }) => void;
  decideTechnical: (input: { onboardingId: string; decision: Decision; evidenceUri: string; rationale: string }) => void;
  decidePilot: (input: { onboardingId: string; decision: Decision; evidenceUri: string; rationale: string }) => void;
  beginRecertification: (input: { onboardingId: string; legalEvidenceUri: string; recertificationDueAt: Date }) => void;
};

const stageLabel: Record<Stage, string> = {
  legal_onboarding: "Legal review",
  technical_readiness: "Technical readiness",
  pilot: "Pilot approval",
  steady_state: "Steady state",
  recertification_due: "Recertification due",
  blocked: "Blocked",
};

const corridorLabel: Record<Corridor, string> = {
  NIGERIA_NGN: "Nigeria (NGN)",
  KENYA_KES: "Kenya (KES)",
  SOUTH_AFRICA_ZAR: "South Africa (ZAR)",
};

function gateForStage(stage: Stage): Gate | null {
  if (stage === "legal_onboarding") return "legal";
  if (stage === "technical_readiness") return "technical";
  if (stage === "pilot") return "pilot";
  return null;
}

function mayDecide(role: OperatorRole | undefined, gate: Gate | null) {
  if (!gate) return false;
  if (gate === "legal") return role === "compliance_officer";
  if (gate === "technical") return role === "admin";
  return role === "compliance_officer" || role === "treasury_operator";
}

function Status({ stage }: { stage: Stage }) {
  const danger = stage === "blocked";
  const ready = stage === "steady_state";
  return <Badge className={`${danger ? "bg-[#e11919] text-white" : ready ? "bg-black text-white" : "bg-black/5 text-black"} rounded-none border-0 text-[10px] font-black uppercase tracking-wide`}>{stageLabel[stage]}</Badge>;
}

export function CounterpartyOnboardingControls({ role, counterparties, rows, loading, createPending, decisionPending, recertificationPending, error, create, decideLegal, decideTechnical, decidePilot, beginRecertification }: Props) {
  const unstarted = useMemo(() => counterparties.filter(counterparty => !rows.some(row => row.counterpartyId === counterparty.id)), [counterparties, rows]);
  const [counterpartyId, setCounterpartyId] = useState("");
  const [overlays, setOverlays] = useState<Corridor[]>(["NIGERIA_NGN"]);
  const [selectedId, setSelectedId] = useState("");
  const selected = rows.find(row => row.id === selectedId) ?? rows[0];
  const { run: retryCreate, retry: retryCreateSubmission, hasAttempt: hasCreateAttempt } = useRetryableSubmit(create);
  const createFeedback = useSubmitFeedback(createPending, error);

  const toggleOverlay = (overlay: Corridor) => setOverlays(current => current.includes(overlay) ? current.filter(value => value !== overlay) : [...current, overlay]);
  const selectedGate = selected ? gateForStage(selected.stage) : null;

  return <div className="grid gap-5">
    <div className="border-b border-black/15 px-5 py-4 text-sm leading-6 text-black/65">
      This lifecycle records **legal review → technical readiness → pilot → steady state**. It never activates a provider, moves money, or treats a pilot as a live payment rail.
    </div>

    {role === "admin" ? <form className="grid gap-4 border-b border-black/15 px-5 py-5" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const target = counterpartyId || unstarted[0]?.id;
      if (!target) return;
      retryCreate({ counterpartyId: target, countryOverlays: overlays, legalEvidenceUri: String(form.get("legalEvidenceUri")), recertificationDueAt: new Date(String(form.get("recertificationDueAt"))) });
    }}>
      <div><p className="text-sm font-black uppercase tracking-[-0.02em]">Start governed onboarding</p><p className="mt-1 text-xs leading-5 text-black/55">A registered counterparty, country overlays, legal evidence, and a future recertification date are required. This creates a record only.</p></div>
      {unstarted.length ? <><Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Counterparty</span><Select value={counterpartyId || unstarted[0]?.id} onValueChange={setCounterpartyId}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{unstarted.map(counterparty => <SelectItem key={counterparty.id} value={counterparty.id}>{counterparty.legalName} / {counterparty.counterpartyType.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></Label>
      <fieldset className="grid gap-2"><legend className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Country overlays</legend><div className="flex flex-wrap gap-3">{(Object.keys(corridorLabel) as Corridor[]).map(overlay => <Label key={overlay} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overlays.includes(overlay)} onChange={() => toggleOverlay(overlay)} />{corridorLabel[overlay]}</Label>)}</div></fieldset>
      <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Legal evidence URL</span><Input name="legalEvidenceUri" type="url" required className="rounded-none" placeholder="https://…" /></Label>
      <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Next recertification due</span><Input name="recertificationDueAt" type="datetime-local" required className="rounded-none" /></Label>
      <SubmitFeedback state={createFeedback} onRetry={hasCreateAttempt ? retryCreateSubmission : undefined} />
      <Button type="submit" disabled={createPending || overlays.length === 0 || overlays.length > 3} className="w-fit rounded-none bg-black text-white hover:bg-black/80">{createPending ? "Recording…" : "Start legal review"}</Button></> : <p className="text-sm text-black/55">Every registered counterparty already has an onboarding lifecycle.</p>}
    </form> : <div className="border-b border-black/15 px-5 py-4 text-sm leading-6 text-black/55">Only administrators can start a counterparty lifecycle. Compliance, treasury, and audit roles can review their assigned evidence and decisions below.</div>}

    {loading ? <p className="px-5 py-8 text-sm text-black/55">Loading recorded onboarding lifecycles…</p> : rows.length === 0 ? <p className="px-5 py-8 text-sm text-black/55">No counterparty onboarding lifecycle is recorded. This does not mean any provider is ready or connected.</p> : <div className="grid gap-4 px-5 pb-5 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="grid gap-2">{rows.map(row => <button type="button" key={row.id} onClick={() => setSelectedId(row.id)} className={`${selected?.id === row.id ? "border-black bg-black text-white" : "border-black/20 bg-white text-black"} grid gap-2 border p-4 text-left transition-colors`}><div className="flex items-center justify-between gap-3"><span className="font-bold">{row.legalName}</span><Status stage={row.stage} /></div><span className="text-xs opacity-70">Cycle {row.cycleNumber} · {row.countryOverlays.map(value => corridorLabel[value]).join(", ")}</span></button>)}</div>
      {selected ? <div className="border border-black/20 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xl font-black tracking-[-0.04em]">{selected.legalName}</p><p className="mt-1 text-sm text-black/55">{selected.counterpartyType.replaceAll("_", " ")} · {selected.jurisdiction}</p></div><Status stage={selected.stage} /></div><div className="mt-5 grid gap-2 text-sm"><p><span className="font-bold">Cycle:</span> {selected.cycleNumber}</p><p><span className="font-bold">Country overlays:</span> {selected.countryOverlays.map(value => corridorLabel[value]).join(", ")}</p><p><span className="font-bold">Current note:</span> {selected.currentReason ?? "No decision note recorded."}</p><p><span className="font-bold">Recorded decisions:</span> {selected.decisions.length}</p></div>
        {mayDecide(role, selectedGate) ? <GateDecisionForm row={selected} role={role} pending={decisionPending} error={error} decideLegal={decideLegal} decideTechnical={decideTechnical} decidePilot={decidePilot} /> : null}
        {selected.stage === "steady_state" && (role === "compliance_officer" || role === "admin") ? <RecertificationForm onboardingId={selected.id} pending={recertificationPending} error={error} begin={beginRecertification} /> : null}
        <p className="mt-5 border-t border-black/15 pt-4 text-xs leading-5 text-black/55">A steady-state lifecycle is a governance record, not an activation. The integration control still requires a deployment secret reference and passed health check; payment execution still requires its own policy and provider-finality evidence.</p>
      </div> : null}
    </div>}
  </div>;
}

function GateDecisionForm({ row, role, pending, error, decideLegal, decideTechnical, decidePilot }: { row: CounterpartyOnboardingRow; role: OperatorRole | undefined; pending: boolean; error: string | null; decideLegal: Props["decideLegal"]; decideTechnical: Props["decideTechnical"]; decidePilot: Props["decidePilot"] }) {
  const gate = gateForStage(row.stage);
  const [decision, setDecision] = useState<Decision>("approved");
  const feedback = useSubmitFeedback(pending, error);
  if (!gate) return null;
  return <form className="mt-5 grid gap-3 border-t border-black/15 pt-5" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const input = { onboardingId: row.id, decision, evidenceUri: String(data.get("evidenceUri")), rationale: String(data.get("rationale")) }; if (gate === "technical") decideTechnical(input); else if (gate === "pilot" && role === "treasury_operator") decidePilot(input); else decideLegal({ ...input, gate }); }}>
    <div><p className="text-sm font-black uppercase tracking-[-0.02em]">{stageLabel[row.stage]} decision</p><p className="mt-1 text-xs text-black/55">Your decision is immutable. A blocked decision records the reason and ends this cycle; it does not silently activate an alternative route.</p></div>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Decision</span><Select value={decision} onValueChange={value => setDecision(value as Decision)}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="approved">Approve gate</SelectItem><SelectItem value="blocked">Block cycle</SelectItem></SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Evidence URL</span><Input name="evidenceUri" required type="url" className="rounded-none" placeholder="https://…" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Decision rationale</span><Textarea name="rationale" required minLength={10} className="min-h-24 rounded-none border-black/25" /></Label>
    <SubmitFeedback state={feedback} />
    <Button type="submit" disabled={pending} className="w-fit rounded-none bg-black text-white hover:bg-black/80">{pending ? "Recording…" : "Record independent decision"}</Button>
  </form>;
}

function RecertificationForm({ onboardingId, pending, error, begin }: { onboardingId: string; pending: boolean; error: string | null; begin: Props["beginRecertification"] }) {
  const feedback = useSubmitFeedback(pending, error);
  return <form className="mt-5 grid gap-3 border-t border-black/15 pt-5" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); begin({ onboardingId, legalEvidenceUri: String(data.get("legalEvidenceUri")), recertificationDueAt: new Date(String(data.get("recertificationDueAt"))) }); }}>
    <p className="text-sm font-black uppercase tracking-[-0.02em]">Begin due recertification</p>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">New legal evidence URL</span><Input name="legalEvidenceUri" type="url" required className="rounded-none" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Next due date</span><Input name="recertificationDueAt" type="datetime-local" required className="rounded-none" /></Label>
    <SubmitFeedback state={feedback} />
    <Button type="submit" disabled={pending} className="w-fit rounded-none bg-black text-white hover:bg-black/80">{pending ? "Starting…" : "Restart legal review"}</Button>
  </form>;
}
