import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormEvent, useState } from "react";
import { SubmitFeedback, useRetryableSubmit, useSubmitFeedback } from "@/components/SubmitFeedback";

export type ActiveConsent = {
  id: string;
  scope: "kyc" | "kyb";
  subjectReference: string;
  consentVersion: string;
  purpose: string;
  grantedAt: Date;
  expiresAt: Date | null;
};

export type AnalysisReadyDocument = {
  id: string;
  customerLegalName: string;
  documentType: string;
  storageUrl: string;
  mimeType: string;
  contentSha256: string;
  reviewStatus: string;
  uploadedAt: Date;
};

export type AnalysisSubmission = {
  consentId: string;
  kycDocumentId: string;
  caseKind: "kyc" | "kyb";
  documentClass: string;
  sourceSha256: string;
  sourceUri: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/tiff";
};

/**
 * Consent-backed analysis-job submission.
 *
 * Every field submitted here is taken from an existing canonical record: the
 * consent from the active-consent list, and the digest, storage URI, and MIME
 * type from the finalised upload intent. Nothing is typed in by hand, so the
 * console cannot assert a digest that was never verified. The model tag and
 * digest are deliberately absent: the server derives them from the live runtime
 * inventory, so a caller cannot claim which model produced the evidence.
 */
export function AnalysisJobSubmissionForm({
  consents,
  documents,
  canSubmit,
  pending,
  submit, error }: {
  consents: ActiveConsent[];
  documents: AnalysisReadyDocument[];
  canSubmit: boolean;
  pending: boolean;
  submit: (input: AnalysisSubmission) => void; error?: string | null }) {
  const feedback = useSubmitFeedback(pending, error);
  // Retry resends the payload that actually failed, not whatever the
  // form contains at the moment the button is pressed.
  const retryable = useRetryableSubmit(submit);
  const submitOnce = retryable.run;
  const [consentId, setConsentId] = useState<string>(consents[0]?.id ?? "");
  const [documentId, setDocumentId] = useState<string>(documents[0]?.id ?? "");

  if (!canSubmit) {
    return <div className="px-5 py-8 text-sm leading-6 text-black/55">Analysis submission is restricted to compliance officers. This view is read-only.</div>;
  }
  if (!consents.length) {
    return <div className="px-5 py-8"><p className="font-bold">No active consent</p><p className="mt-1 text-sm leading-6 text-black/55">A document is analysed only under an active, unexpired consent. Record consent first; a revoked or expired consent is never a lawful basis.</p></div>;
  }
  if (!documents.length) {
    return <div className="px-5 py-8"><p className="font-bold">No verified document</p><p className="mt-1 text-sm leading-6 text-black/55">Analysis requires a stored document whose upload was completed and whose contents were verified against their checksum. Ingest a document through protected object storage first.</p></div>;
  }

  const consent = consents.find(row => row.id === consentId) ?? consents[0];
  const document = documents.find(row => row.id === documentId) ?? documents[0];

  return <form
    className="grid gap-4 px-5 py-5"
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submitOnce({
        consentId: consent.id,
        kycDocumentId: document.id,
        caseKind: consent.scope,
        documentClass: document.documentType,
        sourceSha256: document.contentSha256,
        sourceUri: document.storageUrl,
        mimeType: document.mimeType as AnalysisSubmission["mimeType"],
      });
    }}
  >
    <p className="max-w-3xl text-xs leading-5 text-black/60">The runtime model is selected by the server from its live private inventory; it is never asserted by this console. Analysis produces review-required evidence only and never an approval or rejection.</p>
    <Label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Active consent</span>
      <Select value={consent.id} onValueChange={setConsentId}>
        <SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger>
        <SelectContent>{consents.map(row => <SelectItem key={row.id} value={row.id}>{row.scope.toUpperCase()} · {row.subjectReference} · v{row.consentVersion}</SelectItem>)}</SelectContent>
      </Select>
    </Label>
    <Label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Verified document</span>
      <Select value={document.id} onValueChange={setDocumentId}>
        <SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger>
        <SelectContent>{documents.map(row => <SelectItem key={row.id} value={row.id}>{row.customerLegalName} · {row.documentType} · {row.mimeType}</SelectItem>)}</SelectContent>
      </Select>
    </Label>
    <div className="grid gap-1 border border-black/15 bg-black/[0.02] px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Submitted provenance</p>
      <p className="break-all font-mono text-[10px] text-black/60">sha256 {document.contentSha256}</p>
      <p className="break-all font-mono text-[10px] text-black/60">{document.storageUrl}</p>
      <p className="text-[10px] text-black/50">Scope {consent.scope.toUpperCase()} · purpose recorded on consent {consent.consentVersion}</p>
    </div>
    <SubmitFeedback state={feedback} onRetry={retryable.retry} /><Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Submitting…" : "Submit for document analysis"}</Button>
  </form>;
}
