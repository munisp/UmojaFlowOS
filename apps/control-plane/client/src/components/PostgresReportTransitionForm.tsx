import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { SubmitFeedback, useRetryableSubmit, useSubmitFeedback } from "@/components/SubmitFeedback";

type ReportRow = { id: string; regulator: string; reportType: string };
type WorkflowStatus = "under_review" | "approved" | "pending_submission" | "submitted" | "rejected";

export function PostgresReportTransitionForm({ rows, pending, submit, error }: { rows: ReportRow[]; pending: boolean; submit: (input: { reportId: string; status: WorkflowStatus; statusReason: string; artifactUri?: string; evidenceManifest?: Record<string, unknown>; submissionReference?: string }) => void; error?: string | null }) {
  const [status, setStatus] = useState<WorkflowStatus>("under_review");
  const [localError, setLocalError] = useState<string | null>(null);
  // A local parse failure and a server refusal reach the operator through the
  // same channel, so they need not know which layer rejected the submission.
  const feedback = useSubmitFeedback(pending, localError ?? error);
  // Retry resends the payload that actually failed rather than re-reading the
  // form, which the operator may have begun editing after the failure.
  const retryable = useRetryableSubmit(submit);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const raw = String(data.get("evidenceManifest") ?? "");
    let manifest: Record<string, unknown> | undefined;
    if (raw) {
      try {
        manifest = JSON.parse(raw) as Record<string, unknown>;
      } catch (parseError) {
        // The parser names the offending position, which is more useful than a
        // generic "must be valid JSON".
        setLocalError(`The evidence manifest could not be read: ${parseError instanceof Error ? parseError.message : "unknown parse error"}`);
        toast.error("The evidence manifest could not be read. Check that it is correctly formatted.");
        return;
      }
    }
    setLocalError(null);
    retryable.run({ reportId: String(data.get("reportId")), status, statusReason: String(data.get("statusReason")), artifactUri: String(data.get("artifactUri")) || undefined, evidenceManifest: manifest, submissionReference: String(data.get("submissionReference")) || undefined });
  };
  return <form className="grid gap-4 p-5" onSubmit={onSubmit}><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Regulatory report</span><select name="reportId" className="h-9 border border-black/25 bg-white px-3 text-sm">{rows.map(row => <option key={row.id} value={row.id}>{row.regulator} · {row.reportType}</option>)}</select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Workflow state</span><select value={status} onChange={event => setStatus(event.target.value as WorkflowStatus)} className="h-9 border border-black/25 bg-white px-3 text-sm">{["under_review", "approved", "pending_submission", "submitted", "rejected"].map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Reason</span><Input name="statusReason" required minLength={8} className="rounded-none" /></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Artifact URL</span><Input name="artifactUri" type="url" className="rounded-none" /></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Evidence manifest</span><Input name="evidenceManifest" className="rounded-none font-mono text-xs" /></label><label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Verified submission reference</span><Input name="submissionReference" className="rounded-none" /></label><SubmitFeedback state={feedback} onRetry={retryable.retry} /><Button disabled={pending} type="submit" className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Saving…" : "Record workflow state"}</Button></form>;
}
