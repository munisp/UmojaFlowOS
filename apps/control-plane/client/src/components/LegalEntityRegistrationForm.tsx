import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormEvent } from "react";
import { SubmitFeedback, useRetryableSubmit, useSubmitFeedback } from "@/components/SubmitFeedback";

const JURISDICTIONS = ["Nigeria", "Kenya", "South Africa"] as const;
type Jurisdiction = (typeof JURISDICTIONS)[number];

export function LegalEntityRegistrationForm({
  pending,
  submit,
  error,
}: {
  pending: boolean;
  submit: (input: { legalName: string; jurisdiction: Jurisdiction; registrationIdentifier: string }) => void;
  error?: string | null;
}) {
  const feedback = useSubmitFeedback(pending, error);
  const retryable = useRetryableSubmit(submit);
  const submitOnce = retryable.run;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submitOnce({
      legalName: String(data.get("legalName")).trim(),
      jurisdiction: String(data.get("jurisdiction")) as Jurisdiction,
      registrationIdentifier: String(data.get("registrationIdentifier")).trim(),
    });
  };

  return <form onSubmit={onSubmit} className="grid gap-4 p-5">
    <p className="text-xs leading-5 text-black/60">Register the official legal entity that CBN Cohort 2 dossiers, IMTO readiness profiles, and regulatory reports attach to. This creates no counterparty authorization, licence evidence, or regulatory submission by itself.</p>
    <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Legal name</span><Input name="legalName" required minLength={3} maxLength={255} className="rounded-none" /></label>
    <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Jurisdiction</span><select name="jurisdiction" required className="h-10 rounded-none border border-black/25 bg-white px-2">{JURISDICTIONS.map(j => <option key={j} value={j}>{j}</option>)}</select></label>
    <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Registration identifier</span><Input name="registrationIdentifier" required minLength={3} maxLength={128} className="rounded-none" /></label>
    <SubmitFeedback state={feedback} onRetry={retryable.retry} />
    <Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Registering…" : "Register legal entity"}</Button>
  </form>;
}
