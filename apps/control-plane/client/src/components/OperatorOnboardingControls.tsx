import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import type { OperatorRole } from "@/lib/roleCapabilities";
import { FormEvent, useState } from "react";
import { toast } from "sonner";

const coreRoles = ["admin", "compliance_officer", "treasury_operator", "auditor"] as const;
const externalRoles = ["provider_contact", "cbn_liaison"] as const;
type GrantableRole = typeof coreRoles[number] | typeof externalRoles[number];

type Counterparty = { id: string; legalName: string; jurisdiction: string };
type Dossier = { id: string; legalEntityName: string; productName: string };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">{label}</span>{children}</label>;
}

function RoleFields({ role, onRoleChange, counterparties, dossiers }: { role: GrantableRole; onRoleChange: (role: GrantableRole) => void; counterparties: Counterparty[]; dossiers: Dossier[] }) {
  return <>
    <Field label="Operating role"><select aria-label="Operating role" className="h-10 rounded-none border border-black/25 bg-white px-2 text-sm" value={role} onChange={event => onRoleChange(event.target.value as GrantableRole)}>
      <optgroup label="Internal operator">{coreRoles.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</optgroup>
      <optgroup label="External stakeholder">{externalRoles.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</optgroup>
    </select></Field>
    {role === "provider_contact" && <Field label="Scoped counterparty"><select name="counterpartyId" aria-label="Scoped counterparty" required className="h-10 rounded-none border border-black/25 bg-white px-2 text-sm">{counterparties.map(counterparty => <option key={counterparty.id} value={counterparty.id}>{counterparty.legalName} · {counterparty.jurisdiction}</option>)}</select></Field>}
    {role === "cbn_liaison" && <Field label="Scoped CBN dossier"><select name="dossierId" aria-label="Scoped CBN dossier" required className="h-10 rounded-none border border-black/25 bg-white px-2 text-sm">{dossiers.map(dossier => <option key={dossier.id} value={dossier.id}>{dossier.legalEntityName} · {dossier.productName}</option>)}</select></Field>}
  </>;
}

function relativeTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function OnboardOperatorPanel({ counterparties, dossiers, onOnboarded }: { counterparties: Counterparty[]; dossiers: Dossier[]; onOnboarded: () => void }) {
  const available = trpc.postgres.operatorAccountCreationAvailable.useQuery();
  const [onboardRole, setOnboardRole] = useState<GrantableRole>("compliance_officer");
  const [created, setCreated] = useState<{ email: string; initialPassword: string; customerId: string } | null>(null);
  const onboard = trpc.postgres.onboardOperator.useMutation({
    onSuccess: (result, variables) => {
      toast.success("Operator account created and role granted.");
      setCreated({ email: variables.email, initialPassword: result.initialPassword, customerId: result.customerId });
      onOnboarded();
    },
    onError: error => toast.error(error.message),
  });

  if (available.data === false) {
    return <div className="border-b border-black/20 px-5 py-6 text-sm leading-6 text-black/55">Creating accounts from the console is not configured in this environment (the identity-provider admin credential is unset). Grant a role to someone who has already signed in below instead.</div>;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") || "").trim();
    const email = String(data.get("email") || "").trim();
    if (!name || !email) return;
    onboard.mutate({
      name,
      email,
      role: onboardRole,
      counterpartyId: onboardRole === "provider_contact" ? String(data.get("counterpartyId") || "") || undefined : undefined,
      dossierId: onboardRole === "cbn_liaison" ? String(data.get("dossierId") || "") || undefined : undefined,
    });
  }

  return <div className="border-b border-black/20 p-5">
    {created && <div className="mb-4 border border-[#e11919]/30 bg-[#e11919]/5 p-4 text-sm leading-6">
      <p className="font-black uppercase tracking-wide">Share this once — it is never shown again</p>
      <p className="mt-2">Account: <strong>{created.email}</strong></p>
      <p className="mt-1">Initial password: <code className="bg-white px-2 py-1 font-mono text-xs">{created.initialPassword}</code></p>
      <p className="mt-2 text-black/60">A canonical customer record was also created for KYC evidence. Open Compliance to upload and review identity documents for this person.</p>
      <Button variant="outline" className="mt-3 rounded-none text-xs font-black uppercase" onClick={() => setCreated(null)}>Dismiss</Button>
    </div>}
    <form className="grid gap-4" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name"><Input name="name" required minLength={2} className="rounded-none" /></Field>
        <Field label="Work email"><Input name="email" type="email" required className="rounded-none" /></Field>
      </div>
      <RoleFields role={onboardRole} onRoleChange={setOnboardRole} counterparties={counterparties} dossiers={dossiers} />
      <p className="text-[11px] leading-5 text-black/55">Creates the identity-provider account (email verified, no forced password reset), a linked customer record for KYC evidence, and grants the selected role in one step.</p>
      <Button type="submit" disabled={onboard.isPending} className="rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{onboard.isPending ? "Onboarding…" : "Onboard operator"}</Button>
    </form>
  </div>;
}

export function OperatorOnboardingControls({ role }: { role: OperatorRole | undefined }) {
  const utils = trpc.useUtils();
  const requests = trpc.postgres.operatorAccessRequests.useQuery();
  const counterparties = trpc.postgres.counterparties.useQuery();
  const dossiers = trpc.postgres.cbnSandboxDossiers.useQuery();
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<GrantableRole>("compliance_officer");

  const refresh = async () => { await Promise.all([utils.postgres.operatorAccessRequests.invalidate(), utils.postgres.customers.invalidate()]); };
  const close = async (message: string) => { toast.success(message); setActiveSubject(null); await refresh(); };

  const grantCore = trpc.postgres.grantOperatingRole.useMutation({ onSuccess: () => void close("Operating role granted; the person will hold it on their next request."), onError: error => toast.error(error.message) });
  const assignExternal = trpc.postgres.assignExternalStakeholder.useMutation({ onSuccess: () => void close("External stakeholder role assigned to its scoped evidence workspace."), onError: error => toast.error(error.message) });
  const pending = grantCore.isPending || assignExternal.isPending;

  if (role !== "admin") {
    return <section className="uf-panel"><div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Operator access</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.045em]">Administrator control</h2></div><p className="px-5 py-6 text-sm leading-6 text-black/55">Onboarding an operator is an administrator action. This role may see who else is waiting once an administrator is signed in.</p></section>;
  }

  function submitGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSubject) return;
    const data = new FormData(event.currentTarget);
    if (coreRoles.includes(selectedRole as typeof coreRoles[number])) {
      grantCore.mutate({ subject: activeSubject, role: selectedRole as typeof coreRoles[number] });
      return;
    }
    if (selectedRole === "provider_contact") {
      const counterpartyId = String(data.get("counterpartyId") || "");
      if (!counterpartyId) { toast.error("Select the counterparty this provider contact represents."); return; }
      assignExternal.mutate({ role: "provider_contact", stakeholderSubject: activeSubject, counterpartyId });
      return;
    }
    const dossierId = String(data.get("dossierId") || "");
    if (!dossierId) { toast.error("Select the CBN sandbox dossier this liaison represents."); return; }
    assignExternal.mutate({ role: "cbn_liaison", stakeholderSubject: activeSubject, dossierId });
  }

  return <section className="uf-panel">
    <div className="border-b border-black/20 px-5 py-4"><p className="uf-kicker">Operator access</p><h2 className="mt-1 text-lg font-black uppercase tracking-[-0.045em]">Onboard an operator</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">Create the account, start their KYC evidence trail, and grant a role in one step — or grant a role below to someone who already signed in through another path.</p></div>
    <OnboardOperatorPanel counterparties={counterparties.data ?? []} dossiers={dossiers.data ?? []} onOnboarded={() => void refresh()} />
    <div className="border-b border-black/20 px-5 py-4"><h3 className="text-sm font-black uppercase tracking-[-0.02em]">People waiting on a role</h3><p className="mt-1 max-w-3xl text-xs leading-5 text-black/55">Anyone who signs in through the identity provider without an assigned role appears here instead of being indistinguishable from an anonymous visitor.</p></div>
    {requests.isLoading ? <div className="px-5 py-8 text-sm text-black/55">Loading pending access…</div> : !requests.data?.length ? <div className="px-5 py-8"><p className="font-bold">No one is waiting</p><p className="mt-2 max-w-2xl text-sm leading-6 text-black/55">This list populates the moment a signed-in identity with no operating role reaches the console.</p></div> : <div className="divide-y divide-black/10">
      {requests.data.map(request => <div key={request.subject} className="px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-black">{request.name || "Unnamed identity"}</p>
            <p className="text-xs text-black/55">{request.email || "no email on record"}</p>
            <p className="mt-1 truncate text-[11px] text-black/40">{request.subject}</p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-black/40">First seen {relativeTime(request.firstSeenAt)} · last seen {relativeTime(request.lastSeenAt)}</p>
          </div>
          <Button variant="outline" className="rounded-none text-xs font-black uppercase" onClick={() => { setActiveSubject(activeSubject === request.subject ? null : request.subject); setSelectedRole("compliance_officer"); }}>{activeSubject === request.subject ? "Cancel" : "Grant role"}</Button>
        </div>
        {activeSubject === request.subject && <form className="mt-4 grid gap-4 border border-black/15 bg-black/[0.02] p-4" onSubmit={submitGrant}>
          <RoleFields role={selectedRole} onRoleChange={setSelectedRole} counterparties={counterparties.data ?? []} dossiers={dossiers.data ?? []} />
          <Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] text-xs font-black uppercase hover:bg-black">{pending ? "Granting…" : "Grant role"}</Button>
        </form>}
      </div>)}
    </div>}
  </section>;
}
