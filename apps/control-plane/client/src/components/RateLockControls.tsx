import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormEvent } from "react";
import { SubmitFeedback, useSubmitFeedback } from "@/components/SubmitFeedback";

type Corridor = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";
type ConsoleRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

export type RateLockRow = {
  id: string;
  corridor: string;
  baseAsset: string;
  quoteAsset: string;
  lockedRate: string;
  expiresAt: Date;
  status: string;
};

export type MarketObservationRow = {
  id: string;
  baseAsset: string;
  quoteAsset: string;
  rate: string;
  observedAt: Date;
};

/** Rate-lock creation and cancellation are treasury and administrator controls. */
export function canManageRateLocks(role: ConsoleRole | undefined): boolean {
  return role === "treasury_operator" || role === "admin";
}

/**
 * Only a live lock may be cancelled. An expired or already cancelled lock is
 * terminal, so no control is offered for it.
 */
export function isCancellableRateLock(row: RateLockRow, now: Date = new Date()): boolean {
  return row.status === "locked" && new Date(row.expiresAt) > now;
}

export function RateLockTable({
  rows,
  loading,
  role,
  pending = false,
  cancel,
  now = new Date(),
}: {
  rows: RateLockRow[];
  loading: boolean;
  role?: ConsoleRole | undefined;
  pending?: boolean;
  cancel?: (input: { rateLockId: string; reason: string }) => void;
  now?: Date;
}) {
  if (loading) return <p className="px-5 py-8 text-sm text-black/55">Loading source-derived rate locks.</p>;
  if (!rows.length) {
    return <p className="px-5 py-8 text-sm leading-6 text-black/55" data-testid="rate-locks-empty">
      No rate lock exists until an operator selects a recorded market observation and a future expiry. No rate is assumed.
    </p>;
  }
  const manageable = canManageRateLocks(role) && typeof cancel === "function";
  return <div className="divide-y divide-black/10">{rows.map(row => {
    const cancellable = manageable && isCancellableRateLock(row, now);
    return <div className="px-5 py-4" key={row.id} data-testid={`rate-lock-${row.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-bold">{row.baseAsset} / {row.quoteAsset}</span>
        <span className="uppercase">{row.corridor.replaceAll("_", " ")}</span>
      </div>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <div className="flex justify-between gap-3"><dt className="text-black/50">Locked rate</dt><dd className="font-mono">{row.lockedRate}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">Expires</dt><dd>{new Date(row.expiresAt).toLocaleString()}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-black/50">State</dt><dd className="font-bold uppercase">{row.status.replaceAll("_", " ")}</dd></div>
      </dl>
      {cancellable ? <form
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]"
        data-testid={`rate-lock-cancel-form-${row.id}`}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          cancel?.({ rateLockId: row.id, reason: String(data.get("reason")) });
        }}
      >
        <Input name="reason" required minLength={10} maxLength={2000} className="rounded-none border-black/25" placeholder="State why this live lock is being cancelled" />
        <Button type="submit" disabled={pending} variant="outline" className="rounded-none border-black/30 bg-white font-black uppercase tracking-wide">{pending ? "Cancelling…" : "Cancel lock"}</Button>
      </form> : null}
    </div>;
  })}</div>;
}

export function RateLockForm({
  observations,
  submit,
  pending, error }: {
  observations: MarketObservationRow[];
  submit: (input: { marketObservationId: string; corridor: Corridor; expiresAt: Date }) => void;
  pending: boolean; error?: string | null }) {
  const feedback = useSubmitFeedback(pending, error);
  if (!observations.length) {
    return <p className="px-5 py-8 text-sm leading-6 text-black/55" data-testid="rate-lock-form-unavailable">
      A recorded market observation from an active integration is required before a rate lock can be created.
    </p>;
  }
  return <form
    className="grid gap-4 p-5"
    data-testid="rate-lock-form"
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      submit({
        marketObservationId: String(data.get("marketObservationId")),
        corridor: String(data.get("corridor")) as Corridor,
        expiresAt: new Date(String(data.get("expiresAt"))),
      });
    }}
  >
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Recorded observation</span><Select name="marketObservationId" defaultValue={observations[0]?.id}><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent>{observations.map(item => <SelectItem key={item.id} value={item.id}>{item.baseAsset}/{item.quoteAsset} · {item.rate} · {new Date(item.observedAt).toLocaleString()}</SelectItem>)}</SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Corridor</span><Select name="corridor" defaultValue="NIGERIA_NGN"><SelectTrigger className="rounded-none border-black/25"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NIGERIA_NGN">Nigeria (NGN)</SelectItem><SelectItem value="KENYA_KES">Kenya (KES)</SelectItem><SelectItem value="SOUTH_AFRICA_ZAR">South Africa (ZAR)</SelectItem></SelectContent></Select></Label>
    <Label className="grid gap-1.5"><span className="text-[10px] font-black uppercase tracking-[0.14em] text-black/50">Lock expires at</span><Input name="expiresAt" type="datetime-local" required className="rounded-none border-black/25" /></Label>
    <p className="text-xs leading-5 text-black/55">The locked rate is copied from the selected observation. No rate is entered by hand.</p>
    <SubmitFeedback state={feedback} /><Button type="submit" disabled={pending} className="rounded-none bg-[#e11919] font-black uppercase tracking-wide hover:bg-black">{pending ? "Saving…" : "Create source-derived rate lock"}</Button>
  </form>;
}
