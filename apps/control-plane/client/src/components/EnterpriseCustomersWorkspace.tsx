import { FormEvent, ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PostgresCustomerOnboardingForm } from "@/components/PostgresCustomerOnboardingForm";
import { KycDocumentUploadForm } from "@/components/KycDocumentUploadControls";
import { KycDocumentReviewTable } from "@/components/KycDocumentReviewControls";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";

type DocumentType = "registration_certificate" | "identity_document" | "proof_of_address" | "beneficial_ownership" | "source_of_funds" | "other" | "ng_nin_reference" | "ng_cac_registration" | "ng_tax_identifier" | "ng_director_identity" | "ke_national_id_or_passport" | "ke_business_registration_or_cr12" | "ke_kra_pin" | "ke_beneficial_ownership" | "za_cipc_registration" | "za_sars_tax_reference" | "za_director_identity";
type Archetype = "importer" | "exporter" | "intercompany_rebalancing" | "payroll_operator";
type Tier = "smb" | "mid" | "enterprise";
type Country = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";

const archetypeLabels: Record<Archetype, string> = { importer: "Importer", exporter: "Exporter", intercompany_rebalancing: "Inter-company rebalancing", payroll_operator: "Payroll operator" };
const tierLabels: Record<Tier, string> = { smb: "SMB", mid: "Mid-market", enterprise: "Enterprise" };
const countryLabels: Record<Country, string> = { NIGERIA_NGN: "Nigeria", KENYA_KES: "Kenya", SOUTH_AFRICA_ZAR: "South Africa" };

/**
 * OM §4.4's 16-item evidence pack, verbatim. `documentType` names the one
 * kyc_document_type this platform can actually represent it with; `useCase`
 * marks the two items captured through the narrative/destination-counterparty
 * fields instead of a document. Everything else has no structural home in
 * this system and renders as "Not yet structured" rather than a fake pass.
 */
const evidencePack: Array<{ label: string; documentType?: DocumentType; useCase?: "narrative" | "invoice" }> = [
  { label: "Certificate of incorporation (or equivalent)", documentType: "registration_certificate" },
  { label: "Memorandum + Articles of Association" },
  { label: "Register of directors and shareholders (≤ 90 days old)" },
  { label: "Tax residency certificate and TIN" },
  { label: "Authorised signatory list with specimen signatures" },
  { label: "Beneficial-ownership declaration (≥ 10% threshold)", documentType: "beneficial_ownership" },
  { label: "Sanctions / PEP screening attestation" },
  { label: "Adverse media sweep (≤ 12 months)" },
  { label: "Two years of audited financial statements" },
  { label: "Trade licence or sector regulator proof" },
  { label: "Use-case narrative + destination counterparty list", useCase: "narrative" },
  { label: "Per-counterparty invoice or contract excerpt", useCase: "invoice" },
  { label: "Sample inbound payment confirmation" },
  { label: "Sample outbound payment confirmation" },
  { label: "Data-protection / privacy compliance evidence" },
  { label: "Sanctions-policy attestation by customer" },
];

const unlistedDocumentTypes: DocumentType[] = ["identity_document", "proof_of_address", "source_of_funds", "other", "ng_nin_reference", "ng_cac_registration", "ng_tax_identifier", "ng_director_identity", "ke_national_id_or_passport", "ke_business_registration_or_cr12", "ke_kra_pin", "ke_beneficial_ownership", "za_cipc_registration", "za_sars_tax_reference", "za_director_identity"];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">{label}</span>{children}</label>;
}

function relativeTime(iso: string | Date) {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

type WorkspaceData = {
  customer: { id: string; legalName: string; registrationIdentifier: string; kycStatus: string; archetype: Archetype | null; tier: Tier | null; country: Country | null; useCaseNarrative: string | null; createdAt: Date };
  destinationCounterparties: Array<{ id: string; customerId: string; counterpartyName: string; destinationJurisdiction: string; invoiceReference: string | null; createdBy: string; createdAt: Date }>;
  useCaseGateDecisions: Array<{ id: string; decision: "approved" | "blocked"; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>;
  kycDocuments: Array<{ id: string; documentType: string; storageKey: string; storageUrl: string; originalFilename: string; mimeType: string; sizeBytes: string; reviewStatus: string; reviewNote: string | null; reviewedBy: string | null; reviewedAt: Date | null; uploadedBy: string; uploadedAt: Date }>;
  linkedAnalysisJobs: Array<{ id: string; kycDocumentId: string | null; caseKind: string; documentClass: string; state: string; submittedBy: string; submittedAt: Date; completedAt: Date | null }>;
  linkedEvidence: Array<{ id: string; analysisJobId: string; kind: string; disposition: string; createdAt: Date }>;
  linkedReviewerDecisions: Array<{ id: string; analysisJobId: string; disposition: string; rationale: string; decidedBy: string; decidedAt: Date }>;
  activity: Array<{ id: string; actorSubject: string; actorRole: string; action: string; objectType: string; objectId: string; metadata: unknown; occurredAt: Date }>;
};

function OverviewTab({ workspace }: { workspace: WorkspaceData }) {
  const { customer, destinationCounterparties, useCaseGateDecisions, kycDocuments } = workspace;
  const g1 = useCaseGateDecisions[0];
  const documentedCount = evidencePack.filter(item => {
    if (item.documentType) return kycDocuments.some(document => document.documentType === item.documentType);
    if (item.useCase === "narrative") return Boolean(customer.useCaseNarrative?.trim()) && destinationCounterparties.length > 0;
    if (item.useCase === "invoice") return destinationCounterparties.some(counterparty => Boolean(counterparty.invoiceReference));
    return false;
  }).length;

  const phases = ["Legal onboarding", "Technical integration", "Pilot / go-live", "Steady-state"];

  return <div className="grid gap-5 p-5">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryStat label="Archetype" value={customer.archetype ? archetypeLabels[customer.archetype] : "Not yet structured"} />
      <SummaryStat label="Tier" value={customer.tier ? tierLabels[customer.tier] : "Not yet structured"} />
      <SummaryStat label="Country" value={customer.country ? countryLabels[customer.country] : "Not yet structured"} />
      <SummaryStat label="Created" value={new Date(customer.createdAt).toLocaleDateString()} />
      <SummaryStat label="Evidence items present" value={`${documentedCount} / ${evidencePack.length} (OM §4.4)`} />
    </div>
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">OM lifecycle phase (§1.2)</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {phases.map((phase, index) => <span key={phase} className={`border px-3 py-1.5 text-xs font-bold ${index === 0 ? "border-black bg-black text-white" : "border-black/15 bg-black/[0.03] text-black/40"}`}>{phase}{index > 0 ? " — not implemented" : ""}</span>)}
      </div>
      <p className="mt-2 max-w-2xl text-xs leading-5 text-black/55">Only Legal onboarding has any implementation in this build. Technical integration (customer API/webhook self-service), Pilot, and Steady-state recertification are named in the Stakeholder Onboarding OM but do not exist in this codebase.</p>
    </div>
    <div className="grid gap-2 border border-black/10 p-4 sm:grid-cols-2">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Gate G1 — use-case admissibility</p>
        <p className="mt-1 text-sm font-bold">{g1 ? (g1.decision === "approved" ? "Approved" : "Blocked") : "Not evaluated"}</p>
        <p className="mt-1 text-xs leading-5 text-black/55">{destinationCounterparties.length === 0 ? "No destination counterparty declared yet — required before this gate can be approved." : `${destinationCounterparties.length} destination counterpart${destinationCounterparties.length === 1 ? "y" : "ies"} on record.`}</p>
      </div>
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Gate G2 — documentation sufficiency</p>
        <p className="mt-1 text-sm font-bold">{documentedCount} / {evidencePack.length} OM items present</p>
        <p className="mt-1 text-xs leading-5 text-black/55">13 of the 16 OM-named items have no structural representation in this system, so G2 cannot be marked fully passed here — see the KYC Evidence tab.</p>
      </div>
    </div>
  </div>;
}

function CustomerInformationTab({ workspace, canEdit }: { workspace: WorkspaceData; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const { customer, destinationCounterparties } = workspace;
  const [archetype, setArchetype] = useState<Archetype | "">(customer.archetype ?? "");
  const [tier, setTier] = useState<Tier | "">(customer.tier ?? "");
  const [country, setCountry] = useState<Country | "">(customer.country ?? "");
  const invalidate = async () => { await Promise.all([utils.postgres.customerWorkspace.invalidate(), utils.postgres.customers.invalidate()]); };
  const updateProfile = trpc.postgres.updateCustomerProfile.useMutation({ onSuccess: () => { toast.success("Customer information updated."); void invalidate(); }, onError: error => toast.error(error.message) });
  const addCounterparty = trpc.postgres.recordCustomerDestinationCounterparty.useMutation({ onSuccess: () => { toast.success("Destination counterparty recorded."); void invalidate(); }, onError: error => toast.error(error.message) });

  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const narrative = String(data.get("useCaseNarrative") ?? "").trim();
    updateProfile.mutate({ customerId: customer.id, archetype: archetype || undefined, tier: tier || undefined, country: country || undefined, useCaseNarrative: narrative.length >= 20 ? narrative : undefined });
  };

  const submitCounterparty = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const counterpartyName = String(data.get("counterpartyName") ?? "").trim();
    const destinationJurisdiction = String(data.get("destinationJurisdiction") ?? "").trim();
    const invoiceReference = String(data.get("invoiceReference") ?? "").trim();
    if (!counterpartyName || !destinationJurisdiction) return;
    addCounterparty.mutate({ customerId: customer.id, counterpartyName, destinationJurisdiction, invoiceReference: invoiceReference || undefined });
    event.currentTarget.reset();
  };

  return <div className="grid gap-6 p-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Legal name (real)"><Input value={customer.legalName} disabled className="rounded-none bg-black/[0.03]" /></Field>
      <Field label="Registration identifier (real)"><Input value={customer.registrationIdentifier} disabled className="rounded-none bg-black/[0.03]" /></Field>
    </div>
    <p className="text-xs leading-5 text-black/55">Everything below is OM §4.2/§4.3 taxonomy, not yet backed by anything beyond these two fields until set here. Trading name, jurisdiction of incorporation, business address, and similar fields the OM's future KYB scope implies remain entirely unstructured — no UI is shown for them, since showing an empty form field for a column that doesn't exist would misrepresent capability.</p>
    {canEdit ? <form className="grid gap-4 border border-black/15 bg-black/[0.02] p-4" onSubmit={submitProfile}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Archetype (OM §4.2)">
          <select className="h-10 border border-black/25 bg-white px-2 text-sm" value={archetype} onChange={event => setArchetype(event.target.value as Archetype | "")}>
            <option value="">Not set</option>
            {(Object.entries(archetypeLabels) as [Archetype, string][]).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </Field>
        <Field label="Tier (OM §4.3 S1)">
          <select className="h-10 border border-black/25 bg-white px-2 text-sm" value={tier} onChange={event => setTier(event.target.value as Tier | "")}>
            <option value="">Not set</option>
            {(Object.entries(tierLabels) as [Tier, string][]).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </Field>
        <Field label="Country">
          <select className="h-10 border border-black/25 bg-white px-2 text-sm" value={country} onChange={event => setCountry(event.target.value as Country | "")}>
            <option value="">Not set</option>
            {(Object.entries(countryLabels) as [Country, string][]).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Use-case narrative (OM §4.3 S4 / evidence item 11) — required for Gate G1">
        <Textarea name="useCaseNarrative" minLength={20} maxLength={4000} defaultValue={customer.useCaseNarrative ?? ""} className="rounded-none" rows={3} placeholder="Jurisdictions, expected volume, frequency, and corridors this customer's payments will use." />
      </Field>
      <Button type="submit" disabled={updateProfile.isPending} className="rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{updateProfile.isPending ? "Saving…" : "Save customer information"}</Button>
    </form> : <p className="px-1 text-sm text-black/55">Editing customer information is a compliance action.</p>}

    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Destination counterparties (OM §4.4 items 11–12) — the evidentiary basis for Gate G1</p>
      {destinationCounterparties.length === 0 ? <p className="mt-2 text-sm text-black/55">None declared.</p> : <div className="mt-2 grid gap-2">{destinationCounterparties.map(row => <div key={row.id} className="border border-black/10 px-3 py-2 text-sm"><span className="font-bold">{row.counterpartyName}</span> · {row.destinationJurisdiction}{row.invoiceReference ? <span className="text-black/55"> · {row.invoiceReference}</span> : <span className="text-black/40"> · no invoice/contract reference on file</span>}</div>)}</div>}
      {canEdit && <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] border border-black/15 bg-black/[0.02] p-3" onSubmit={submitCounterparty}>
        <input name="counterpartyName" required placeholder="Counterparty name" className="h-9 border border-black/25 bg-white px-2 text-sm" />
        <input name="destinationJurisdiction" required placeholder="Destination jurisdiction" className="h-9 border border-black/25 bg-white px-2 text-sm" />
        <input name="invoiceReference" placeholder="Invoice / contract reference (optional)" className="h-9 border border-black/25 bg-white px-2 text-sm" />
        <Button type="submit" disabled={addCounterparty.isPending} className="rounded-none bg-black text-xs font-black uppercase hover:bg-[#e11919]">Add</Button>
      </form>}
    </div>
  </div>;
}

function EvidenceTab({ workspace, canEdit }: { workspace: WorkspaceData; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const { customer, kycDocuments, destinationCounterparties } = workspace;
  const createIntent = trpc.postgres.createKycDocumentUploadIntent.useMutation();
  const finalize = trpc.postgres.finalizeKycDocumentUpload.useMutation();
  const onUploadComplete = async () => { toast.success("KYC document stored and recorded."); await Promise.all([utils.postgres.customerWorkspace.invalidate(), utils.postgres.kycDocuments.invalidate()]); };

  return <div className="grid gap-6 p-5">
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">OM §4.4 evidence checklist</p>
      <div className="mt-2 overflow-x-auto"><table className="w-full border-collapse text-sm"><tbody>
        {evidencePack.map(item => {
          let present = false;
          if (item.documentType) present = kycDocuments.some(document => document.documentType === item.documentType);
          else if (item.useCase === "narrative") present = Boolean(customer.useCaseNarrative?.trim()) && destinationCounterparties.length > 0;
          else if (item.useCase === "invoice") present = destinationCounterparties.some(counterparty => Boolean(counterparty.invoiceReference));
          return <tr key={item.label} className="border-b border-black/10"><td className="py-2 pr-3">{item.label}</td><td className="py-2 text-right"><span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${present ? "bg-black text-white" : "bg-black/5 text-black/45"}`}>{present ? "Present" : "Not yet structured"}</span></td></tr>;
        })}
      </tbody></table></div>
      <p className="mt-2 text-xs leading-5 text-black/55">"Present" means the platform holds a real record for this item, not that a reviewer has approved it — approval is tracked separately per document in Review &amp; Decision.</p>
    </div>

    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Uploaded documents ({kycDocuments.length})</p>
      {kycDocuments.length === 0 ? <p className="mt-2 text-sm text-black/55">No documents uploaded for this customer yet.</p> : <div className="mt-2 divide-y divide-black/10">{kycDocuments.map(document => <div key={document.id} className="grid grid-cols-[1fr_auto] gap-2 py-2 text-sm"><div><p className="font-bold">{document.documentType.replaceAll("_", " ")}</p><p className="text-xs text-black/55">{document.originalFilename} · uploaded {relativeTime(document.uploadedAt)}</p></div><span className="self-center border border-black/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide">{document.reviewStatus.replaceAll("_", " ")}</span></div>)}</div>}
    </div>

    {canEdit && <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Upload evidence</p>
      <div className="mt-2 border border-black/15 bg-black/[0.02]"><KycDocumentUploadForm customers={[{ id: customer.id, legalName: customer.legalName, kycStatus: customer.kycStatus }]} createIntent={createIntent.mutateAsync} finalize={finalize.mutateAsync} onComplete={onUploadComplete} /></div>
    </div>}
  </div>;
}

function ReviewTab({ workspace, canReview }: { workspace: WorkspaceData; canReview: boolean }) {
  const utils = trpc.useUtils();
  const { customer, kycDocuments, useCaseGateDecisions, linkedAnalysisJobs, linkedReviewerDecisions } = workspace;
  const invalidate = async () => { await Promise.all([utils.postgres.customerWorkspace.invalidate(), utils.postgres.kycDocuments.invalidate()]); };
  const updateReview = trpc.postgres.updateKycDocumentReview.useMutation({ onSuccess: () => { toast.success("Document review lifecycle updated."); void invalidate(); }, onError: error => toast.error(error.message) });
  const decideGate = trpc.postgres.decideCustomerUseCaseGate.useMutation({ onSuccess: () => { toast.success("Gate G1 decision recorded."); void invalidate(); }, onError: error => toast.error(error.message) });
  const [rationale, setRationale] = useState("");

  const submitGate = (decision: "approved" | "blocked") => {
    if (rationale.trim().length < 10) { toast.error("A rationale of at least 10 characters is required."); return; }
    decideGate.mutate({ customerId: customer.id, decision, rationale: rationale.trim() });
    setRationale("");
  };

  const reviewRows = kycDocuments.map(document => ({ id: document.id, customerLegalName: customer.legalName, documentType: document.documentType, originalFilename: document.originalFilename, reviewStatus: document.reviewStatus, reviewNote: document.reviewNote, reviewedBy: document.reviewedBy, reviewedAt: document.reviewedAt, uploadedAt: document.uploadedAt }));

  return <div className="grid gap-6 p-5">
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Gate G1 — use-case admissibility (OM §4.6)</p>
      {canReview ? <div className="mt-2 grid gap-2 border border-black/15 bg-black/[0.02] p-3">
        <textarea value={rationale} onChange={event => setRationale(event.target.value)} minLength={10} placeholder="Decision rationale" className="min-h-[70px] border border-black/25 bg-white px-3 py-2 text-sm" />
        <div className="flex gap-2"><Button type="button" disabled={decideGate.isPending} onClick={() => submitGate("approved")} className="rounded-none bg-black text-xs font-black uppercase hover:bg-[#e11919]">Approve</Button><Button type="button" variant="outline" disabled={decideGate.isPending} onClick={() => submitGate("blocked")} className="rounded-none text-xs font-black uppercase">Block</Button></div>
        <p className="text-xs leading-5 text-black/55">Approval is refused unless a use-case narrative and at least one destination counterparty are on record (Customer Information tab). Owned by Compliance in this build — the OM's "Compliance + Country Lead" ownership can't be enforced since no Country Lead role exists here.</p>
      </div> : <p className="mt-2 text-sm text-black/55">Recording a gate decision is a compliance action.</p>}
      {useCaseGateDecisions.length > 0 && <div className="mt-3 grid gap-2">{useCaseGateDecisions.map(decision => <div key={decision.id} className="border border-black/10 px-3 py-2 text-sm"><span className={`font-black uppercase ${decision.decision === "approved" ? "text-black" : "text-[#e11919]"}`}>{decision.decision}</span><span className="text-black/55"> · {decision.decidedBy} · {new Date(decision.decidedAt).toLocaleString()}</span><p className="mt-1 text-black/65">{decision.rationale}</p></div>)}</div>}
    </div>

    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Per-document review (real, primary evidence path)</p>
      <div className="mt-2 border border-black/10"><KycDocumentReviewTable rows={reviewRows} loading={false} canReview={canReview} pending={updateReview.isPending} submit={updateReview.mutate} /></div>
    </div>

    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Linked automated-analysis pipeline (secondary, optional — see KYC/KYB evidence boundary)</p>
      {linkedAnalysisJobs.length === 0 ? <p className="mt-2 text-sm text-black/55">No analysis job has been linked to one of this customer's documents. This pipeline is a separate, optional path and isn't required for the primary review above.</p> : <div className="mt-2 grid gap-2">{linkedAnalysisJobs.map(job => { const decision = linkedReviewerDecisions.find(entry => entry.analysisJobId === job.id); return <div key={job.id} className="border border-black/10 px-3 py-2 text-sm"><p>{job.documentClass} · {job.state.replaceAll("_", " ")}</p>{decision && <p className="mt-1 text-xs text-black/55">Analysis-pipeline decision: {decision.disposition.replaceAll("_", " ")} · {decision.decidedBy}</p>}</div>; })}</div>}
    </div>
  </div>;
}

function ActivityTab({ workspace }: { workspace: WorkspaceData }) {
  return <div className="grid gap-5 p-5">
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Activity (reconstructed from real timestamped rows, not a first-class audit-event table)</p>
      {workspace.activity.length === 0 ? <p className="mt-2 text-sm text-black/55">No activity recorded yet.</p> : <div className="mt-2 divide-y divide-black/10">{workspace.activity.map(event => <div key={event.id} className="py-2 text-sm"><span className="font-bold">{event.action.replaceAll(/[._]/g, " ")}</span><span className="text-black/55"> · {event.actorSubject} · {new Date(event.occurredAt).toLocaleString()}</span></div>)}</div>}
    </div>
    <div className="border-t border-black/10 pt-4">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Recertification (OM §4.9)</p>
      <p className="mt-2 text-sm text-black/55">Not scheduled — no recertification calendar exists in this build. The OM specifies annual licence/beneficial-ownership refresh, quarterly adverse-media sweeps, and continuous sanctions re-screening; none of these are implemented here.</p>
    </div>
  </div>;
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return <div className="border border-black/10 p-3"><p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">{label}</p><p className="mt-1 text-sm font-bold">{value}</p></div>;
}

function CustomerWorkspacePanel({ customerId, onBack, canEdit }: { customerId: string; onBack: () => void; canEdit: boolean }) {
  const workspace = trpc.postgres.customerWorkspace.useQuery({ customerId });
  if (workspace.isLoading) return <div className="px-5 py-10 text-sm text-black/55">Loading customer workspace…</div>;
  if (!workspace.data) return <div className="px-5 py-10 text-sm text-black/55">Customer record was not found.</div>;
  const { customer } = workspace.data;
  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/20 px-5 py-4">
      <div>
        <button type="button" onClick={onBack} className="text-xs font-bold uppercase tracking-wide text-black/50 hover:text-black">← Enterprise Customers</button>
        <h3 className="mt-1 text-xl font-black tracking-[-0.03em]">{customer.legalName}</h3>
        <p className="mt-1 text-xs text-black/55">Registration {customer.registrationIdentifier}</p>
      </div>
    </div>
    <Tabs defaultValue="overview">
      <TabsList className="mx-5 mt-4 h-auto flex-wrap justify-start gap-1 rounded-none bg-transparent p-0">
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="overview">Overview</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="info">Customer Information</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="evidence">KYC Evidence</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="review">Review &amp; Decision</TabsTrigger>
        <TabsTrigger className="rounded-none border border-black/20 px-3 py-1.5 text-xs font-bold uppercase data-[state=active]:bg-black data-[state=active]:text-white" value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="overview"><OverviewTab workspace={workspace.data} /></TabsContent>
      <TabsContent value="info"><CustomerInformationTab workspace={workspace.data} canEdit={canEdit} /></TabsContent>
      <TabsContent value="evidence"><EvidenceTab workspace={workspace.data} canEdit={canEdit} /></TabsContent>
      <TabsContent value="review"><ReviewTab workspace={workspace.data} canReview={canEdit} /></TabsContent>
      <TabsContent value="activity"><ActivityTab workspace={workspace.data} /></TabsContent>
    </Tabs>
  </div>;
}

export function EnterpriseCustomersWorkspace({ role }: { role: OperatorRole | undefined }) {
  const canEdit = role === "compliance_officer" || role === "admin";
  const customers = trpc.postgres.customers.useQuery();
  const utils = trpc.useUtils();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const createCustomer = trpc.postgres.createCustomer.useMutation({
    onSuccess: async customer => { toast.success("Enterprise customer created."); setCreating(false); await utils.postgres.customers.invalidate(); setSelectedId(customer.id); },
    onError: error => toast.error(error.message),
  });

  const filtered = useMemo(() => {
    const rows = customers.data ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(row => row.legalName.toLowerCase().includes(query) || row.registrationIdentifier.toLowerCase().includes(query));
  }, [customers.data, search]);

  if (role !== "admin" && role !== "compliance_officer" && role !== "auditor" && role !== "treasury_operator") {
    return <section className="uf-panel"><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Enterprise Customers</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.045em]">Enterprise Customers</h2></div><div className="px-5 py-8 text-sm text-black/55">This role has no access to enterprise customer records.</div></section>;
  }

  if (selectedId) {
    return <section className="uf-panel min-w-0"><CustomerWorkspacePanel customerId={selectedId} onBack={() => setSelectedId(null)} canEdit={canEdit} /></section>;
  }

  return <section className="uf-panel min-w-0">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-black/20 px-5 py-4">
      <div><p className="uf-kicker">OM §4 · Enterprise Customers</p><h2 className="mt-1 text-lg font-black tracking-[-0.045em] uppercase">Enterprise Customers</h2></div>
      {canEdit && <Button onClick={() => setCreating(current => !current)} className="rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{creating ? "Cancel" : "+ New Customer"}</Button>}
    </div>
    {creating && canEdit && <div className="border-b border-black/20"><PostgresCustomerOnboardingForm pending={createCustomer.isPending} submit={createCustomer.mutate} error={createCustomer.error?.message ?? null} /></div>}
    <div className="border-b border-black/10 px-5 py-3">
      <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by legal name or registration identifier" className="h-9 max-w-md rounded-none border-black/25" aria-label="Search enterprise customers" />
    </div>
    {customers.isLoading ? <div className="px-5 py-8 text-sm text-black/55">Loading enterprise customers…</div> : filtered.length === 0 ? <div className="px-5 py-10"><p className="text-sm font-bold">No enterprise customers recorded</p><p className="mt-2 max-w-xl text-sm leading-6 text-black/55">Create the first enterprise customer record to begin its KYC/KYB evidence trail.</p></div> : <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr className="border-b border-black/20 text-left text-[10px] font-black uppercase tracking-[0.12em] text-black/50"><th className="py-2 pl-5">Legal name</th><th className="py-2">Registration ID</th><th className="py-2">Archetype</th><th className="py-2">Tier</th><th className="py-2">Country</th><th className="py-2">Evidence</th><th className="py-2">Created</th><th className="py-2 pr-5" /></tr></thead><tbody>{filtered.map(row => <tr key={row.id} className="border-b border-black/10 hover:bg-black/[0.02]"><td className="py-2 pl-5 font-bold">{row.legalName}</td><td className="py-2 text-black/65">{row.registrationIdentifier}</td><td className="py-2 text-black/65">{row.archetype ? archetypeLabels[row.archetype as Archetype] : <span className="text-black/35">Not yet structured</span>}</td><td className="py-2 text-black/65">{row.tier ? tierLabels[row.tier as Tier] : <span className="text-black/35">Not yet structured</span>}</td><td className="py-2 text-black/65">{row.country ? countryLabels[row.country as Country] : <span className="text-black/35">Not yet structured</span>}</td><td className="py-2 text-black/65">{row.documentCount === "0" ? "No documents" : `${row.approvedDocumentCount}/${row.documentCount} approved`}</td><td className="py-2 text-black/50">{new Date(row.createdAt).toLocaleDateString()}</td><td className="py-2 pr-5 text-right"><Button variant="outline" onClick={() => setSelectedId(row.id)} className="rounded-none text-[10px] font-black uppercase">Open</Button></td></tr>)}</tbody></table></div>}
    <p className="border-t border-black/10 px-5 py-3 text-[11px] leading-5 text-black/45">Additional evidence-type columns held by this system but not named in the OM's 16-item pack: {unlistedDocumentTypes.map(type => type.replaceAll("_", " ")).join(", ")}.</p>
  </section>;
}
