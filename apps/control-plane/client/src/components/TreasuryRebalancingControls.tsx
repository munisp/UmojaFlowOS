import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { OperatorRole as ConsoleRole } from "@/lib/roleCapabilities";
import { FormEvent } from "react";

export type BufferPolicy = {
  id: string;
  corridor: string;
  currency: string;
  approvedDailyOutflow: string;
  minimumBufferPct: string;
  targetBufferPct: string;
  maxRecommendationPctOfTarget: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  approvedBy: string;
};

export type TreasuryRecommendation = {
  id: string;
  corridor: string;
  currency: string;
  reconciledAvailableBalance: string;
  reconciledAt: Date;
  balanceSourceReference: string;
  verifiedNearTermFundingGap: string;
  fundingGapSourceReference: string;
  minimumBufferAmount: string;
  targetBufferAmount: string;
  computedRecommendationAmount: string;
  status: string;
  proposedBy: string;
  proposedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  expiresAt: Date;
};

/** Only treasury operators and administrators may propose a rebalancing recommendation. */
export function canProposeRebalancing(role: ConsoleRole | undefined): boolean {
  return role === "treasury_operator" || role === "admin";
}

/**
 * A decision requires the same privilege as a proposal, but the server also
 * enforces that the decider is not the proposer. The console therefore hides
 * the control on a recommendation the current operator proposed.
 */
export function canDecideRecommendation(
  role: ConsoleRole | undefined,
  recommendation: Pick<TreasuryRecommendation, "status" | "proposedBy" | "expiresAt">,
  currentSubject: string | undefined,
  now: Date,
): boolean {
  if (!canProposeRebalancing(role)) return false;
  if (recommendation.status !== "proposed") return false;
  if (new Date(recommendation.expiresAt) <= now) return false;
  return currentSubject !== undefined && recommendation.proposedBy !== currentSubject;
}

export function TreasuryBufferPolicyTable({ policies, loading }: { policies: BufferPolicy[]; loading: boolean }) {
  if (loading) return <div className="px-5 py-8 text-sm text-black/55">Loading approved buffer policies…</div>;
  if (!policies.length) {
    return <div className="px-5 py-8">
      <p className="font-bold">No approved buffer policy</p>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-black/55">A rebalancing recommendation cannot be proposed without an approved, currently effective buffer policy for the corridor. No threshold is assumed on your behalf.</p>
    </div>;
  }
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-black/20 text-[10px] uppercase tracking-wider text-black/45"><tr><th className="px-5 py-3">Corridor</th><th className="px-4 py-3">Approved daily outflow</th><th className="px-4 py-3">Minimum / target</th><th className="px-4 py-3">Recommendation cap</th><th className="px-4 py-3">Effective</th></tr></thead><tbody>{policies.map(policy => <tr className="border-b border-black/10" key={policy.id}><td className="px-5 py-3 font-bold uppercase">{policy.corridor.replaceAll("_", " ")}</td><td className="px-4 py-3">{policy.approvedDailyOutflow} {policy.currency}</td><td className="px-4 py-3">{policy.minimumBufferPct} / {policy.targetBufferPct}</td><td className="px-4 py-3">{policy.maxRecommendationPctOfTarget} of target</td><td className="px-4 py-3 text-black/55">{new Date(policy.effectiveFrom).toLocaleDateString()}{policy.effectiveTo ? ` – ${new Date(policy.effectiveTo).toLocaleDateString()}` : " – open"}</td></tr>)}</tbody></table></div>;
}

export function TreasuryRecommendationTable({
  recommendations,
  loading,
  role,
  currentSubject,
  pending,
  decide,
  now = new Date(),
}: {
  recommendations: TreasuryRecommendation[];
  loading: boolean;
  role: ConsoleRole | undefined;
  currentSubject: string | undefined;
  pending: boolean;
  decide: (input: { recommendationId: string; decision: "approved" | "rejected"; decisionReason: string }) => void;
  now?: Date;
}) {
  if (loading) return <div className="px-5 py-8 text-sm text-black/55">Loading rebalancing recommendations…</div>;
  if (!recommendations.length) {
    return <div className="px-5 py-8" data-testid="treasury-recommendations-empty">
      <p className="font-bold">No rebalancing recommendation</p>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-black/55">A recommendation appears only after a reconciled balance and a verified near-term funding gap are recorded against an approved buffer policy. No amount is computed from an assumed balance.</p>
    </div>;
  }
  return <div className="divide-y divide-black/10">{recommendations.map(item => {
    const decidable = canDecideRecommendation(role, item, currentSubject, now);
    const selfProposed = item.proposedBy === currentSubject;
    return <div className="px-5 py-4" key={item.id} data-testid={`treasury-recommendation-${item.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge className="rounded-none border-0 bg-black text-[10px] font-bold uppercase text-white">{item.status.replaceAll("_", " ")}</Badge>
          <span className="text-xs font-bold uppercase">{item.corridor.replaceAll("_", " ")} · {item.currency}</span>
        </div>
        <span className="text-[10px] text-black/50">Expires {new Date(item.expiresAt).toLocaleString()}</span>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex justify-between gap-3"><dt className="text-black/50">Reconciled available</dt><dd className="font-mono">{item.reconciledAvailableBalance}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Verified funding gap</dt><dd className="font-mono">{item.verifiedNearTermFundingGap}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Minimum buffer</dt><dd className="font-mono">{item.minimumBufferAmount}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Target buffer</dt><dd className="font-mono">{item.targetBufferAmount}</dd></div>
        <div className="flex justify-between gap-3"><dt className="font-bold">Recommended amount</dt><dd className="font-mono font-bold">{item.computedRecommendationAmount}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Balance source</dt><dd className="max-w-40 break-all text-right font-mono text-[10px]">{item.balanceSourceReference}</dd></div>
      </dl>
      <p className="mt-3 text-[10px] font-bold uppercase tracking-wide text-black/45">Proposed by {item.proposedBy} · {new Date(item.proposedAt).toLocaleString()}</p>
      {item.decidedBy ? <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-black/45">Decided by {item.decidedBy} · {item.decidedAt ? new Date(item.decidedAt).toLocaleString() : ""}{item.decisionReason ? ` · ${item.decisionReason}` : ""}</p> : null}
      <p className="mt-3 text-xs leading-5 text-black/55">A decision records an approval or rejection only. No transfer, payment, or settlement instruction is initiated by this platform.</p>
      {decidable ? <form
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto]"
        data-testid={`treasury-decision-form-${item.id}`}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          decide({
            recommendationId: item.id,
            decision: String(data.get("decision")) === "approved" ? "approved" : "rejected",
            decisionReason: String(data.get("decisionReason")),
          });
        }}
      >
        <Input name="decisionReason" required minLength={10} maxLength={2000} className="rounded-none border-black/25" placeholder="State the independent review basis" />
        <Select name="decision" defaultValue="rejected"><SelectTrigger className="w-40 rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="rejected">Reject</SelectItem><SelectItem value="approved">Approve</SelectItem></SelectContent></Select>
        <Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Recording…" : "Record decision"}</Button>
      </form> : item.status === "proposed" && selfProposed ? <p className="mt-3 text-xs font-bold" data-testid={`treasury-self-approval-blocked-${item.id}`}>Independent approval required: the proposer may not decide their own recommendation.</p> : null}
    </div>;
  })}</div>;
}

export function TreasuryRecommendationForm({
  policies,
  pending,
  submit,
}: {
  policies: BufferPolicy[];
  pending: boolean;
  submit: (input: {
    bufferPolicyId: string;
    reconciledAvailableBalance: string;
    reconciledAt: Date;
    balanceSourceReference: string;
    verifiedNearTermFundingGap: string;
    fundingGapSourceReference: string;
    expiresAt: Date;
  }) => void;
}) {
  if (!policies.length) {
    return <div className="px-5 py-8 text-sm leading-6 text-black/55" data-testid="treasury-proposal-unavailable">
      A rebalancing proposal requires an approved, effective buffer policy and reconciled balance evidence. No proposal action is available until a policy exists.
    </div>;
  }
  return <form
    className="grid gap-4 px-5 py-5"
    data-testid="treasury-proposal-form"
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      submit({
        bufferPolicyId: String(data.get("bufferPolicyId")),
        reconciledAvailableBalance: String(data.get("reconciledAvailableBalance")),
        reconciledAt: new Date(String(data.get("reconciledAt"))),
        balanceSourceReference: String(data.get("balanceSourceReference")),
        verifiedNearTermFundingGap: String(data.get("verifiedNearTermFundingGap")),
        fundingGapSourceReference: String(data.get("fundingGapSourceReference")),
        expiresAt: new Date(String(data.get("expiresAt"))),
      });
    }}
  >
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Approved buffer policy</span><Select name="bufferPolicyId" defaultValue={policies[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{policies.map(policy => <SelectItem key={policy.id} value={policy.id}>{policy.corridor.replaceAll("_", " ")} · {policy.currency}</SelectItem>)}</SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Reconciled available balance</span><Input name="reconciledAvailableBalance" required inputMode="decimal" pattern="^\d+(\.\d{1,8})?$" className="rounded-none border-black/25" placeholder="Reconciled figure from the custody or bank statement" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Reconciled as of</span><Input name="reconciledAt" type="datetime-local" required className="rounded-none border-black/25" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Balance source reference</span><Input name="balanceSourceReference" required minLength={6} className="rounded-none border-black/25" placeholder="Statement or reconciliation reference" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Verified near-term funding gap</span><Input name="verifiedNearTermFundingGap" required inputMode="decimal" pattern="^\d+(\.\d{1,8})?$" className="rounded-none border-black/25" placeholder="Verified obligation total" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Funding gap source reference</span><Input name="fundingGapSourceReference" required minLength={6} className="rounded-none border-black/25" placeholder="Obligation schedule reference" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Recommendation expiry</span><Input name="expiresAt" type="datetime-local" required className="rounded-none border-black/25" /></Label>
    <p className="text-xs leading-5 text-black/55">The amount is computed by the treasury policy engine from these reconciled inputs and is bounded by the approved cap. Submitting a proposal never moves funds.</p>
    <Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Proposing…" : "Propose rebalancing"}</Button>
  </form>;
}
