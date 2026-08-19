import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";
import { FileCheck2, Landmark, ShieldCheck, WalletCards } from "lucide-react";
import { FormEvent, useState } from "react";

type PortalTarget = "registry" | "integrations" | "governance" | "compliance" | "treasury" | "markets" | "payments" | "reports" | "sandbox";

type PortalCard = { title: string; description: string; target: PortalTarget; action: string };

const portalCards: Record<OperatorRole, { label: string; title: string; boundary: string; cards: PortalCard[] }> = {
  admin: {
    label: "Administrator portal",
    title: "Control-plane stewardship",
    boundary: "This portal can register and govern recorded controls. A secret reference, provider endpoint, or completed readiness record does not by itself activate a provider or move value.",
    cards: [
      { title: "Counterparty & entity register", description: "Maintain accountable legal entities and provider/counterparty records.", target: "registry", action: "Open registry" },
      { title: "Integration readiness", description: "Record deployment-secret references and verified health evidence without exposing secret values.", target: "integrations", action: "Open integrations" },
      { title: "Corridor governance", description: "Version CBN, CBK, and SARB policy controls for Nigeria (NGN), Kenya (KES), and South Africa (ZAR).", target: "governance", action: "Open governance" },
    ],
  },
  compliance_officer: {
    label: "Compliance officer portal",
    title: "Human evidence and decision review",
    boundary: "Evidence review is human-led and fail-closed. No portal action creates automated KYC/KYB approval, a provider activation, regulatory filing, payment execution, or settlement.",
    cards: [
      { title: "KYC/KYB and casework", description: "Review consent, authorised document evidence, cases, and reviewer dispositions.", target: "compliance", action: "Open compliance" },
      { title: "CBN sandbox evidence", description: "Review Nigeria (NGN) dossier evidence, consumer records, incidents, and internal readiness assessments.", target: "sandbox", action: "Open sandbox" },
      { title: "Reporting review", description: "Prepare controlled report records from evidence without treating preparation as submission.", target: "reports", action: "Open reports" },
    ],
  },
  treasury_operator: {
    label: "Treasury operator portal",
    title: "Liquidity and controlled-payment preparation",
    boundary: "This portal works from recorded reconciliations and observations. It cannot fund accounts, call a provider execution API, transfer value, or settle a transaction.",
    cards: [
      { title: "Reconciled liquidity", description: "Review recorded nostro, vostro, prefunding, custody, and liquidity evidence.", target: "treasury", action: "Open treasury" },
      { title: "Market evidence", description: "Inspect source-stamped NGN, KES, ZAR, USDC, and USDT observations.", target: "markets", action: "Open markets" },
      { title: "Payment preparation", description: "Draft controlled internal payment records and inspect their evidence path.", target: "payments", action: "Open payments" },
    ],
  },
  auditor: {
    label: "Auditor portal",
    title: "Read-only assurance and traceability",
    boundary: "This portal is read-only. It cannot alter controls, evidence, credentials, role assignments, compliance outcomes, payment instructions, regulatory reports, or provider state.",
    cards: [
      { title: "Control evidence", description: "Trace lifecycle and activity evidence across recorded counterparty controls.", target: "registry", action: "Inspect registry" },
      { title: "Operational posture", description: "Inspect service history, integration state, and runtime control signals.", target: "integrations", action: "Inspect controls" },
      { title: "Reports and sandbox", description: "Inspect CBN, CBK, SARB, and CBN sandbox evidence without an external-status claim.", target: "reports", action: "Inspect reports" },
    ],
  },
  provider_contact: {
    label: "Provider contact portal",
    title: "Scoped external technical-evidence exchange",
    boundary: "Only assigned counterparty evidence may be recorded. This portal cannot reveal or set a secret value, activate a provider, access an account, fund liquidity, execute payment, transfer value, or settle.",
    cards: [],
  },
  cbn_liaison: {
    label: "CBN liaison portal",
    title: "Scoped CBN sandbox correspondence record",
    boundary: "Only assigned Nigeria (NGN) dossier correspondence may be recorded. A record remains not submitted and cannot establish CBN acknowledgement, eligibility, admission, licensing, provider activation, payment execution, or settlement.",
    cards: [],
  },
};

function ExternalEvidencePortal({ role }: { role: "provider_contact" | "cbn_liaison" }) {
  const utils = trpc.useUtils();
  const assignments = role === "provider_contact"
    ? trpc.postgres.providerContactAssignments.useQuery(undefined, { enabled: true })
    : trpc.postgres.cbnLiaisonAssignments.useQuery(undefined, { enabled: true });
  const recordProvider = trpc.postgres.recordProviderContactEvidence.useMutation({ onSuccess: () => utils.postgres.providerContactAssignments.invalidate() });
  const recordCbn = trpc.postgres.recordCbnLiaisonEvidence.useMutation({ onSuccess: () => utils.postgres.cbnLiaisonAssignments.invalidate() });
  const rows = assignments.data ?? [];
  const [assignmentId, setAssignmentId] = useState("");
  const [category, setCategory] = useState(role === "provider_contact" ? "provider_licensing" : "application_correspondence");
  const [evidenceUri, setEvidenceUri] = useState("");
  const [evidenceSha256, setEvidenceSha256] = useState("");
  const pending = recordProvider.isPending || recordCbn.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (role === "provider_contact") recordProvider.mutate({ assignmentId, category: category as "provider_licensing" | "product_entitlement" | "technical_endpoint" | "callback_configuration" | "operating_runbook", evidenceUri, evidenceSha256 });
    else recordCbn.mutate({ assignmentId, category: category as "application_correspondence" | "review_request" | "review_response", evidenceUri, evidenceSha256 });
  };
  const categories = role === "provider_contact"
    ? [["provider_licensing", "Provider licensing"], ["product_entitlement", "Product entitlement"], ["technical_endpoint", "Technical endpoint"], ["callback_configuration", "Callback configuration"], ["operating_runbook", "Operating runbook"]]
    : [["application_correspondence", "Application correspondence"], ["review_request", "Review request"], ["review_response", "Review response"]];
  return <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
    <section className="uf-panel"><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Assigned evidence scope</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.04em]">Recorded assignments</h2></div>
      {assignments.isLoading ? <p className="px-5 py-7 text-sm text-black/55">Loading assigned canonical PostgreSQL records…</p> : rows.length ? <div className="divide-y divide-black/10">{rows.map((row: any) => <div className="px-5 py-4" key={row.id}><p className="text-sm font-black uppercase">{role === "provider_contact" ? row.counterpartyLegalName : row.legalEntityName}</p><p className="mt-1 text-sm text-black/60">{role === "provider_contact" ? `Onboarding stage: ${row.onboardingStage ?? "not recorded"}` : `${row.productName} · ${row.track} · dossier ${row.dossierStatus}`}</p><p className="mt-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#e11919]">Assignment status: {row.status}</p></div>)}</div> : <p className="px-5 py-7 text-sm leading-6 text-black/60">No active assignment is recorded. An administrator must assign a canonical PostgreSQL counterparty or CBN dossier before this portal accepts evidence.</p>}</section>
    <form className="uf-panel" onSubmit={submit}><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Append-only evidence</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.04em]">Record supplied reference</h2></div><div className="grid gap-4 p-5">
      <Label className="grid gap-1.5 text-[10px] font-black uppercase tracking-[0.12em]">Assignment<Select value={assignmentId} onValueChange={setAssignmentId}><SelectTrigger className="rounded-none border-black/25"><SelectValue placeholder="Select assigned record" /></SelectTrigger><SelectContent>{rows.map((row: any) => <SelectItem key={row.id} value={row.id}>{role === "provider_contact" ? row.counterpartyLegalName : row.productName}</SelectItem>)}</SelectContent></Select></Label>
      <Label className="grid gap-1.5 text-[10px] font-black uppercase tracking-[0.12em]">Evidence category<Select value={category} onValueChange={setCategory}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{categories.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Label>
      <Label className="grid gap-1.5 text-[10px] font-black uppercase tracking-[0.12em]">HTTPS evidence reference<Input required type="url" value={evidenceUri} onChange={event => setEvidenceUri(event.target.value)} placeholder="https://…" className="rounded-none border-black/25" /></Label>
      <Label className="grid gap-1.5 text-[10px] font-black uppercase tracking-[0.12em]">SHA-256 digest<Input required pattern="[a-f0-9]{64}" value={evidenceSha256} onChange={event => setEvidenceSha256(event.target.value)} placeholder="64 lowercase hex characters" className="rounded-none border-black/25 font-mono" /></Label>
      <p className="text-sm leading-6 text-black/60">The platform stores only the supplied HTTPS reference and digest. It does not receive credential values, submit to a provider or CBN, or validate any external authority.</p>
      <Button disabled={pending || !assignmentId} className="rounded-none bg-black text-xs font-black uppercase hover:bg-[#e11919]">{pending ? "Recording…" : "Record evidence"}</Button>
      {(recordProvider.error || recordCbn.error) && <p className="text-sm text-[#e11919]">{recordProvider.error?.message ?? recordCbn.error?.message}</p>}
    </div></form>
  </div>;
}

export function StakeholderPortal({ role, onNavigate }: { role: OperatorRole | undefined; onNavigate: (target: PortalTarget) => void }) {
  if (!role) return <section className="uf-panel"><div className="px-5 py-6"><p className="uf-kicker">Stakeholder portal</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.04em]">Sign in to load your role-scoped portal</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-black/60">The console does not guess stakeholder authority. A portal appears only after authenticated role resolution.</p></div></section>;
  const portal = portalCards[role];
  return <section className="uf-panel" data-testid={`stakeholder-portal-${role}`}><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">{portal.label}</p><h2 className="mt-1 text-xl font-black uppercase tracking-[-0.05em]">{portal.title}</h2><p className="mt-2 max-w-4xl text-sm leading-6 text-black/60">{portal.boundary}</p></div>
    {role === "provider_contact" || role === "cbn_liaison" ? <div className="p-5"><ExternalEvidencePortal role={role} /></div> : <div className="grid divide-y divide-black/10 md:grid-cols-3 md:divide-x md:divide-y-0">{portal.cards.map((card, index) => <div key={card.title} className="flex min-h-52 flex-col p-5"><div className="mb-5 flex h-9 w-9 items-center justify-center bg-[#e11919] text-white">{index === 0 ? <Landmark className="h-5 w-5" /> : index === 1 ? <ShieldCheck className="h-5 w-5" /> : <WalletCards className="h-5 w-5" />}</div><h3 className="text-sm font-black uppercase tracking-[-0.02em]">{card.title}</h3><p className="mt-2 flex-1 text-sm leading-6 text-black/60">{card.description}</p><Button variant="outline" onClick={() => onNavigate(card.target)} className="mt-5 w-full rounded-none border-black/25 text-xs font-black uppercase hover:border-[#e11919] hover:bg-[#e11919] hover:text-white"><FileCheck2 className="mr-2 h-4 w-4" />{card.action}</Button></div>)}</div>}
  </section>;
}
