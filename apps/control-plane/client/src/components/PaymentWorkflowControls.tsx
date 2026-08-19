import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { OperatorRole as ConsoleRole } from "@/lib/roleCapabilities";
import { FormEvent } from "react";

export type LiveRateLock = {
  id: string;
  corridor: string;
  baseAsset: string;
  quoteAsset: string;
  lockedRate: string;
  status: string;
  expiresAt: Date;
};

export type CustomerOption = { id: string; legalName: string };
export type BeneficiaryOption = { id: string; customerId: string; legalName: string; screeningState: string };

export type PaymentOrderRow = {
  id: string;
  idempotencyKey: string;
  corridor: string;
  customerLegalName: string;
  beneficiaryLegalName: string;
  sourceCurrency: string;
  sourceAmount: string;
  targetCurrency: string;
  targetAmount: string | null;
  status: string;
  providerFinalityReference: string | null;
  createdBy: string;
  createdAt: Date;
};

export type PaymentLegRow = {
  id: string;
  paymentOrderId: string;
  sequenceNumber: number;
  legKind: string;
  counterpartyLegalName: string | null;
  status: string;
  providerInstructionReference: string | null;
  providerFinalityReference: string | null;
};

/** Payment drafting and lifecycle control is a treasury and administrator action. */
export function canOperatePayments(role: ConsoleRole | undefined): boolean {
  return role === "treasury_operator" || role === "admin";
}

/** Internal states the control plane may set without any provider. */
export type InternalPaymentTransition =
  | "pending_policy_decision"
  | "blocked"
  | "manual_review"
  | "approved"
  | "cancelled";

/** Internal preparation states reachable without any provider. */
export const internalPaymentTransitions: Record<string, InternalPaymentTransition[]> = {
  draft: ["pending_policy_decision", "cancelled"],
  pending_policy_decision: ["blocked", "manual_review", "approved", "cancelled"],
  manual_review: ["blocked", "approved", "cancelled"],
  blocked: ["manual_review", "cancelled"],
  approved: ["cancelled"],
};

/** States that only an authorised provider integration can produce. */
export const providerDependentPaymentStates = ["executing", "partially_completed", "completed", "failed"] as const;

export function availablePaymentTransitions(status: string): InternalPaymentTransition[] {
  return internalPaymentTransitions[status] ?? [];
}

/**
 * A leg follows the same internal preparation lifecycle as its order, and the
 * server additionally refuses to approve a leg ahead of its order.
 */
export function availableLegTransitions(status: string): InternalPaymentTransition[] {
  return internalPaymentTransitions[status] ?? [];
}

export type CounterpartyOption = { id: string; legalName: string };

export function liveRateLocks(locks: LiveRateLock[], now: Date): LiveRateLock[] {
  return locks.filter(lock => lock.status === "locked" && new Date(lock.expiresAt) > now);
}

export function PaymentOrderForm({
  customers,
  beneficiaries,
  rateLocks,
  pending,
  submit,
  now = new Date(),
}: {
  customers: CustomerOption[];
  beneficiaries: BeneficiaryOption[];
  rateLocks: LiveRateLock[];
  pending: boolean;
  submit: (input: { idempotencyKey: string; customerId: string; beneficiaryId: string; rateLockId: string; sourceAmount: string }) => void;
  now?: Date;
}) {
  const live = liveRateLocks(rateLocks, now);
  if (!live.length || !customers.length || !beneficiaries.length) {
    return <div className="px-5 py-8 text-sm leading-6 text-black/55" data-testid="payment-draft-unavailable">
      Payment drafting requires a registered customer, a beneficiary, and a live rate lock derived from a recorded market observation. No rate is assumed, so no drafting action is offered until all three exist.
    </div>;
  }
  return <form
    className="grid gap-4 px-5 py-5"
    data-testid="payment-draft-form"
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      submit({
        idempotencyKey: String(data.get("idempotencyKey")),
        customerId: String(data.get("customerId")),
        beneficiaryId: String(data.get("beneficiaryId")),
        rateLockId: String(data.get("rateLockId")),
        sourceAmount: String(data.get("sourceAmount")),
      });
    }}
  >
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Duplicate-prevention reference</span><Input name="idempotencyKey" required minLength={8} maxLength={120} className="rounded-none border-black/25" placeholder="Caller-supplied unique instruction key" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Customer</span><Select name="customerId" defaultValue={customers[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{customers.map(customer => <SelectItem key={customer.id} value={customer.id}>{customer.legalName}</SelectItem>)}</SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Beneficiary</span><Select name="beneficiaryId" defaultValue={beneficiaries[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{beneficiaries.map(beneficiary => <SelectItem key={beneficiary.id} value={beneficiary.id}>{beneficiary.legalName} · {beneficiary.screeningState.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Live rate lock</span><Select name="rateLockId" defaultValue={live[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{live.map(lock => <SelectItem key={lock.id} value={lock.id}>{lock.baseAsset}/{lock.quoteAsset} @ {lock.lockedRate}</SelectItem>)}</SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Source amount</span><Input name="sourceAmount" required inputMode="decimal" pattern="^\d+(\.\d{1,8})?$" className="rounded-none border-black/25" placeholder="Amount in the locked base asset" /></Label>
    <p className="text-xs leading-5 text-black/55">The target amount is computed from the locked rate. Drafting creates an internal record only and contacts no payment provider.</p>
    <Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Drafting…" : "Draft payment order"}</Button>
  </form>;
}

export function PaymentOrderLedger({
  orders,
  loading,
  role,
  pending,
  transition,
}: {
  orders: PaymentOrderRow[];
  loading: boolean;
  role: ConsoleRole | undefined;
  pending: boolean;
  transition: (input: { paymentOrderId: string; status: InternalPaymentTransition; reason: string }) => void;
}) {
  if (loading) return <div className="px-5 py-8 text-sm text-black/55">Loading payment orders…</div>;
  if (!orders.length) {
    return <div className="px-5 py-8" data-testid="payment-orders-empty">
      <p className="font-bold">No payment order</p>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-black/55">Orders appear only after an operator drafts one against a live rate lock. No order, amount, or settlement state is simulated.</p>
    </div>;
  }
  const operable = canOperatePayments(role);
  return <div className="divide-y divide-black/10">{orders.map(order => {
    const transitions = availablePaymentTransitions(order.status);
    return <div className="px-5 py-4" key={order.id} data-testid={`payment-order-${order.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge className="rounded-none border-0 bg-black text-[10px] font-bold uppercase text-white">{order.status.replaceAll("_", " ")}</Badge>
          <span className="text-xs font-bold uppercase">{order.corridor.replaceAll("_", " ")}</span>
        </div>
        <span className="font-mono text-[10px] text-black/50">{order.idempotencyKey}</span>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex justify-between gap-3"><dt className="text-black/50">Customer</dt><dd>{order.customerLegalName}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Beneficiary</dt><dd>{order.beneficiaryLegalName}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Source</dt><dd className="font-mono">{order.sourceAmount} {order.sourceCurrency}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Target (derived)</dt><dd className="font-mono">{order.targetAmount ?? "—"} {order.targetCurrency}</dd></div>
      </dl>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-wide text-black/45">Drafted by {order.createdBy} · {new Date(order.createdAt).toLocaleString()}</p>
      {order.providerFinalityReference
        ? <p className="mt-2 text-xs">Provider finality reference: <span className="font-mono">{order.providerFinalityReference}</span></p>
        : <p className="mt-2 text-xs leading-5 text-black/55" data-testid={`payment-order-no-finality-${order.id}`}>No provider finality reference. Execution and settlement states are unavailable until an authorised provider integration supplies a verified reference.</p>}
      {operable && transitions.length ? <form
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto]"
        data-testid={`payment-transition-form-${order.id}`}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          transition({
            paymentOrderId: order.id,
            status: String(data.get("status")) as InternalPaymentTransition,
            reason: String(data.get("reason")),
          });
        }}
      >
        <Input name="reason" required minLength={10} maxLength={2000} className="rounded-none border-black/25" placeholder="State the control basis for this transition" />
        <Select name="status" defaultValue={transitions[0]}><SelectTrigger className="w-52 rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{transitions.map(status => <SelectItem key={status} value={status}>{status.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select>
        <Button type="submit" disabled={pending} className="rounded-none bg-black font-black uppercase tracking-wide hover:bg-[#e11919]">{pending ? "Recording…" : "Record transition"}</Button>
      </form> : null}
    </div>;
  })}</div>;
}

export function PaymentLegLedger({
  legs,
  loading,
  role,
  pending,
  transition,
}: {
  legs: PaymentLegRow[];
  loading: boolean;
  role?: ConsoleRole | undefined;
  pending?: boolean;
  transition?: (input: { paymentLegId: string; status: InternalPaymentTransition; reason: string }) => void;
}) {
  if (loading) return <div className="px-5 py-8 text-sm text-black/55">Loading payment legs…</div>;
  if (!legs.length) {
    return <div className="px-5 py-8" data-testid="payment-legs-empty">
      <p className="font-bold">No payment leg</p>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-black/55">A leg may only reference a counterparty holding a currently verified licence authorisation, so none appear until both the order and that authorisation exist.</p>
    </div>;
  }
  const operable = canOperatePayments(role) && typeof transition === "function";
  return <div className="divide-y divide-black/10">{legs.map(leg => {
    const transitions = availableLegTransitions(leg.status);
    return <div className="px-5 py-4" key={leg.id} data-testid={`payment-leg-${leg.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono text-black/50">#{leg.sequenceNumber}</span>
          <span className="font-bold uppercase">{leg.legKind}</span>
          <Badge className="rounded-none border-0 bg-black text-[10px] font-bold uppercase text-white">{leg.status.replaceAll("_", " ")}</Badge>
        </div>
        <span>{leg.counterpartyLegalName ?? "—"}</span>
      </div>
      <p className="mt-2 font-mono text-[10px] text-black/55">Provider instruction / finality: {leg.providerInstructionReference ?? "none"} / {leg.providerFinalityReference ?? "none"}</p>
      {operable && transitions.length ? <form
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto]"
        data-testid={`payment-leg-transition-form-${leg.id}`}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          transition?.({
            paymentLegId: leg.id,
            status: String(data.get("status")) as InternalPaymentTransition,
            reason: String(data.get("reason")),
          });
        }}
      >
        <Input name="reason" required minLength={10} maxLength={2000} className="rounded-none border-black/25" placeholder="State the control basis for this leg transition" />
        <Select name="status" defaultValue={transitions[0]}><SelectTrigger className="w-52 rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{transitions.map(status => <SelectItem key={status} value={status}>{status.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select>
        <Button type="submit" disabled={pending} className="rounded-none bg-black font-black uppercase tracking-wide hover:bg-[#e11919]">{pending ? "Recording…" : "Record leg transition"}</Button>
      </form> : null}
    </div>;
  })}</div>;
}

export function PaymentLegForm({
  orders,
  counterparties,
  pending,
  submit,
}: {
  orders: PaymentOrderRow[];
  counterparties: CounterpartyOption[];
  pending: boolean;
  submit: (input: { paymentOrderId: string; sequenceNumber: number; legKind: string; counterpartyId: string }) => void;
}) {
  const draftOrders = orders.filter(order => order.status === "draft");
  if (!draftOrders.length || !counterparties.length) {
    return <div className="px-5 py-8 text-sm leading-6 text-black/55" data-testid="payment-leg-form-unavailable">
      A leg requires a draft payment order and a counterparty holding a currently verified licence authorisation. No leg action is offered until both exist.
    </div>;
  }
  return <form
    className="grid gap-4 px-5 py-5"
    data-testid="payment-leg-form"
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      submit({
        paymentOrderId: String(data.get("paymentOrderId")),
        sequenceNumber: Number(data.get("sequenceNumber")),
        legKind: String(data.get("legKind")),
        counterpartyId: String(data.get("counterpartyId")),
      });
    }}
  >
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Draft payment order</span><Select name="paymentOrderId" defaultValue={draftOrders[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{draftOrders.map(order => <SelectItem key={order.id} value={order.id}>{order.idempotencyKey}</SelectItem>)}</SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Sequence number</span><Input name="sequenceNumber" type="number" min={1} max={20} required className="rounded-none border-black/25" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Leg kind</span><Input name="legKind" required minLength={3} maxLength={60} className="rounded-none border-black/25" placeholder="For example collection, fx_conversion, or payout" /></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Authorised counterparty</span><Select name="counterpartyId" defaultValue={counterparties[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{counterparties.map(counterparty => <SelectItem key={counterparty.id} value={counterparty.id}>{counterparty.legalName}</SelectItem>)}</SelectContent></Select></Label>
    <p className="text-xs leading-5 text-black/55">The server rejects any counterparty without a currently verified licence authorisation. Adding a leg instructs no provider.</p>
    <Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Adding…" : "Add payment leg"}</Button>
  </form>;
}

export function RateLockExpiryControl({
  role,
  pending,
  expire,
}: {
  role: ConsoleRole | undefined;
  pending: boolean;
  expire: () => void;
}) {
  if (!canOperatePayments(role)) {
    return <div className="px-5 py-6 text-sm leading-6 text-black/55" data-testid="rate-lock-expiry-unavailable">
      Rate-lock expiry evaluation is a treasury control. This role may review locks and their expiry evidence.
    </div>;
  }
  return <div className="grid gap-3 px-5 py-5" data-testid="rate-lock-expiry-control">
    <p className="text-xs leading-5 text-black/55">Expiry evaluation marks every elapsed lock expired and records one immutable event per lock. Repeating the evaluation changes nothing further.</p>
    <Button type="button" disabled={pending} onClick={expire} className="w-fit rounded-none bg-black font-black uppercase tracking-wide hover:bg-[#e11919]">{pending ? "Evaluating…" : "Evaluate rate-lock expiry"}</Button>
  </div>;
}
