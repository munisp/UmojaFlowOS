import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormEvent } from "react";

export function PostgresCustomerOnboardingForm({ pending, submit }: { pending: boolean; submit: (input: { legalName: string; registrationIdentifier: string }) => void }) {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit({ legalName: String(data.get("legalName")).trim(), registrationIdentifier: String(data.get("registrationIdentifier")).trim() });
  };

  return <form onSubmit={onSubmit} className="grid gap-4 p-5">
    <p className="text-xs leading-5 text-black/60">Create a canonical PostgreSQL customer record only from verified onboarding evidence. This creates no payment instruction and no automatic KYC/KYB disposition.</p>
    <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Legal name</span><Input name="legalName" required minLength={2} maxLength={255} className="rounded-none" /></label>
    <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Registration identifier</span><Input name="registrationIdentifier" required minLength={2} maxLength={255} className="rounded-none" /></label>
    <Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Recording…" : "Record canonical customer"}</Button>
  </form>;
}
