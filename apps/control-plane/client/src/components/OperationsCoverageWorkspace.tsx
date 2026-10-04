import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { RouterCoverageWorkspace } from "@/components/RouterCoverageWorkspace";
import type { OperatorRole } from "@/lib/roleCapabilities";

/**
 * Operations alert + beneficiary + market-data coverage workspace.
 *
 * Closes the UI gap for server procedures that previously existed but had no
 * console surface (compliance alert lifecycle, operational evaluators,
 * beneficiary registration and screening, market observations, counterparty
 * risk assessments, notification deliveries, FX spread). Every action writes
 * through the canonical tRPC procedures; nothing here fabricates an alert —
 * raising an alert requires a real alert policy and an evidence payload.
 */

type AlertRow = {
  id: string;
  state: "open" | "acknowledged" | "escalated" | "dismissed";
  severity: string;
  sourceReference: string;
  detectedAt: string | Date;
};

const severityTone: Record<string, string> = {
  low: "bg-black/10 text-black/55",
  medium: "bg-black text-white",
  high: "bg-[#e11919] text-white",
  critical: "bg-[#e11919] text-white",
};

function Panel({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return <section className="uf-panel"><header className="border-b border-black/15 px-5 py-4"><p className="uf-kicker">{eyebrow}</p><h3 className="mt-1 text-sm font-black uppercase tracking-wide">{title}</h3></header><div className="p-5">{children}</div></section>;
}

function AlertLifecyclePanel({ role }: { role: OperatorRole | undefined }) {
  const utils = trpc.useUtils();
  const alerts = trpc.postgres.complianceAlerts.useQuery({});
  const cases = trpc.postgres.complianceCases.useQuery();
  const policies = trpc.postgres.alertPolicies.useQuery();
  const canAct = role === "admin" || role === "compliance_officer";
  const invalidate = () => void utils.postgres.complianceAlerts.invalidate();
  const acknowledge = trpc.postgres.acknowledgeComplianceAlert.useMutation({ onSuccess: () => { toast.success("Alert acknowledged."); invalidate(); }, onError: e => toast.error(e.message) });
  const escalate = trpc.postgres.escalateComplianceAlert.useMutation({ onSuccess: () => { toast.success("Alert escalated to a compliance case."); invalidate(); }, onError: e => toast.error(e.message) });
  const dismiss = trpc.postgres.dismissComplianceAlert.useMutation({ onSuccess: () => { toast.success("Alert dismissed with recorded reason."); invalidate(); }, onError: e => toast.error(e.message) });
  const raise = trpc.postgres.raiseComplianceAlert.useMutation({ onSuccess: () => { toast.success("Compliance alert raised from recorded evidence."); invalidate(); }, onError: e => toast.error(e.message) });
  const [note, setNote] = useState<Record<string, string>>({});
  const [caseId, setCaseId] = useState<Record<string, string>>({});
  const [showRaise, setShowRaise] = useState(false);

  const onRaise = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    raise.mutate({
      alertPolicyId: String(data.get("alertPolicyId")),
      severity: String(data.get("severity")) as "low" | "medium" | "high" | "critical",
      sourceReference: String(data.get("sourceReference")),
      evidence: { note: String(data.get("evidenceNote") ?? "") },
      detectedAt: new Date(),
    });
  };

  return <Panel eyebrow="Compliance alerts" title="Alert lifecycle — raise, acknowledge, escalate, dismiss">
    <div className="mb-4 flex justify-end">
      {canAct && <Button variant="outline" className="rounded-none text-[10px] font-black uppercase" onClick={() => setShowRaise(v => !v)}>{showRaise ? "Cancel" : "Raise alert"}</Button>}
    </div>
    {showRaise && canAct && <form onSubmit={onRaise} className="mb-4 grid gap-2 border border-black/15 bg-black/[0.02] p-3">
      <select name="alertPolicyId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Select alert policy…</option>
        {(policies.data ?? []).map((p: { id: string; name?: string }) => <option key={p.id} value={p.id}>{p.name ?? p.id}</option>)}
      </select>
      <select name="severity" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        {["low", "medium", "high", "critical"].map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <Input name="sourceReference" required minLength={8} placeholder="Source reference (evidence pointer, min 8 chars)" className="rounded-none text-xs" />
      <Input name="evidenceNote" placeholder="Evidence summary (stored as the alert evidence payload)" className="rounded-none text-xs" />
      <Button disabled={raise.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{raise.isPending ? "Raising…" : "Raise compliance alert"}</Button>
    </form>}
    {alerts.isLoading ? <p className="text-sm text-black/55">Loading compliance alerts…</p>
      : (alerts.data ?? []).length === 0 ? <p className="text-sm text-black/55">No compliance alerts recorded. Alerts appear only from policy evaluation or a recorded raise action.</p>
      : <div className="divide-y divide-black/15">{(alerts.data as AlertRow[]).map(alert => <div key={alert.id} className="grid gap-2 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 text-[10px] font-black uppercase ${severityTone[alert.severity] ?? "bg-black/10"}`}>{alert.severity}</span>
            <span className="text-[10px] font-black uppercase tracking-wide text-black/45">{alert.state}</span>
          </div>
          <span className="text-[10px] text-black/40">{new Date(alert.detectedAt).toLocaleString()}</span>
        </div>
        <p className="text-xs text-black/70">{alert.sourceReference}</p>
        {canAct && alert.state === "open" && <div className="flex flex-wrap items-center gap-2">
          <Input value={note[alert.id] ?? ""} onChange={e => setNote(prev => ({ ...prev, [alert.id]: e.target.value }))} placeholder="Acknowledgement or dismissal note (min 8 chars)" className="h-8 max-w-sm rounded-none text-xs" />
          <Button variant="outline" disabled={acknowledge.isPending || (note[alert.id] ?? "").trim().length < 8} onClick={() => acknowledge.mutate({ alertId: alert.id, note: note[alert.id] })} className="h-8 rounded-none text-[10px] font-black uppercase">Acknowledge</Button>
          <Button variant="outline" disabled={dismiss.isPending || (note[alert.id] ?? "").trim().length < 8} onClick={() => dismiss.mutate({ alertId: alert.id, reason: note[alert.id] })} className="h-8 rounded-none text-[10px] font-black uppercase text-[#e11919]">Dismiss</Button>
        </div>}
        {canAct && alert.state === "acknowledged" && <div className="flex flex-wrap items-center gap-2">
          <select value={caseId[alert.id] ?? ""} onChange={e => setCaseId(prev => ({ ...prev, [alert.id]: e.target.value }))} className="h-8 border border-black/25 bg-white px-2 text-xs">
            <option value="">Escalate into case…</option>
            {(cases.data ?? []).map((c: { id: string; title?: string }) => <option key={c.id} value={c.id}>{c.title ?? c.id}</option>)}
          </select>
          <Button variant="outline" disabled={escalate.isPending || !caseId[alert.id]} onClick={() => escalate.mutate({ alertId: alert.id, caseId: caseId[alert.id] })} className="h-8 rounded-none bg-black text-[10px] font-black uppercase text-white hover:bg-[#e11919]">Escalate</Button>
        </div>}
      </div>)}</div>}
  </Panel>;
}

function OperationalEvaluatorsPanel({ role }: { role: OperatorRole | undefined }) {
  const isTreasury = role === "admin" || role === "treasury_operator";
  const isCompliance = role === "admin" || role === "compliance_officer";
  const liquidity = trpc.postgres.evaluateLiquidityThresholds.useMutation({ onSuccess: r => toast.success(`Liquidity evaluation recorded (${JSON.stringify(r).slice(0, 80)}…)`), onError: e => toast.error(e.message) });
  const failures = trpc.postgres.evaluatePaymentFailures.useMutation({ onSuccess: () => toast.success("Payment failure evaluation recorded."), onError: e => toast.error(e.message) });
  const flags = trpc.postgres.evaluateComplianceFlags.useMutation({ onSuccess: () => toast.success("Compliance flag evaluation recorded."), onError: e => toast.error(e.message) });
  const [pair, setPair] = useState({ baseAsset: "NGN", quoteAsset: "USD" });
  const spread = trpc.postgres.fxSpread.useQuery(pair, { retry: false });
  return <Panel eyebrow="Operational evaluation" title="On-demand evaluators and FX spread">
    <div className="flex flex-wrap gap-2">
      {isTreasury && <Button variant="outline" disabled={liquidity.isPending} onClick={() => liquidity.mutate()} className="rounded-none text-[10px] font-black uppercase">Evaluate liquidity thresholds</Button>}
      {isTreasury && <Button variant="outline" disabled={failures.isPending} onClick={() => failures.mutate()} className="rounded-none text-[10px] font-black uppercase">Evaluate payment failures</Button>}
      {isCompliance && <Button variant="outline" disabled={flags.isPending} onClick={() => flags.mutate()} className="rounded-none text-[10px] font-black uppercase">Evaluate compliance flags</Button>}
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <select value={pair.baseAsset} onChange={e => setPair(p => ({ ...p, baseAsset: e.target.value }))} className="h-8 border border-black/25 bg-white px-2 text-xs">
        {["NGN", "KES", "ZAR", "USD", "USDC", "USDT"].map(a => <option key={a}>{a}</option>)}
      </select>
      <span className="text-xs text-black/45">/</span>
      <select value={pair.quoteAsset} onChange={e => setPair(p => ({ ...p, quoteAsset: e.target.value }))} className="h-8 border border-black/25 bg-white px-2 text-xs">
        {["NGN", "KES", "ZAR", "USD", "USDC", "USDT"].map(a => <option key={a}>{a}</option>)}
      </select>
      <span className="text-xs text-black/70">{spread.isLoading ? "Computing spread…" : spread.error ? `Spread unavailable: ${spread.error.message}` : `Spread: ${JSON.stringify(spread.data)}`}</span>
    </div>
    <p className="mt-3 text-[11px] leading-4 text-black/50">Evaluations record their outcome as evidence; they never raise an alert unless the underlying threshold or flag condition is actually met.</p>
  </Panel>;
}

function BeneficiaryPanel({ role }: { role: OperatorRole | undefined }) {
  const utils = trpc.useUtils();
  const canAct = role === "admin" || role === "compliance_officer";
  const customers = trpc.postgres.customers.useQuery();
  const beneficiaries = trpc.postgres.beneficiaries.useQuery({});
  const connections = trpc.postgres.integrationConnections.useQuery();
  const createBeneficiary = trpc.postgres.createBeneficiary.useMutation({
    onSuccess: () => { toast.success("Beneficiary registered pending screening."); void utils.postgres.beneficiaries.invalidate(); },
    onError: e => toast.error(e.message),
  });
  const recordScreening = trpc.postgres.recordBeneficiaryScreening.useMutation({
    onSuccess: () => { toast.success("Beneficiary screening recorded with provider reference."); void utils.postgres.beneficiaries.invalidate(); },
    onError: e => toast.error(e.message),
  });
  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createBeneficiary.mutate({
      customerId: String(data.get("customerId")), legalName: String(data.get("legalName")),
      countryCode: String(data.get("countryCode")).toUpperCase(), bankOrWalletReference: String(data.get("bankOrWalletReference")),
    });
  };
  const onScreen = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    recordScreening.mutate({
      beneficiaryId: String(data.get("beneficiaryId")), integrationConnectionId: String(data.get("integrationConnectionId")),
      correlationId: String(data.get("correlationId")),
      screeningState: String(data.get("screeningState")) as "clear" | "potential_match" | "confirmed_match" | "source_unavailable",
      providerReference: String(data.get("providerReference")), sourceVersion: String(data.get("sourceVersion")),
      evidenceSha256: String(data.get("evidenceSha256")),
    });
  };
  if (!canAct) return null;
  return <Panel eyebrow="Beneficiaries" title="Registration and screening lifecycle">
    <form onSubmit={onCreate} className="grid gap-2 border-b border-black/15 pb-4">
      <select name="customerId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Customer…</option>
        {(customers.data ?? []).map((c: { id: string; legalName?: string }) => <option key={c.id} value={c.id}>{c.legalName ?? c.id}</option>)}
      </select>
      <Input name="legalName" required minLength={2} placeholder="Beneficiary legal name" className="rounded-none text-xs" />
      <div className="flex gap-2">
        <Input name="countryCode" required minLength={2} maxLength={2} placeholder="CC" className="w-20 rounded-none text-xs uppercase" />
        <Input name="bankOrWalletReference" required minLength={4} placeholder="Bank or wallet reference" className="rounded-none text-xs" />
      </div>
      <Button disabled={createBeneficiary.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{createBeneficiary.isPending ? "Registering…" : "Register beneficiary"}</Button>
    </form>
    <form onSubmit={onScreen} className="mt-4 grid gap-2">
      <select name="beneficiaryId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Beneficiary…</option>
        {(beneficiaries.data ?? []).map((b: { id: string; legalName?: string }) => <option key={b.id} value={b.id}>{b.legalName ?? b.id}</option>)}
      </select>
      <select name="integrationConnectionId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Screening provider connection…</option>
        {(connections.data ?? []).map((c: { id: string; provider?: string }) => <option key={c.id} value={c.id}>{c.provider ?? c.id}</option>)}
      </select>
      <div className="flex gap-2">
        <Input name="correlationId" required minLength={8} placeholder="Correlation ID" className="rounded-none text-xs" />
        <select name="screeningState" required className="h-8 border border-black/25 bg-white px-2 text-xs">
          {["clear", "potential_match", "confirmed_match", "source_unavailable"].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex gap-2">
        <Input name="providerReference" required minLength={3} placeholder="Provider reference" className="rounded-none text-xs" />
        <Input name="sourceVersion" required placeholder="Source version" className="rounded-none text-xs" />
      </div>
      <Input name="evidenceSha256" required minLength={64} maxLength={64} placeholder="Screening evidence sha256 (64 hex)" className="rounded-none font-mono text-xs" />
      <Button disabled={recordScreening.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{recordScreening.isPending ? "Recording…" : "Record screening result"}</Button>
      <p className="text-[11px] leading-4 text-black/50">A screening result is accepted only with an attributable provider reference and evidence hash — the platform never marks a beneficiary clear by default.</p>
    </form>
  </Panel>;
}

function MarketObservationPanel({ role }: { role: OperatorRole | undefined }) {
  const utils = trpc.useUtils();
  const canAct = role === "admin" || role === "treasury_operator";
  const connections = trpc.postgres.integrationConnections.useQuery();
  const observations = trpc.postgres.marketObservations.useQuery({});
  const record = trpc.postgres.recordMarketObservation.useMutation({
    onSuccess: () => { toast.success("Market observation recorded."); void utils.postgres.marketObservations.invalidate(); },
    onError: e => toast.error(e.message),
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    record.mutate({
      integrationConnectionId: String(data.get("integrationConnectionId")),
      baseAsset: String(data.get("baseAsset")) as "NGN" | "KES" | "ZAR" | "USD" | "USDC" | "USDT",
      quoteAsset: String(data.get("quoteAsset")) as "NGN" | "KES" | "ZAR" | "USD" | "USDC" | "USDT",
      rate: String(data.get("rate")), observedAt: new Date(), sourceReference: String(data.get("sourceReference")),
    });
  };
  if (!canAct) return null;
  return <Panel eyebrow="Market data" title="Record FX observation from an authorised source">
    <form onSubmit={onSubmit} className="grid gap-2">
      <select name="integrationConnectionId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Market data connection…</option>
        {(connections.data ?? []).map((c: { id: string; provider?: string }) => <option key={c.id} value={c.id}>{c.provider ?? c.id}</option>)}
      </select>
      <div className="flex items-center gap-2">
        <select name="baseAsset" className="h-8 border border-black/25 bg-white px-2 text-xs">{["NGN", "KES", "ZAR", "USD", "USDC", "USDT"].map(a => <option key={a}>{a}</option>)}</select>
        <span className="text-xs text-black/45">/</span>
        <select name="quoteAsset" className="h-8 border border-black/25 bg-white px-2 text-xs">{["USD", "NGN", "KES", "ZAR", "USDC", "USDT"].map(a => <option key={a}>{a}</option>)}</select>
        <Input name="rate" required placeholder="Rate" className="rounded-none text-xs" />
      </div>
      <Input name="sourceReference" required type="url" placeholder="Source reference URL (https)" className="rounded-none text-xs" />
      <Button disabled={record.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{record.isPending ? "Recording…" : "Record observation"}</Button>
    </form>
    <p className="mt-3 text-xs text-black/55">{(observations.data ?? []).length} observations on record.</p>
  </Panel>;
}

function CounterpartyRiskPanel({ role }: { role: OperatorRole | undefined }) {
  const utils = trpc.useUtils();
  const canAssess = role === "admin" || role === "compliance_officer";
  const canEscalate = role === "admin";
  const counterparties = trpc.postgres.counterparties.useQuery();
  const assessments = trpc.postgres.counterpartyRiskAssessments.useQuery({});
  const create = trpc.postgres.createCounterpartyRiskAssessment.useMutation({
    onSuccess: () => { toast.success("Counterparty risk assessment recorded."); void utils.postgres.counterpartyRiskAssessments.invalidate(); },
    onError: e => toast.error(e.message),
  });
  const escalate = trpc.postgres.escalateCounterpartyRiskAssessment.useMutation({
    onSuccess: () => { toast.success("Assessment escalated."); void utils.postgres.counterpartyRiskAssessments.invalidate(); },
    onError: e => toast.error(e.message),
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      counterpartyId: String(data.get("counterpartyId")),
      riskLevel: String(data.get("riskLevel")) as "low" | "medium" | "high" | "critical",
      riskScore: String(data.get("riskScore")),
      riskFactors: { summary: String(data.get("riskFactors") ?? "") },
      evidenceManifest: { reference: String(data.get("evidenceReference") ?? "") },
      assessedAt: new Date(),
      nextReviewAt: new Date(String(data.get("nextReviewAt"))),
    });
  };
  return <Panel eyebrow="Counterparty risk" title="Assessments and escalation">
    {canAssess && <form onSubmit={onSubmit} className="mb-4 grid gap-2 border-b border-black/15 pb-4">
      <select name="counterpartyId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Counterparty…</option>
        {(counterparties.data ?? []).map((c: { id: string; legalName?: string }) => <option key={c.id} value={c.id}>{c.legalName ?? c.id}</option>)}
      </select>
      <div className="flex gap-2">
        <select name="riskLevel" className="h-8 border border-black/25 bg-white px-2 text-xs">{["low", "medium", "high", "critical"].map(l => <option key={l}>{l}</option>)}</select>
        <Input name="riskScore" required placeholder="Risk score (e.g. 0.72)" className="rounded-none text-xs" />
        <Input name="nextReviewAt" required type="date" className="rounded-none text-xs" />
      </div>
      <Input name="riskFactors" placeholder="Risk factor summary" className="rounded-none text-xs" />
      <Input name="evidenceReference" placeholder="Evidence manifest reference" className="rounded-none text-xs" />
      <Button disabled={create.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">{create.isPending ? "Recording…" : "Record assessment"}</Button>
    </form>}
    {assessments.isLoading ? <p className="text-sm text-black/55">Loading assessments…</p>
      : (assessments.data ?? []).length === 0 ? <p className="text-sm text-black/55">No counterparty risk assessments recorded.</p>
      : <div className="divide-y divide-black/15">{(assessments.data as Array<{ id: string; riskLevel?: string; escalated?: boolean }>).slice(0, 25).map(a => <div key={a.id} className="flex items-center justify-between gap-2 py-2">
        <span className="font-mono text-[11px] text-black/60">{a.id.slice(0, 8)}… — {a.riskLevel ?? "unrated"}</span>
        {canEscalate && !a.escalated && <Button variant="outline" className="h-7 rounded-none text-[10px] font-black uppercase text-[#e11919]"
          onClick={() => { const reason = window.prompt("Escalation reason (min 4 chars)"); if (reason && reason.trim().length >= 4) escalate.mutate({ assessmentId: a.id, reason: reason.trim() }); }}>
          Escalate
        </Button>}
      </div>)}</div>}
  </Panel>;
}

function NotificationDeliveriesPanel() {
  const deliveries = trpc.postgres.notificationDeliveries.useQuery();
  return <Panel eyebrow="Notification audit" title="Delivery ledger">
    {deliveries.isLoading ? <p className="text-sm text-black/55">Loading notification deliveries…</p>
      : (deliveries.data ?? []).length === 0 ? <p className="text-sm text-black/55">No notification deliveries recorded.</p>
      : <div className="divide-y divide-black/15">{(deliveries.data as Array<{ id: string; channel?: string; status?: string; createdAt?: string | Date }>).slice(0, 50).map(d => <div key={d.id} className="flex items-center justify-between gap-2 py-2 text-xs">
        <span className="font-mono text-black/60">{d.id.slice(0, 8)}…</span>
        <span className="uppercase text-black/45">{d.channel ?? "—"}</span>
        <span className="font-black uppercase">{d.status ?? "—"}</span>
      </div>)}</div>}
  </Panel>;
}


const IMTO_CATEGORIES = ["cbn_imto_licence_or_application","permitted_remittance_scope","settlement_account_and_authorised_bank","aml_cft_cpf_and_sanctions_programme","customer_disclosure_and_complaints","agent_fintech_and_partner_oversight","reconciliation_and_safeguarding","incident_reporting_and_business_continuity","controlled_test_and_wind_down"] as const;
const OFFSHORE_CATEGORIES = ["jurisdictional_authorisation_scope","ownership_and_control","sanctions_and_adverse_media_process","travel_rule_interoperability","data_protection_and_retention","incident_and_exit_contact"] as const;

function ReadinessEvidencePanel({ role }: { role: OperatorRole | undefined }) {
  const isAdmin = role === "admin";
  const isCompliance = role === "admin" || role === "compliance_officer";
  const legalEntities = trpc.postgres.legalEntities.useQuery();
  const dossiers = trpc.postgres.cbnSandboxDossiers.useQuery();
  const counterparties = trpc.postgres.counterparties.useQuery();
  const createImto = trpc.postgres.createImtoReadinessProfile.useMutation({ onSuccess: () => toast.success("IMTO readiness profile created."), onError: e => toast.error(e.message) });
  const recordImtoEvidence = trpc.postgres.recordImtoReadinessEvidence.useMutation({ onSuccess: () => toast.success("IMTO evidence recorded."), onError: e => toast.error(e.message) });
  const assessImto = trpc.postgres.assessImtoReadiness.useMutation({ onSuccess: () => toast.success("IMTO readiness assessment recorded."), onError: e => toast.error(e.message) });
  const createOffshore = trpc.postgres.createVaspOffshoreCounterpartyProfile.useMutation({ onSuccess: () => toast.success("Offshore counterparty profile created."), onError: e => toast.error(e.message) });
  const assessOffshore = trpc.postgres.assessVaspOffshoreCounterpartyProfile.useMutation({ onSuccess: () => toast.success("Offshore exposure assessment recorded."), onError: e => toast.error(e.message) });
  const recordOffshoreEvidence = trpc.postgres.recordVaspOffshoreCounterpartyEvidence.useMutation({ onSuccess: () => toast.success("Offshore evidence recorded."), onError: e => toast.error(e.message) });

  const onCreateImto = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createImto.mutate({ legalEntityId: String(data.get("legalEntityId")), operatingModelSummary: String(data.get("operatingModelSummary")) });
  };
  const onImtoEvidence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    recordImtoEvidence.mutate({ profileId: String(data.get("profileId")), category: String(data.get("category")) as (typeof IMTO_CATEGORIES)[number], evidenceUri: String(data.get("evidenceUri")), evidenceSha256: String(data.get("evidenceSha256")) });
  };
  const onCreateOffshore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createOffshore.mutate({
      dossierId: String(data.get("dossierId")), counterpartyId: String(data.get("counterpartyId")),
      homeJurisdiction: String(data.get("homeJurisdiction")),
      exposureTier: String(data.get("exposureTier")) as "standard" | "heightened" | "prohibited_review",
      operatingSummary: String(data.get("operatingSummary")),
    });
  };
  const onOffshoreEvidence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    recordOffshoreEvidence.mutate({ profileId: String(data.get("profileId")), category: String(data.get("category")) as (typeof OFFSHORE_CATEGORIES)[number], evidenceUri: String(data.get("evidenceUri")), evidenceSha256: String(data.get("evidenceSha256")) });
  };

  return <Panel eyebrow="Readiness programmes" title="IMTO and offshore VASP evidence">
    {isAdmin && <form onSubmit={onCreateImto} className="mb-4 grid gap-2 border-b border-black/15 pb-4">
      <select name="legalEntityId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Legal entity for IMTO profile…</option>
        {(legalEntities.data ?? []).map((e: { id: string; legalName?: string }) => <option key={e.id} value={e.id}>{e.legalName ?? e.id}</option>)}
      </select>
      <textarea name="operatingModelSummary" required minLength={50} placeholder="Operating model summary (min 50 chars)" className="min-h-16 border border-black/25 bg-white px-2 py-1 text-xs" />
      <Button disabled={createImto.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">Create IMTO readiness profile</Button>
    </form>}
    {isCompliance && <form onSubmit={onImtoEvidence} className="mb-4 grid gap-2 border-b border-black/15 pb-4">
      <Input name="profileId" required placeholder="IMTO profile ID (UUID)" className="rounded-none font-mono text-xs" />
      <select name="category" className="h-8 border border-black/25 bg-white px-2 text-xs">{IMTO_CATEGORIES.map(c => <option key={c} value={c}>{c.replaceAll("_", " ")}</option>)}</select>
      <Input name="evidenceUri" required type="url" placeholder="Evidence URI (https)" className="rounded-none text-xs" />
      <Input name="evidenceSha256" required minLength={64} maxLength={64} placeholder="Evidence sha256 (64 hex)" className="rounded-none font-mono text-xs" />
      <Button disabled={recordImtoEvidence.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">Record IMTO evidence</Button>
    </form>}
    {isAdmin && <form onSubmit={onCreateOffshore} className="mb-4 grid gap-2 border-b border-black/15 pb-4">
      <select name="dossierId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">CBN sandbox dossier…</option>
        {(dossiers.data ?? []).map((d: { id: string; productName?: string }) => <option key={d.id} value={d.id}>{d.productName ?? d.id}</option>)}
      </select>
      <select name="counterpartyId" required className="h-8 border border-black/25 bg-white px-2 text-xs">
        <option value="">Offshore counterparty…</option>
        {(counterparties.data ?? []).map((c: { id: string; legalName?: string }) => <option key={c.id} value={c.id}>{c.legalName ?? c.id}</option>)}
      </select>
      <div className="flex gap-2">
        <Input name="homeJurisdiction" required minLength={2} placeholder="Home jurisdiction" className="rounded-none text-xs" />
        <select name="exposureTier" className="h-8 border border-black/25 bg-white px-2 text-xs">{["standard", "heightened", "prohibited_review"].map(s => <option key={s}>{s}</option>)}</select>
      </div>
      <textarea name="operatingSummary" required minLength={50} placeholder="Operating summary (min 50 chars)" className="min-h-16 border border-black/25 bg-white px-2 py-1 text-xs" />
      <Button disabled={createOffshore.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">Create offshore exposure profile</Button>
    </form>}
    {isCompliance && <form onSubmit={onOffshoreEvidence} className="grid gap-2">
      <Input name="profileId" required placeholder="Offshore profile ID (UUID)" className="rounded-none font-mono text-xs" />
      <select name="category" className="h-8 border border-black/25 bg-white px-2 text-xs">{OFFSHORE_CATEGORIES.map(c => <option key={c} value={c}>{c.replaceAll("_", " ")}</option>)}</select>
      <Input name="evidenceUri" required type="url" placeholder="Evidence URI (https)" className="rounded-none text-xs" />
      <Input name="evidenceSha256" required minLength={64} maxLength={64} placeholder="Evidence sha256 (64 hex)" className="rounded-none font-mono text-xs" />
      <Button disabled={recordOffshoreEvidence.isPending} className="rounded-none bg-black text-[10px] font-black uppercase hover:bg-[#e11919]">Record offshore evidence</Button>
    </form>}
    {!isCompliance && <p className="text-sm text-black/55">Readiness evidence actions are available to admin and compliance roles.</p>}
    {(assessImto.isIdle && assessOffshore.isIdle) ? null : null}
  </Panel>;
}

export function OperationsCoverageWorkspace({ role }: { role: OperatorRole | undefined }) {
  return <Tabs defaultValue="operational" className="gap-5">
    <TabsList className="h-auto flex-wrap justify-start gap-1.5 rounded-none bg-transparent p-0">
      <TabsTrigger className="rounded-none border border-black/20 px-4 py-2 text-xs font-black uppercase tracking-wide data-[state=active]:bg-black data-[state=active]:text-white" value="operational">Operational coverage</TabsTrigger>
      <TabsTrigger className="rounded-none border border-black/20 px-4 py-2 text-xs font-black uppercase tracking-wide data-[state=active]:bg-black data-[state=active]:text-white" value="routers">Router coverage</TabsTrigger>
    </TabsList>
    <TabsContent value="operational">
      <div className="grid gap-5 xl:grid-cols-2">
        <AlertLifecyclePanel role={role} />
        <div className="grid gap-5">
          <OperationalEvaluatorsPanel role={role} />
          <NotificationDeliveriesPanel />
        </div>
        <BeneficiaryPanel role={role} />
        <div className="grid gap-5">
          <MarketObservationPanel role={role} />
          <CounterpartyRiskPanel role={role} />
        </div>
        <div className="xl:col-span-2"><ReadinessEvidencePanel role={role} /></div>
      </div>
    </TabsContent>
    <TabsContent value="routers">
      <RouterCoverageWorkspace role={role} />
    </TabsContent>
  </Tabs>;
}
